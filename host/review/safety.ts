/**
 * SAFETY v2 — the host's side of the owner's rules (docs/superpowers/specs/2026-09-30-safety-v2-design.md): the stored
 * state (in host settings, key `safety`), the facts the gate builds for each call, the rate ledger, the decision
 * history the preview replays, and the silent migration of the old ask-first rules.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SAFETY_LIMITS, amountOf, applyPreset, compileRule, conflictsOf, decide, defaultSafetyState, describeRule, exceptionFor, factsFromMacAction, kindOfClassRule,
  kindsCover, macAppFacts, macBrowserFacts, migrateAskRules, parseShell, type MacAppArgs, normalizeNetwork, normalizeSafety, presetCovers, presetDiff, presetOf, previewRule, scopeCovers, validateModelRule, STRICT_SOURCES,
  type ActionFacts, type ActionKind, type BotNetwork, type CompileResult, type FullAutoResult, type Guideline, type HistoryOutcome, type HistoryRecord, type PresetName,
  type RuleCtx, type RuleDecision, type RuleScope, type SafetyRule, type SafetyState,
} from "@synapse/shared";
import type { ToolCall } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { HostSettingsStore } from "../store/host-settings";
import { log } from "../util/log";
import type { Classification } from "./classify";
import { recipientsOf } from "./full-auto-intent";
import { hostsOf } from "./hard-core";
import { ruleCards } from "./rules";

const KEY = "safety";
const HOUR = 3_600_000;

/** Google tool → app. */
const GOOGLE_APP: Record<string, string> = { gmail: "gmail", calendar: "calendar", drive: "drive" };

export interface SafetyDeps {
  settings: HostSettingsStore;
  /** Where the decision history is kept (the host's private folder). Unset: memory only (tests). */
  historyFile?: string;
  /** Where the last hour of allowed actions is kept, so "at most N an hour" survives a host restart. Unset: memory only. */
  ledgerFile?: string;
  now?: () => number;
  /** The rule-compiler model, asked only when the grammar can't read a rule. Returns the v2 schema's JSON. */
  compileModel?: (text: string) => Promise<unknown>;
  /** The owner's Mac home, so "~/" in a rule means their home on Mac actions. */
  macHome?: () => string | null;
}

export class SafetyService {
  private now: () => number;
  private ledger: { at: number; facts: ActionFacts }[] = [];
  private history: HistoryRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cache: { raw: unknown; s: SafetyState } | null = null;
  private ledgerTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedUnreadable = false;

  constructor(private d: SafetyDeps) {
    this.now = d.now ?? Date.now;
    if (d.historyFile) {
      try {
        this.history = fs.readFileSync(d.historyFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryRecord).filter((r) => r && r.facts && typeof r.at === "number").slice(-SAFETY_LIMITS.historyKept);
      } catch { /* no history yet */ }
    }
    if (d.ledgerFile) {
      try {
        const cut = this.now() - HOUR;
        const saved = JSON.parse(fs.readFileSync(d.ledgerFile, "utf8")) as { at: number; facts: ActionFacts }[];
        this.ledger = (Array.isArray(saved) ? saved : []).filter((e) => e && typeof e.at === "number" && e.at > cut && e.facts && Array.isArray(e.facts.kinds)).slice(-5000);
      } catch { /* none yet */ }
    }
  }

  // ---------- state ----------

  /** The stored state; on first read with none, Balanced plus the old ask-first rules (migrated silently). */
  state(): SafetyState {
    const raw = this.d.settings.extra<unknown>(KEY, null);
    if (raw !== null && this.cache && this.cache.raw === raw) return this.cache.s; // speed: one parse per saved change, not per call
    const stored = normalizeSafety(raw);
    if (stored) { this.cache = { raw, s: stored }; return stored; }
    if (raw !== null) {
      // A stored value this build can't read is never overwritten (the owner's rules may be in it): run Careful until
      // the owner saves a change, which rewrites it.
      const careful = applyPreset(defaultSafetyState(), "careful");
      this.cache = { raw, s: careful };
      if (!this.warnedUnreadable) { this.warnedUnreadable = true; log.warn("safety: stored rules unreadable; running Careful", {}); }
      return careful;
    }
    const s = this.d.settings.get();
    const compiled = new Map(ruleCards(s).filter((c) => c.behavior === "ask").map((c) => [c.text, c]));
    const migrated = migrateAskRules(s.autoReviewInstructions.blockInstructions, (t) => {
      const c = compiled.get(t);
      return c && s.autoReviewCompiled && Object.keys(s.autoReviewCompiled).length ? { verbs: c.verbs, targets: c.targets, breadth: c.breadth } : undefined;
    }, this.now());
    const fresh = { ...defaultSafetyState(), rules: [...defaultSafetyState().rules, ...migrated] };
    try { this.d.settings.setExtra(KEY, fresh); } catch (e) { log.warn("safety: could not save the migrated rules", { error: String(e) }); }
    return fresh;
  }

  private save(next: SafetyState): SafetyState {
    const clean = normalizeSafety({ ...next, version: 2 }) ?? defaultSafetyState();
    this.d.settings.setExtra(KEY, clean, true);
    return clean;
  }

  rules(): SafetyRule[] { return this.state().rules; }
  guidelines(botId: string | null): Guideline[] {
    return this.state().guidelines.filter((g) => g.botId === null || g.botId === botId);
  }
  network(botId: string): BotNetwork | null {
    const n = this.state().networks[botId];
    return n && n.mode !== "open" ? n : null;
  }

  // ---------- facts ----------

  /**
   * One call's facts. `raw` is the Full-auto classifier's verdict with No limits off (so a mode never hides a kind).
   */
  facts(botId: string, call: ToolCall, cls: Classification, raw: FullAutoResult | null): ActionFacts {
    const t = cls.target!;
    const kinds = new Set<ActionKind>();
    const k = raw?.ask ? kindOfClassRule(raw.rule) : null;
    if (k) kinds.add(k);
    let app: string | null = null;
    if (cls.surface === "host_shell") { kinds.add("mac"); app = "mac"; }
    if (t.action === "shell") {
      kinds.add("command");
      app ??= "box";
      if (deletes(String(t.arguments.command ?? ""))) kinds.add("delete"); // inside the workspace too: a rule can name any folder
    }
    if (t.action === "write_file") { kinds.add("file-write"); app = "box"; }
    if (t.action === "browser" || call.toolName === "mcp__bot__Browser") { kinds.add("browse"); app = cls.surface === "host_shell" ? "mac" : "browser"; }
    if (t.action === "shell" && t.arguments.tool === "Mac" && (t.arguments.mac_action === "write" || t.arguments.mac_action === "edit")) kinds.add("file-write");
    if (t.action === "google_write") {
      kinds.add("app-write");
      const tool = String(t.arguments.tool ?? "");
      app = GOOGLE_APP[tool.split("_")[0] ?? ""] ?? "google";
      if (tool === "gmail_send" || tool === "calendar_create" || tool === "calendar_update") kinds.add("send");
      if (tool === "calendar_delete") kinds.add("delete");
      if (tool === "drive_upload") kinds.add("upload");
    }
    if (t.action === "composio_write") { kinds.add("app-write"); app = String(t.arguments.toolkit ?? "").toLowerCase() || "composio"; }
    if (t.action === "mcp") {
      kinds.add("app-write");
      const m = /^mcp__(.+?)__/.exec(call.toolName);
      app = m ? m[1]!.replace(/^claude_ai_/, "").toLowerCase() : "mcp";
    }
    // The Mac's app and browser tools: the same facts the Mac's own gate uses (the app, who it reaches, the site, what
    // the control says), so a rule reads them the same on both sides.
    let macExtra: ActionFacts | null = null;
    if (call.toolName === "mcp__bot__MacApp") macExtra = macAppFacts(botId, call.input as unknown as MacAppArgs);
    if (call.toolName === "mcp__bot__Browser" && typeof call.input.url === "string") macExtra = macBrowserFacts(botId, { action: String(call.input.action ?? ""), url: call.input.url, label: typeof call.input.value === "string" ? call.input.value : null, submit: call.input.submit === true });
    if (macExtra) { for (const k of macExtra.kinds) kinds.add(k); app = macExtra.app ?? app; }
    const people = t.action === "google_write" || t.action === "composio_write" || t.action === "mcp" ? recipientsOf(t).map((x) => x.toLowerCase()) : [];
    const { hosts } = hostsOf(call, cls);
    const { paths, unknown: pathsUnknown, fromCwd: pathsFromCwd } = this.pathsOf(call, cls);
    const account = typeof t.arguments.account === "string" ? t.arguments.account : null;
    const amount = amountOf(t.arguments);
    if (macExtra) { people.push(...(macExtra.people ?? [])); hosts.push(...(macExtra.domains ?? []).filter((h) => !hosts.includes(h))); }
    return { botId, kinds: [...kinds], classRule: raw?.ask ? raw.rule : null, app, account, paths, people, domains: hosts, amount, summary: cls.summary.slice(0, 160),
      ...(pathsUnknown ? { pathsUnknown: true } : {}), ...(pathsFromCwd ? { pathsFromCwd: true } : {}) };
  }

  /** The paths an action names, resolved against its working folder; flags a command whose targets can't be read. */
  private pathsOf(call: ToolCall, cls: Classification): { paths: string[]; unknown: boolean; fromCwd: boolean } {
    const t = cls.target!;
    const out = new Set<string>();
    const i = call.input;
    let unknown = false;
    for (const v of [i.file_path, i.path, i.local_path, t.arguments.path]) if (typeof v === "string" && v) out.add(v);
    if (t.action === "shell") {
      const cwd = call.cwd ?? (typeof t.arguments.working_directory === "string" && t.arguments.working_directory ? t.arguments.working_directory : typeof i.cwd === "string" ? i.cwd : null);
      const command = String(t.arguments.command ?? "");
      try {
        // Every non-flag argument of every command, resolved where that command runs (a bare `Documents` from ~ too).
        for (const c of parseShell(command, { cwd, home: "~" }).cmds) {
          const writes = WRITERS.test(c.program) || deletes(command);
          for (const w of c.argv.slice(1)) {
            const x = w.text;
            if (w.dynamic) { if (writes) unknown = true; continue; }
            if (!x || x.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(x) || x.includes("=")) continue;
            if (x === "~" || x === "~/" ) { if (writes) unknown = true; continue; }
            if (x.startsWith("/") || x.startsWith("~/")) out.add(x);
            // A bare name is a path for a program that changes files (`rm -rf Documents`); for others only when it looks like one.
            else if ((c.cwd ?? cwd) && (writes || /[/.]/.test(x))) out.add(path.resolve(c.cwd ?? cwd!, x));
          }
        }
      } catch {
        unknown = true;
      }
      if (cwd && !out.size) return { paths: [cwd], unknown, fromCwd: true };
    }
    return { paths: [...out].slice(0, 50), unknown, fromCwd: false };
  }

  // ---------- deciding ----------

  private ctx(): RuleCtx {
    return {
      now: this.now(), timeZone: this.d.settings.timeZone(),
      count: (rule, f) => this.ledger.filter((e) => e.at > this.now() - HOUR && (rule.limits?.perHour?.per === "all" || e.facts.botId === f.botId) && kindsCover(rule, e.facts)
        && scopeCovers(rule.scope, e.facts, this.home(), "any")).length,
    };
  }
  private home(): string { return this.d.macHome?.() ?? ""; }

  /** The rules the gate enforces in every mode: the owner's own (and card, migrated, strict or Never presets). */
  decideStrict(f: ActionFacts): RuleDecision | null {
    this.prune();
    return decide(this.rules(), f, this.ctx(), { sources: STRICT_SOURCES, strictPresets: true, home: this.home() });
  }

  /** Whether the preset rule for this kind still covers the action (enabled, not excepted). */
  preset(kind: ActionKind | null, f: ActionFacts): SafetyRule | null {
    if (!kind) return null;
    return presetCovers(this.rules(), kind, f, this.home());
  }

  /** An allowed action counts toward rate limits. */
  record(f: ActionFacts): void {
    this.prune();
    this.ledger.push({ at: this.now(), facts: f });
    this.saveLedgerSoon();
  }
  /** At most one write a second; a restart inside that second loses at most that second's counts. */
  private saveLedgerSoon(): void {
    const file = this.d.ledgerFile;
    if (!file || this.ledgerTimer) return;
    this.ledgerTimer = setTimeout(() => { this.ledgerTimer = null; this.flushLedger(); }, 1000);
    this.ledgerTimer.unref?.();
  }
  /** Writes the ledger now (also on shutdown and in tests). */
  flushLedger(): void {
    const file = this.d.ledgerFile;
    if (!file) return;
    this.prune();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.ledger.map((e) => ({ at: e.at, facts: { botId: e.facts.botId, kinds: e.facts.kinds, app: e.facts.app ?? null, paths: e.facts.paths ?? [], people: e.facts.people ?? [], domains: e.facts.domains ?? [] } }))), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* the counts stay in memory for this run; a later write retries */ }
  }
  private prune(): void {
    const cut = this.now() - HOUR;
    if (this.ledger.length && this.ledger[0]!.at <= cut) this.ledger = this.ledger.filter((e) => e.at > cut);
    if (this.ledger.length > 5000) this.ledger = this.ledger.slice(-5000);
  }

  /** The gate's outcome for one action, kept for the preview. */
  remember(f: ActionFacts, outcome: HistoryOutcome): void {
    this.history.push({ at: this.now(), facts: f, outcome });
    if (this.history.length > SAFETY_LIMITS.historyKept) this.history = this.history.slice(-SAFETY_LIMITS.historyKept);
    this.flushSoon();
  }
  historyRecords(): HistoryRecord[] { return [...this.history]; }
  private flushSoon(): void {
    const file = this.d.historyFile;
    if (!file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, this.history.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) { log.warn("safety: history not saved", { error: String(e) }); }
    }, 1000);
    this.flushTimer.unref?.();
  }

  // ---------- editing (Settings → Rules; only the owner's app reaches these commands) ----------

  async compile(text: string, o: { botId?: string | null; bots: { id: string; name: string }[]; macActions?: (Parameters<typeof factsFromMacAction>[0] & { at?: number })[] }): Promise<CompileResult & { preview?: ReturnType<typeof previewRule>; conflicts?: { id: string; text: string }[] }> {
    let r = compileRule(text, { bots: o.bots, botId: o.botId ?? null });
    if (!r.ok && this.d.compileModel && !/^(Write the rule first|Keep a rule under|“Always allow anything”)/.test(r.reason)) {
      try {
        const out = await this.d.compileModel(JSON.stringify({ text, bots: o.bots.map((b) => ({ id: b.id, name: b.name })) }));
        const m = validateModelRule(text, out, { bots: o.bots, botId: o.botId ?? null });
        if (m.ok) r = m;
      } catch (e) { log.warn("safety: rule compiler failed; keeping the grammar's reason", { error: String(e) }); }
    }
    if (!r.ok) return r;
    const candidate: SafetyRule = { ...r.rule, id: "candidate", source: "owner", enabled: true, createdAt: this.now() };
    // The Mac's own action log adds what ran on the Mac; one the host gate already recorded (same Bot, within 5 s) counts once.
    const seen = (v: { botId: string; at?: number }) => typeof v.at === "number" && this.history.some((h) => h.facts.botId === v.botId && h.facts.kinds.includes("mac") && Math.abs(h.at - v.at!) < 5000);
    const mac = (o.macActions ?? []).slice(0, 200).filter((v) => !seen(v)).map((v) => ({ at: typeof v.at === "number" ? v.at : this.now(), facts: factsFromMacAction(v), outcome: "allow" as HistoryOutcome }));
    const history = [...this.history, ...mac];
    const preview = previewRule(this.rules(), candidate, history, { timeZone: this.d.settings.timeZone(), home: this.home() });
    const conflicts = conflictsOf(this.rules(), candidate).map((c) => ({ id: c.id, text: c.text }));
    return { ...r, preview, conflicts };
  }

  async addRule(text: string, o: { botId?: string | null; bots: { id: string; name: string }[]; asExceptionTo?: string | null }): Promise<SafetyState> {
    const r = await this.compile(text, o);
    if (!r.ok) throw new GatewayError("RULE_NOT_EXACT", r.reason);
    const s = this.state();
    if (o.asExceptionTo) {
      // "Make it an exception to “Sends”": an Always allow the owner wrote, turned into that rule's exception.
      const target = s.rules.find((x) => x.id === o.asExceptionTo);
      if (!target) throw new GatewayError("NO_RULE", "That rule is gone. Refresh and try again.");
      return this.save({ ...s, rules: s.rules.map((x) => (x.id === target.id ? { ...x, except: [...x.except, { ...r.rule.scope, ...(r.rule.kinds.includes("any") ? {} : { kinds: r.rule.kinds }) }] } : x)) });
    }
    if (s.rules.length >= SAFETY_LIMITS.rules) throw new GatewayError("TOO_MANY_RULES", `You can have at most ${SAFETY_LIMITS.rules} rules.`);
    const rule: SafetyRule = { ...r.rule, id: `rule-${randomUUID().slice(0, 8)}`, source: "owner", enabled: true, createdAt: this.now() };
    return this.save({ ...s, rules: [...s.rules, rule] });
  }

  updateRule(id: string, patch: { enabled?: boolean; type?: SafetyRule["type"]; strict?: boolean; removeExcept?: number }): SafetyState {
    const s = this.state();
    const r = s.rules.find((x) => x.id === id);
    if (!r) throw new GatewayError("NO_RULE", "That rule is gone. Refresh and try again.");
    const next: SafetyRule = { ...r };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.type !== undefined) {
      if (!["allow", "ask", "never"].includes(patch.type)) throw new GatewayError("BAD_RULE", "A rule is Always allow, Ask first or Never.");
      if (patch.type === "allow" && next.kinds.includes("any") && Object.keys(next.scope).length === 0) throw new GatewayError("BAD_RULE", "“Always allow anything” would turn the rules off.");
      next.type = patch.type;
    }
    if (patch.strict !== undefined && r.source === "preset") next.strict = Boolean(patch.strict) || undefined;
    if (typeof patch.removeExcept === "number") next.except = next.except.filter((_, i) => i !== patch.removeExcept);
    return this.save({ ...s, rules: s.rules.map((x) => (x.id === id ? next : x)) });
  }

  deleteRule(id: string): { state: SafetyState; legacyText: string | null } {
    const s = this.state();
    const r = s.rules.find((x) => x.id === id);
    if (!r) throw new GatewayError("NO_RULE", "That rule is gone. Refresh and try again.");
    return { state: this.save({ ...s, rules: s.rules.filter((x) => x.id !== id) }), legacyText: r.source === "migrated" ? r.text : null };
  }

  setPreset(name: PresetName): SafetyState {
    return this.save(applyPreset(this.state(), name, this.now()));
  }
  presetDiff(name: PresetName) { return presetDiff(this.rules(), name); }

  /** "Always allow this" on a rule's card: this action's narrowest scope becomes that rule's exception. */
  addException(ruleId: string, f: ActionFacts): { rule: SafetyRule; scope: RuleScope } | null {
    const s = this.state();
    const r = s.rules.find((x) => x.id === ruleId);
    if (!r || r.type === "allow") return null;
    const scope = exceptionFor(f, r.kinds.includes("any") ? f.kinds : r.kinds.filter((k) => f.kinds.includes(k)));
    if (!scope) return null;
    const next = { ...r, except: [...r.except.filter((e) => JSON.stringify(e) !== JSON.stringify(scope)), scope].slice(-20) };
    this.save({ ...s, rules: s.rules.map((x) => (x.id === ruleId ? next : x)) });
    return { rule: next, scope };
  }

  setGuidelines(list: { id?: string; text: string; botId: string | null }[]): SafetyState {
    if (list.length > SAFETY_LIMITS.guidelines) throw new GatewayError("TOO_MANY", `You can have at most ${SAFETY_LIMITS.guidelines} guidelines.`);
    const guidelines = list.map((g) => {
      const text = String(g.text ?? "").trim();
      if (!text) throw new GatewayError("EMPTY", "Write the guideline first.");
      if (text.length > SAFETY_LIMITS.guidelineChars) throw new GatewayError("TOO_LONG", `Keep a guideline under ${SAFETY_LIMITS.guidelineChars} characters.`);
      return { id: g.id || `g-${randomUUID().slice(0, 8)}`, text, botId: typeof g.botId === "string" && g.botId ? g.botId : null };
    });
    return this.save({ ...this.state(), guidelines });
  }

  setNetwork(botId: string, n: BotNetwork): SafetyState {
    const net = normalizeNetwork(n);
    if (!net) throw new GatewayError("BAD_NETWORK", "Network must be Open, Only these sites or Block these sites.");
    if (net.mode === "only" && !net.hosts.length) throw new GatewayError("BAD_NETWORK", "Add at least one site, or choose Open.");
    const s = this.state();
    const networks = { ...s.networks };
    if (net.mode === "open") delete networks[botId]; else networks[botId] = net;
    return this.save({ ...s, networks });
  }

  forgetBot(botId: string): void {
    const s = this.state();
    if (!s.networks[botId] && !s.guidelines.some((g) => g.botId === botId) && !s.rules.some((r) => r.scope.bots?.includes(botId))) return;
    const networks = { ...s.networks };
    delete networks[botId];
    this.save({
      ...s, networks, guidelines: s.guidelines.filter((g) => g.botId !== botId),
      rules: s.rules.filter((r) => !(r.scope.bots?.length === 1 && r.scope.bots[0] === botId)).map((r) => (r.scope.bots?.includes(botId) ? { ...r, scope: { ...r.scope, bots: r.scope.bots.filter((b) => b !== botId) } } : r)),
    });
  }

  /** The view the app renders. */
  view(botName: (id: string) => string = (id) => id) {
    const s = this.state();
    return {
      preset: presetOf(s.rules), rules: s.rules.map((r) => ({ ...r, words: describeRule(r, botName) })), guidelines: s.guidelines, networks: s.networks,
    };
  }
}

/** Programs that change files where their arguments point. */
const WRITERS = /^(rm|rmdir|unlink|shred|trash|srm|mv|cp|rsync|dd|tee|touch|truncate|chmod|chown|ln|mkdir|install|tar|unzip|sed)$/;

/** A command that deletes files: rm, rmdir, unlink, shred, trash, find -delete, git clean, git rm. */
function deletes(command: string): boolean {
  if (!command) return false;
  try {
    return parseShell(command, { cwd: null, home: "/home/box" }).cmds.some((c) => /^(rm|rmdir|unlink|shred|trash|srm)$/.test(c.program)
      || (c.program === "find" && c.argv.some((w) => w.text === "-delete"))
      || (c.program === "git" && ["clean", "rm"].includes(c.argv[1]?.text ?? "")));
  } catch {
    return /(^|[\s;&|])(rm|rmdir|unlink|shred)\s/.test(command);
  }
}

/** The guidelines as one reminder for the Bot's turn, or null when there are none. */
export function guidelinesReminder(list: readonly Guideline[]): string | null {
  if (!list.length) return null;
  return `<system_reminder>The owner's standing guidelines (follow them unless the owner says otherwise in this chat):\n${list.map((g) => `- ${g.text.replace(/\s+/g, " ").replace(/[<>]/g, "")}`).join("\n")}</system_reminder>`;
}
