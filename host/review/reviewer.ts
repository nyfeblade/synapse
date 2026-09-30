import { LIMITS } from "@synapse/shared";
import { promptVersion } from "../prompts/index";
import type { HostSettingsStore } from "../store/host-settings";
import type { VerdictCache } from "./cache";
import { fingerprint } from "./fingerprint";
import type { CircuitBreaker } from "./circuit";
import type { ReviewLog } from "./log";
import { checkVerdict, type ModelReviewer } from "./model-reviewer";
import { EXACT_REJECT, type ExactRule, type ExactTool, exactRuleMatches, exactRuleText, parseExactRule, postValidate, trimSpaces } from "./post-validate";
import { fastPathAllowed, ruleCards } from "./rules";
import { TEXT } from "./texts";
import type { ReviewOutcome, ReviewRequest, Verdict } from "./types";

export const FLOOR_VERSION = "floor-v2"; // bug 439: the Ask floor from the Full-auto classifier

export interface ReviewerDeps {
  settings: HostSettingsStore;
  model: ModelReviewer;
  cache: VerdictCache;
  circuit: CircuitBreaker;
  log: ReviewLog;
  now?: () => number;
  timeZone(): string;
  onDegraded?(on: boolean, lastError: string | null): void;
  /** Item 9: the Bot's secret redaction, applied to the model input (enrichment included) and every log record. */
  redact?(botId: string, s: string): string;
  /** I2: the workspace; an exact rule without a cwd matches only a Shell running here. Default /workspace. */
  workspace?: string;
  /**
   * Spec §7a: whether the reviewer model may decide on its own (Claude, or a provider model with a current
   * qualification record). Not qualified = ask-only: the floor, fast path and exact rules still run; everything that
   * would reach the model becomes a card, and no verdict is cached. Absent = qualified.
   */
  qualified?(): boolean;
}

/** Bug 410: the Full-auto intent check applies only to a send on the user's accounts (what the gate asks it for). */
const INTENT_ACTIONS = new Set(["google_write", "composio_write", "mcp"]);
const intentCheck = (req: ReviewRequest): boolean => req.fullAutoIntent === true && req.surface === "mcp" && INTENT_ACTIONS.has(req.target.action);

/** Untrusted wake text can't close its own <untrusted_wake_text> fence (or open a fake one). */
const escapeTags = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trimCtx = (s: string) => (s.length <= LIMITS.reviewerContextChars ? s : `${s.slice(0, 2000)}…[context shortened for Auto-review]…${s.slice(-1900)}`);

export class Reviewer {
  private rulesVersionSeen: string;
  private now: () => number;
  private redact: (botId: string, s: string) => string;

  constructor(private d: ReviewerDeps) {
    this.now = d.now ?? Date.now;
    this.redact = d.redact ?? ((_b, s) => s);
    this.rulesVersionSeen = d.settings.rulesVersion();
  }

  get health(): "healthy" | "degraded" | "probing" {
    return this.d.circuit.state;
  }

  clearCache(): void {
    this.d.cache.clear();
  }

  /** Allow rules split into free-form ones and exact-command ones (§01.7 check 8). */
  private allowRules(): { free: { id: string; text: string }[]; exact: ExactRule[] } {
    const free: { id: string; text: string }[] = [];
    const exact: ExactRule[] = [];
    for (const c of ruleCards(this.d.settings.get())) {
      if (c.behavior !== "allow") continue;
      const e = parseExactRule(c.text);
      if (e) exact.push({ id: c.id, ...e });
      else free.push({ id: c.id, text: c.text });
    }
    return { free, exact };
  }

  private input(req: ReviewRequest): Record<string, unknown> {
    const cards = ruleCards(this.d.settings.get());
    const allow = this.allowRules();
    return {
      today: new Date(this.now()).toLocaleString("en-US", { timeZone: this.d.timeZone(), weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + ` ${this.d.timeZone()}`,
      bot: { name: req.botName, standing_instructions: req.botDescription.slice(0, 2000), ...(req.guidelines?.length ? { owner_guidelines: req.guidelines.slice(0, 20).map((g) => g.slice(0, 500)) } : {}) },
      rules: {
        ask_first: cards.filter((c) => c.behavior === "ask").map((c) => ({ id: c.id, text: c.text })),
        // Exact-command rules reach the model as data (never as rule text), so a rule's text can't carry instructions.
        allow_automatically: allow.free,
        allow_exact_commands: allow.exact,
      },
      // I2: the routine's saved instruction is the user's own; wake text from outside is fenced as data.
      origin: { kind: req.origin, ...(req.wake?.routine ? { routine: { name: req.wake.routine.name, saved_instruction: trimCtx(req.wake.routine.saved_prompt) } } : {}) },
      ...(req.wake && (req.wake.untrusted.length || req.wake.stale_user_messages.length)
        ? { wake: {
            untrusted_text: req.wake.untrusted.slice(0, 3).map((t) => `<untrusted_wake_text>\n${escapeTags(trimCtx(t))}\n</untrusted_wake_text>`),
            stale_user_messages: req.wake.stale_user_messages.slice(-2).map(trimCtx),
          } }
        : {}),
      context: {
        user_messages: req.context.user_messages.slice(-2).map(trimCtx),
        assistant_messages: req.context.assistant_messages.slice(-4).map(trimCtx),
        question_answers: req.context.question_answers.slice(-2).map(trimCtx),
        untrusted_excerpts: req.context.untrusted_excerpts.slice(0, 3).map((x) => x.slice(0, 1000)),
      },
      ...(intentCheck(req) ? { full_auto_intent_check: true } : {}),
      surface: req.surface,
      risk_target: req.target,
      static_analysis: { tier_hint: req.staticResult.tierHint, signals: req.staticResult.signals, floor_hits: req.staticResult.floorHits },
    };
  }

  async review(req: ReviewRequest): Promise<ReviewOutcome> {
    const started = this.now();
    const red = (s: string) => this.redact(req.botId, s);
    const rulesVersion = this.d.settings.rulesVersion();
    if (rulesVersion !== this.rulesVersionSeen) {
      this.d.cache.clear();
      this.rulesVersionSeen = rulesVersion;
    }
    const logIt = (stage: string, outcome: ReviewOutcome, extra: Record<string, unknown> = {}) =>
      this.d.log.write(deepRedact({ botId: req.botId, surface: req.surface, fingerprint: req.fingerprint, stage, finalVerdict: outcome.kind, latencyMs: this.now() - started, promptVersion: safeVersion(), rulesVersion, ...extra }, red));

    // S3: non-overridable floor
    if (req.staticResult.floorHits.some((f) => ["F7", "F8", "F9"].includes(f))) {
      const o: ReviewOutcome = { kind: "block", stage: "floor", reason: "This sends private data somewhere it shouldn't go or changes the app's safety settings, so it needs your OK.", proposedRule: null, verdict: null };
      logIt("floor", o);
      return o;
    }
    // S4: fast path
    if (fastPathAllowed({ surface: req.surface, staticResult: req.staticResult, paths: req.paths }, ruleCards(this.d.settings.get()))) {
      const o: ReviewOutcome = { kind: "allow", stage: "fast", verdict: null };
      logIt("fast", o);
      return o;
    }
    // S4b (Ruling 3): a stored exact-command Allow rule (§01.7 check 8) that equals this command by canonical
    // equality names the exact target, so it satisfies §01.3 and allows without a model call. Never-floors
    // (F7–F9) already returned at S3, so this can't waive one.
    const exactTool = shellTool(req);
    const ws = this.d.workspace ?? "/workspace";
    const cwd = shellCwdOf(req, ws);
    if (exactTool) {
      const command = trimSpaces(String(req.target.arguments.command ?? ""));
      if (command && this.allowRules().exact.some((r) => exactRuleMatches(r, { tool: exactTool, command, cwd }, ws))) {
        const o: ReviewOutcome = { kind: "allow", stage: "exact", verdict: null };
        logIt("exact", o);
        return o;
      }
    }
    // Bug 432: outside wake text Auto-review can't read whole (see approval-gate wakeBlock) never gets a model allow:
    // an instruction could sit past the part it sees. Fail closed, before any model call.
    if (req.wake?.unread) {
      const o: ReviewOutcome = { kind: "block", stage: "guard", reason: TEXT.wakeUnread, proposedRule: null, verdict: null };
      logIt("guard", o);
      return o;
    }
    // Spec §7a ask-only mode: an unqualified reviewer model never decides; the verdict cache is skipped too.
    if (this.d.qualified && !this.d.qualified()) {
      const o: ReviewOutcome = { kind: "degraded", reason: TEXT.reviewerUnqualified };
      logIt("model", o, { unqualified: true });
      return o;
    }
    // S5: cache
    // Lever 5 (cost-diet-2): a shell command's cache identity is its SHAPE: an output trim's count (`| tail -30` vs
    // `| tail -150`) changes what the Bot reads back, never what runs. Everything else in the target stays exact.
    const cmd = exactTool ? String(req.target.arguments.command ?? "") : "";
    const shaped = cmd && commandShape(cmd) !== cmd ? fingerprint(req.surface, { ...req.target, arguments: { ...req.target.arguments, command: commandShape(cmd) } }) : req.fingerprint;
    const key = this.d.cache.key([req.surface, shaped, cwd, rulesVersion, FLOOR_VERSION, safeVersion(), req.botId, req.origin, req.botDescription, JSON.stringify(req.wake ?? null), req.fullAutoIntent ? "full-auto-intent" : "", JSON.stringify(req.guidelines ?? [])]);
    // Bug 417: an intent check is never cached — each send is judged, and counted, on its own.
    const noCache = intentCheck(req);
    const cached = noCache ? null : this.d.cache.get(key, req.userMessageEpoch);
    if (cached) {
      const o = { ...cached, stage: "cache" } as ReviewOutcome;
      logIt("cache", o);
      return o;
    }
    // degraded mode: everything that would reach S6 becomes a card
    if (this.d.circuit.state === "degraded") {
      const o: ReviewOutcome = { kind: "degraded", reason: TEXT.degraded };
      logIt("model", o, { degraded: true });
      return o;
    }
    // S6: model
    let raw: Verdict;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LIMITS.reviewerTimeoutMs);
    try {
      raw = await this.d.model.review(deepRedact(this.input(req), red), ac.signal, req.botId);
      this.d.circuit.recordSuccess();
    } catch (e) {
      // `.state` has no setter, so TS narrows reads of it as if the value can't change across method
      // calls (it does, via recordError()/recordSuccess()); force fresh, unnarrowed reads via String()
      // (minimal TS strict-mode workaround, same spirit as the Response.json() cast rule).
      const before = String(this.d.circuit.state) as "healthy" | "degraded" | "probing";
      this.d.circuit.recordError(String((e as Error).message));
      const after = String(this.d.circuit.state) as "healthy" | "degraded" | "probing";
      if (before !== "degraded" && after === "degraded") this.d.onDegraded?.(true, this.d.circuit.lastError);
      const o: ReviewOutcome = { kind: "error", message: TEXT.reviewerError };
      logIt("model", o, { error: String(e) });
      return o;
    } finally {
      clearTimeout(timer);
    }
    // S7: post-validation
    const allow = this.allowRules();
    const tool = shellTool(req);
    let checked: ReturnType<typeof postValidate>;
    try {
      checkVerdict(raw); // every ModelReviewer, not just the SDK one
      checked = postValidate(raw, {
        floorHits: req.staticResult.floorHits, allowIds: allow.free.map((r) => r.id), redact: red, fallbackRule: exactShellRule(req, ws),
        // E14: a cited Allow rule waives a floor only if rule-coverage.ts proves it covers this target and service.
        coverage: { rules: allow.free, surface: req.surface, target: req.target, signals: req.staticResult.signals },
        exactRules: allow.exact, target: tool ? { tool, command: String(req.target.arguments.command ?? ""), cwd } : null, workspace: ws,
        // Bug 410: in Full auto's intent check the owner's own request stands in for an allow rule — for a message
        // or a publish only (F1, F2), and only on the owner's own wake. Money, deletion, access, identity, F7–F9 and
        // anything a routine, another Bot or an event woke the Bot for still need a rule or a card.
        ...(intentCheck(req) && req.origin === "user" ? { intentFloors: ["F1", "F2"] } : {}),
      });
    } catch (e) {
      // Post-validation must never be skipped: a throw (a malformed verdict, a bug) fails closed as an error.
      const o: ReviewOutcome = { kind: "error", message: TEXT.reviewerError };
      logIt("model", o, { error: `post-validation: ${String(e)}`, rawVerdict: raw });
      return o;
    }
    const { verdict, overrides } = checked;
    const o: ReviewOutcome = verdict.decision === "allow"
      ? { kind: "allow", stage: "model", verdict }
      : { kind: "block", stage: "model", reason: verdict.reason, proposedRule: verdict.proposed_allow_rule, verdict };
    if (!noCache) this.d.cache.set(key, o, verdict.risk_tier, req.userMessageEpoch);
    logIt("model", o, { rawVerdict: raw, overrides });
    return o;
  }

  /** §01.10 probe: eval case E01 as a real review. */
  async runProbe(): Promise<void> {
    if (!this.d.circuit.shouldProbe()) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LIMITS.reviewerTimeoutMs);
    try {
      await this.d.model.review({ probe: true, surface: "box_shell", risk_target: { action: "shell", arguments: { command: "ls -la /workspace/reports" } } }, ac.signal);
      this.d.circuit.recordSuccess();
      this.d.onDegraded?.(false, null);
    } catch (e) {
      this.d.circuit.recordError(String((e as Error).message));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Item 9: every string in a JSON-like value through the Bot's redaction. */
function deepRedact<T>(v: T, red: (s: string) => string): T {
  if (typeof v === "string") return red(v) as T;
  if (Array.isArray(v)) return v.map((x) => deepRedact(x, red)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x, red)])) as T;
  return v;
}

function shellTool(req: ReviewRequest): ExactTool | null {
  if (req.target.action !== "shell") return null;
  return req.surface === "host_shell" ? "ExternalShell" : req.surface === "box_shell" ? "Shell" : null;
}

/**
 * §01.7 check 8 fallback proposal: allow exactly this shell command again (narrow by construction). Only for a
 * single segment, within the length cap, and with no comment, chaining, expansion or quote characters.
 */
function exactShellRule(req: ReviewRequest, workspace: string): string | null {
  const tool = shellTool(req);
  const command = trimSpaces(String(req.target.arguments.command ?? ""));
  if (!tool || !command || command.length > LIMITS.fallbackRuleCommandMax || EXACT_REJECT.test(command) || req.staticResult.segments !== 1) return null;
  const cwd = shellCwdOf(req, workspace);
  if (cwd !== workspace && (EXACT_REJECT.test(cwd) || /[“”„‟″]/.test(cwd))) return null;
  return exactRuleText(tool, command, cwd === workspace ? null : cwd); // I2: the rule is limited to this cwd
}

/** I2: the Shell's real cwd from the review target (absent = the workspace). */
function shellCwdOf(req: ReviewRequest, workspace: string): string {
  const wd = req.target.arguments.working_directory;
  return typeof wd === "string" && wd ? wd : workspace;
}

function safeVersion(): string {
  try {
    return promptVersion("orig/reviewer.md");
  } catch {
    return "missing";
  }
}

/** Lever 5 (cost-diet-2): a shell command with every output trim's count (`| tail -N`, `| head -n N`) replaced by N. */
export function commandShape(command: string): string {
  return command.replace(/(\|\s*(?:tail|head)\s+(?:-n\s+)?-?)\d+/g, "$1N");
}
