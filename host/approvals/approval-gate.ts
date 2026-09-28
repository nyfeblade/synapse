import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LIMITS, STR, STRC, STRG, isAgentMessage, sendEntryId,
  type ApprovalCardView, type ApprovalChoice, type ApprovalStatus, type SendMessageEntry, type Surface,
} from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { PermissionDecision, PreToolDecision, ToolCall } from "../brain/types";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { describeCall } from "../presence/activity";
import { expandHome, rawShellCwd, resolveShellCwdInfo, shellHome } from "../background/shells";
import { needsCardFacts, type GoogleCardFacts } from "../google/card-facts";
import { formatDraftPreviewCard, hashDraftPreview, type DraftPreview } from "../google/tools";
import { classifyTool, insideDir, type Classification } from "../review/classify";
import { fixedRuleFor, fullAutoAskFor, modeAllowsWithoutCard, type FixedRulesEnv } from "../review/fixed-rules";
import type { PermMode } from "@synapse/shared";
import { fingerprint } from "../review/fingerprint";
import { hostCallStatic } from "../review/mac-floor";
import { isOwnershipAction } from "../review/ownership";
import { analyzeShell, SECRET_PATH, BENIGN_READ_FILES, BENIGN_READ_ROOTS, CREDENTIAL_PATH, engineeringDevCommand, enrichShell, GIT_CONTROL_PATH, gitReadTrusted, gitRootOf, SECURITY_PATH, unboundInClosedTree, type BotOwner, type DevCommandFs } from "../review/static";
import { botUserName } from "../walls/bot-uid";
import { scrubTokenShapes } from "../secrets/token-shapes";
import { HomeFsMiss, HomeSnapshot, inHome, seedOps, SnapshotFs, type FsOp, type FsQuery } from "../walls/home-fs";
import { isLean } from "../engineering/lean-profile";
import { TEXT } from "../review/texts";
import type { ReviewContext, ReviewOutcome, ReviewRequest, ReviewWake, RiskTarget, StaticResult, Verdict } from "../review/types";
import type { ExpireCause } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import type { HostSettingsStore } from "../store/host-settings";
import type { RehearsalRegistry } from "../teach/rehearsal-registry";
import { originOf } from "./origin";

export interface ReviewerLike { review(req: ReviewRequest): Promise<ReviewOutcome>; clearCache(): void }

/** A tool call raised from a child session (subagent/background shell) carries the child's own turn
 * slot, so its Auto-review card lands in the parent's transcript with the child's turn numbers and
 * TTL policy, and never touches the parent's own slot (T12's child-wiring passes this through). */
export interface GateCallCtx { slot: TurnSlot; childId: string }

export interface GateDeps {
  cfg: HostConfig;
  bots: BotService;
  settings: HostSettingsStore;
  reviewer: ReviewerLike;
  slot(botId: string): TurnSlot | null;
  flags(): ConformanceFlags;
  now?: () => number;
  readFile?: (p: string) => string | null;
  onDeferredResolution(botId: string, text: string): void;
  /** APR-07: the display's current page identity, to detect a page change between review and execution. */
  displayIdentity?(botId: string): Promise<string | null>;
  /** I2: the Bot's background-Shell cwd after its last command (null = the workspace); a child subagent has its own (item 4). */
  shellLastCwd?(botId: string, childId?: string): string | null;
  /** TCH-*: a teach rehearsal run denies anything above tier 1 instead of asking. */
  rehearsals?: RehearsalRegistry;
  /** I2: a routine's saved instruction (trusted) for the reviewer's wake block. */
  routinePrompt?(botId: string, routineId: string): string | null;
  /** P5 review I6: connector read-only trust (curated/claude.ai names; otherwise readOnlyHint + the user's trust flag). */
  mcpReadOnly?(serverId: string, tool: string): boolean;
  /** ORIG-GOOGLE: the connected Google account's address, so a Gmail draft only to the user needs no card. */
  googleEmail?(): string | null;
  /** Final secfix item 4: whether this Bot's "google" server is the built-in one (only then are mcp__google__ calls Google). */
  googleBuiltin?(botId: string): boolean;
  /** ORIG-GOOGLE draft-send card: fetches a Gmail draft's current To/Cc/Bcc/Subject/body/attachments with the
   *  user's token, host-side, before the card is raised — so the card never says just "Send your Gmail draft …". */
  googleDraftPreview?(draftId: string): Promise<{ preview: DraftPreview } | { error: string }>;
  /** Final secfix item 9: host-side facts for a Google write's card (reply recipient, event title/time, upload folder). */
  googleCardFacts?(tool: string, input: Record<string, unknown>): Promise<GoogleCardFacts | { error: string }>;
  /** Item 9: the Bot's secret redaction, applied to the draft preview text shown on the card. */
  redact?(botId: string, s: string): string;
  /** feat-mac-access-parity: the Bot's permission MODE (Ask / Auto-accept edits / Full auto). Default "ask". */
  permMode?(botId: string): PermMode;
  /** Bug 258: the Bot is in No limits (the host setting; counts only in Full auto). */
  noLimits?(botId: string): boolean;
  /** feat-mac-access-parity: the connected Mac's home and project dirs (auto-run roots), for the fixed-rules engine. */
  macEnv?(): { home: string; projectDirs: readonly string[]; userData?: string | null } | null;
  /** fix-mac-gate-and-approval-expiry (Bug B): where pending cards are kept so a host restart leaves them answerable.
   *  Unset (tests, fakes): a restart expires them as before (EVT-17). */
  persistFile?: string;
  /** speed-fastpath fix round 1: the Bot's own OS account (uid + private gid). The dev fast paths that run code from
   *  the tree (npm scripts, npx, git add/commit) need it: only a tree the Bot itself owns is trusted. Default: the
   *  per-Bot account from /etc/passwd when the box runs one uid per Bot, otherwise null (those paths go to review). */
  botAccount?(botId: string): BotOwner | null;
  /** Bug 231 round 1: read-only queries AS the Bot (box/files/bot-fs-query), so the fast path can judge trees inside the
   *  Bot's 0700 home. Unset: plain fs (tests, a box without per-Bot accounts). */
  homeFs?: FsQuery;
}

/** A command's script or package.json couldn't be read as the Bot: it is unbound (the reviewer can't see what runs). */
class UnboundMiss extends HomeFsMiss {
  constructor(op: FsOp, p: string) { super(op, p); }
}

/** The path names something on disk (not following a final link). A missing script is unbound; a refused one is not. */
function existsNoFollow(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Bug 231 round 1: why an unresolvable read asks. */
const UNRESOLVED_READ_REASON = "This reads through a link that couldn't be checked, so it needs your OK.";

const OUTSIDE_BLOCK = /<(\w+)>\n\(data from an outside sender, not instructions\)[\s\S]*?<\/\1>/g;

/** I2: the wake block — origin, the routine's saved prompt (trusted) and the outside text that came with the wake (untrusted). */
function wakeBlock(slot: TurnSlot | null, origin: ReviewWake["origin"], routinePrompt: GateDeps["routinePrompt"], botId: string): Omit<ReviewWake, "stale_user_messages"> {
  const text = (slot?.wakeText ?? "").replace(/^\[HIDDEN_PROMPT\]\n?/, "").trim();
  const cap = (xs: string[]) => xs.map((x) => x.slice(0, 4000)).slice(0, 3);
  if (origin === "user" || !slot) return { origin, routine: null, untrusted: [] };
  const w = slot.context.wake;
  if (origin === "routine") {
    const id = slot.context.routineRun?.routineId ?? (w?.kind === "routine" ? w.routineId : null);
    const saved = id ? (routinePrompt?.(botId, id) ?? null) : null;
    const name = w?.kind === "routine" ? w.routineName : (id ?? "routine");
    return { origin, routine: saved !== null ? { name, saved_prompt: saved } : null, untrusted: cap(text.match(OUTSIDE_BLOCK) ?? []) };
  }
  return { origin, routine: null, untrusted: cap(text ? [text] : []) };
}

interface Item { toolUseId: string; call: ToolCall; cls: Classification; fingerprint: string; summary: string; status: ApprovalStatus; resolve?: (d: PermissionDecision) => void }
interface ApprovalRecord {
  id: string; botId: string; surface: Surface; items: Item[]; title: string; reason: string; summary: string; command: string | null;
  proposedRule: string | null; verdict: Verdict | null; stage: string; createdAt: number; settledAt: number | null; policy: "park" | "ttl";
  status: ApprovalStatus; cause: string | null; entryId: string; requestId: string; ruleAddedText: string | null; timer?: ReturnType<typeof setTimeout>;
  /** Bug B: the turn that raised the card ended (session end, rollover, restart) while it waited. It stays pending and
   *  answerable; the answer resumes the Bot with a wake (the defer path) instead of resolving a dead tool call. */
  detached?: boolean;
  /** Bug 142: the user declined by voice with a change ("say 10 minutes"): the Bot redoes it with this. */
  note?: string;
}
interface PendingReview { outcome: Extract<ReviewOutcome, { kind: "block" | "degraded" }>; cls: Classification; fingerprint: string }

/** Bug 142: a voice decline that asks for a change tells the Bot exactly that, so it redoes the action (a new card). */
function denyText(rec: ApprovalRecord): string {
  return rec.note
    ? `The user didn't approve this as it was; they want a change: "${rec.note}". Redo the same action with exactly that change (it will ask them again). Don't do anything else.`
    : TEXT.userDeny;
}

export function truncateDetails(s: string): string {
  const max = LIMITS.cardDetailsTruncate;
  if (s.length <= max) return s;
  return `${s.slice(0, max / 2)}...[${s.length - max} chars omitted]...${s.slice(-max / 2)}`;
}

/** Ruling (b) + I1: ownership gates — standing instructions for another (or a new) Bot change only with the user's OK. */
const OWNERSHIP = new Set(["update_agent", "create_agent"]);
const readFs = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const realOrSelf = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

/** Bug 231 round 3: the most a judged read takes in (the hash pins the whole file; the reviewer sees its head). */
export const JUDGED_READ_MAX = 1024 * 1024;

/**
 * Bug 231 rounds 2-3 (B1): what the judgement may read as bothost (a script's head goes into the reviewer prompt).
 * ALLOWLIST by real path: /workspace, box's own ~/code (Bots without their own account), and the plain system folders
 * (BENIGN_READ_ROOTS / _FILES); never the host's private folder or a credential or secret file. Race-free: the file is
 * opened O_NOFOLLOW|O_NONBLOCK (a link swapped in fails, a FIFO never blocks), the open fd must be the very file that
 * was checked (same dev/ino, a regular file, one name only), on Linux its /proc/self/fd real path is checked again
 * against the same rules, and only the fd is read, capped. A refused read is null: that script is unbound (denied).
 * `afterCheck` is a test hook (the swap-race tests), called between the check and the open.
 */
export function safeReadFs(cfg: Pick<HostConfig, "workspace" | "hostPrivate"> & Partial<Pick<HostConfig, "boxHome">>, o: { afterCheck?(real: string): void; roots?: string[] } = {}): (p: string) => string | null {
  // Resolved once per reader (a missing /home/box can be an automount point: resolving it costs milliseconds).
  let fixed: { hp: string; roots: string[] } | null = null;
  const allowed = (real: string): boolean => {
    fixed ??= { hp: realOrSelf(cfg.hostPrivate), roots: [realOrSelf(cfg.workspace), ...(cfg.boxHome ? [`${realOrSelf(cfg.boxHome)}/code`] : []), ...(o.roots ?? []).map(realOrSelf)] };
    const { hp, roots } = fixed;
    if (real === hp || real.startsWith(`${hp}/`) || CREDENTIAL_PATH.test(real) || SECRET_PATH.test(` ${real}`)) return false;
    return roots.some((r) => real.startsWith(`${r}/`)) || BENIGN_READ_ROOTS.some((r) => real.startsWith(r)) || BENIGN_READ_FILES.has(real);
  };
  return (p) => {
    let real: string;
    let st: fs.Stats;
    try { real = fs.realpathSync(p); st = fs.lstatSync(real); } catch { return null; }
    if (!st.isFile() || st.nlink !== 1 || st.size > JUDGED_READ_MAX || !allowed(real)) return null;
    o.afterCheck?.(real);
    let fd: number;
    try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
    try {
      const f = fs.fstatSync(fd);
      if (!f.isFile() || f.nlink !== 1 || f.dev !== st.dev || f.ino !== st.ino || f.size > JUDGED_READ_MAX) return null;
      if (process.platform === "linux") {
        let viaFd: string;
        try { viaFd = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; }
        if (viaFd !== real || !allowed(viaFd)) return null;
      }
      const buf = Buffer.alloc(Math.min(f.size, JUDGED_READ_MAX) + 1);
      let n = 0;
      for (;;) {
        const k = fs.readSync(fd, buf, n, buf.length - n, n);
        if (k === 0) break;
        n += k;
        if (n >= buf.length) return null; // grew past what fstat said: not the file that was checked
      }
      return buf.subarray(0, n).toString("utf8");
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  };
}
const DEV_FS = (readFile: (p: string) => string | null): DevCommandFs => ({
  exists: (p) => fs.existsSync(p),
  readFile,
  realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
  list: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
  stat: (p) => { try { const st = fs.lstatSync(p); return { uid: st.uid, gid: st.gid, mode: st.mode, link: st.isSymbolicLink() }; } catch { return null; } },
});

/** speed-fastpath #5 (the user's ruling): reading stored credentials asks in every permission mode. */
const CREDENTIAL_READ_REASON = "This reads saved keys, tokens or passwords, so it needs your OK.";

/**
 * speed-fastpath #4: keys that only move focus or the caret, never type, submit, confirm or change a value. Pressed
 * alone (no chained step) on the Bot's own BOX display (mcp__computer__ tools; the user's Mac is host_shell and never
 * gets this), they are a tier-0 read for the reviewer's fast path.
 */
const UI_NAV_KEYS = new Set(["tab", "shift+tab", "home", "end"]);
function uiNavKey(target: RiskTarget): boolean {
  if (target.action !== "computer") return false;
  const a = target.arguments as { action_kind?: unknown; key?: unknown; then?: unknown; text?: unknown };
  if (a.action_kind !== "key" || typeof a.key !== "string" || (Array.isArray(a.then) && a.then.length > 0) || (a.text !== null && a.text !== undefined)) return false;
  return UI_NAV_KEYS.has(a.key.toLowerCase().replace(/[\s_-]/g, ""));
}

export class ApprovalGate {
  private reviews = new Map<string, PendingReview>();
  private records = new Map<string, ApprovalRecord>();
  private preDecided = new Map<string, { fingerprint: string; decision: PermissionDecision; cls: Classification }>();
  private deferApproved = new Set<string>();
  private settled: string[] = [];
  private now: () => number;
  private readFile: (p: string) => string | null;

  private ctxByToolUse = new Map<string, GateCallCtx>();
  /** cost-diet-2: the built-in Bash's real cwd per call, from the CLI's PreToolUse input (kept for the canUseTool leg). */
  private bashCwdByToolUse = new Map<string, string>();
  /** Bug 231 round 1: what bot-fs-query answered for each Shell/Bash call inside the Bot's home (prefetchHome). */
  private homeSnaps = new Map<string, HomeSnapshot>();
  /** Bug 231 round 3: one safeReadFs per extra root (its roots are resolved once). */
  private judgedReaders = new Map<string, (p: string) => string | null>();

  constructor(private d: GateDeps) {
    this.now = d.now ?? Date.now;
    this.readFile = d.readFile ?? readFs;
  }

  /** feat-mac-access-parity: the environment the fixed-rules engine needs (box workspace + the connected Mac). */
  private fixedEnv(): FixedRulesEnv {
    return { workspace: this.d.cfg.workspace, mac: this.d.macEnv?.() ?? null };
  }

  /** full-auto-quiet: how many ask-first rules the user has WRITTEN. In Full auto their rules still win, so a
   *  Bot only pays for the reviewer when there are some. */
  private askRules(): number {
    return this.d.settings.get().autoReviewInstructions.blockInstructions.length;
  }

  private slotFor(botId: string, toolUseId?: string): TurnSlot | null {
    const c = toolUseId ? this.ctxByToolUse.get(toolUseId) : undefined;
    return c ? c.slot : this.d.slot(botId);
  }

  /** I2: the directory a Shell call will really run in, computed now (review time and again at the TOCTOU recheck). */
  private shellCwd(botId: string, call: ToolCall): string | undefined {
    return this.shellCwdInfo(botId, call)?.path;
  }

  /** Bug 231 round 1: with `verified` false when the folder is inside the Bot's home and couldn't be resolved as the Bot
   *  (or bothost got EACCES on it): such a cwd is never trusted as its raw text. */
  private shellCwdInfo(botId: string, call: ToolCall, fsx?: DevCommandFs): { path: string; verified: boolean } | undefined {
    if (call.toolName !== "mcp__bot__Shell") return undefined;
    const childId = this.ctxByToolUse.get(call.toolUseId)?.childId;
    const home = shellHome(this.d.cfg, botId);
    const viaSnap = this.d.homeFs && this.botAccount(botId)?.home
      ? (p: string) => {
        if (!inHome(home, p)) return undefined;
        try { return (fsx ?? this.fsFor(botId, call.toolUseId)).realpath(p); } catch { return null; }
      }
      : undefined;
    return resolveShellCwdInfo(this.d.cfg.workspace, call.input.working_directory, this.d.shellLastCwd?.(botId, childId), home, viaSnap);
  }

  /** Item 4: an allowed Shell call runs in exactly the canonical cwd that was reviewed (ShellService refuses any other).
   *  For a gmail_send(draft_id) card, also carries the draft's approved-content hash through to the tool (never the
   *  model's own say-so): the tool refuses to send if the draft no longer matches it (ORIG-GOOGLE draft-send card). */
  private pinned(botId: string, call: ToolCall, cls?: Classification): Record<string, unknown> | undefined {
    const cwd = this.shellCwd(botId, call);
    const g = cls?.target;
    const draftHash = g?.action === "google_write" && g.arguments.tool === "gmail_send" && typeof g.arguments.draft_hash === "string" ? g.arguments.draft_hash : undefined;
    // Final secfix item 9: a reply goes exactly to the recipient the card showed (resolved host-side), not a re-lookup.
    const resolvedTo = g?.action === "google_write" && Array.isArray(g.arguments.resolved_to) ? (g.arguments.resolved_to as string[]) : undefined;
    if (cwd === undefined && draftHash === undefined && resolvedTo === undefined) return undefined;
    return { ...call.input, ...(cwd !== undefined ? { working_directory: cwd } : {}), ...(draftHash !== undefined ? { draft_hash: draftHash } : {}), ...(resolvedTo !== undefined ? { to: resolvedTo } : {}) };
  }

  private cls(botId: string, call: ToolCall): Classification {
    return classifyTool(call, { workspace: this.d.cfg.workspace, hostPrivate: this.d.cfg.hostPrivate, walls: this.d.cfg, enforce: this.d.settings.get().autoReviewEnabled, shellCwd: this.shellCwd(botId, call), botId, ...(this.d.mcpReadOnly ? { mcpReadOnly: this.d.mcpReadOnly } : {}), googleEmail: this.d.googleEmail?.() ?? null, googleBuiltin: this.d.googleBuiltin?.(botId) ?? false });
  }

  /** ORIG-GOOGLE draft-send card: fetches the draft, builds the card's redacted/truncated detail text and binds
   *  the classification to a hash of the draft's contents. A dependency-less host (no Google wiring) or a fetch
   *  failure both deny with a clear reason — never a card built on nothing. */
  private async enrichDraftSend(botId: string, draftId: string, cls: Classification): Promise<Classification | string> {
    if (!this.d.googleDraftPreview) return STRG.draftFetchFailed("Google isn't connected.");
    const r = await this.d.googleDraftPreview(draftId);
    if ("error" in r) return STRG.draftFetchFailed(r.error);
    const hash = hashDraftPreview(r.preview);
    const command = `${formatDraftPreviewCard(r.preview)}\nDraft hash: ${hash.slice(0, 12)}`;
    const target = { ...cls.target!, arguments: { ...cls.target!.arguments, draft_hash: hash } };
    return { ...cls, command: this.d.redact ? this.d.redact(botId, command) : command, target };
  }

  /** Controller ruling (a): a direct gmail_send (to/subject/body) gets the same enriched card as a draft send —
   *  recipients, subject, a body snippet and a hash of that content (part of the fingerprint, so any change is a TOCTOU deny). */
  private enrichDirectSend(botId: string, cls: Classification): Classification {
    const a = cls.target!.arguments;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const body = str(a.body);
    const preview: DraftPreview = { to: Array.isArray(a.to) ? a.to.map(String).join(", ") : str(a.to), cc: "", bcc: "", subject: str(a.subject), bodyPreview: body.length > 200 ? `${body.slice(0, 200)}…` : body, attachmentCount: 0, body, attachmentIds: [] };
    const hash = hashDraftPreview(preview);
    const command = `${formatDraftPreviewCard(preview)}\nContent hash: ${hash.slice(0, 12)}`;
    return { ...cls, command: this.d.redact ? this.d.redact(botId, command) : command, target: { ...cls.target!, arguments: { ...a, content_hash: hash } } };
  }

  /** Final secfix item 9: every Google write's card is built from host-side facts; then gmail_send gets its content hash. */
  private async enrichGoogle(botId: string, call: ToolCall, cls: Classification): Promise<Classification | string> {
    let c = cls;
    const tool = String(c.target!.arguments.tool ?? "");
    if (needsCardFacts(tool, call.input)) {
      if (!this.d.googleCardFacts) return STRG.cardFactsFailed("Google isn't connected.");
      const r = await this.d.googleCardFacts(tool, call.input);
      if ("error" in r) return STRG.cardFactsFailed(r.error);
      if (r.resolvedTo) {
        const re = this.cls(botId, { ...call, input: { ...call.input, to: r.resolvedTo } });
        const base = re.target ? re : c;
        c = { ...base, target: { ...base.target!, arguments: { ...base.target!.arguments, to: r.resolvedTo, resolved_to: r.resolvedTo } } };
      }
      const facts = r.lines.join("\n");
      const command = `${facts}\n\n${c.command ?? ""}`;
      c = { ...c, summary: r.summary ?? c.summary, command: this.d.redact ? this.d.redact(botId, command) : command, target: { ...c.target!, arguments: { ...c.target!.arguments, card_facts: facts } } };
    }
    return tool === "gmail_send" ? this.enrichSend(botId, c) : c;
  }

  /** Final secfix item 1: one enrichment for every gmail_send (draft or direct), used by the card, the pin and the recheck. */
  private async enrichSend(botId: string, cls: Classification): Promise<Classification | string> {
    const id = cls.target!.arguments.draft_id;
    return typeof id === "string" ? this.enrichDraftSend(botId, id, cls) : this.enrichDirectSend(botId, cls);
  }

  /** Controller ruling (a) + final secfix 9: every Google write is its own (enriched) card — never batched with siblings. */
  private static unbatchable(cls: Classification): boolean {
    return cls.target?.action === "google_write";
  }

  pendingCount(botId: string): number {
    return [...this.records.values()].filter((r) => r.botId === botId && r.status === "pending").length;
  }

  /** Bug 142: the Bot's pending cards, oldest first (a call reads them aloud and takes a spoken answer). */
  pending(botId: string): ApprovalCardView[] {
    return [...this.records.values()].filter((r) => r.botId === botId && r.status === "pending").sort((a, b) => a.createdAt - b.createdAt).map((r) => this.view(r));
  }

  get(approvalId: string): ApprovalCardView | null {
    const r = this.records.get(approvalId);
    return r ? this.view(r) : null;
  }

  /**
   * speed-fastpath: the textual read scope (analyzeShell scopeReads) judged the words; a symlink in the workspace
   * can still point at `~/.ssh` or `/`. Every file or folder a fast read opens is resolved to its real path here: one
   * outside the workspace and the plain system folders stops the fast path, one naming a credential store asks.
   * A glob is judged by its folder part.
   */
  /** speed-fastpath fix round 1: the Bot's own uid/gid (see GateDeps.botAccount). */
  private botAccount(botId: string): BotOwner | null {
    if (this.d.botAccount) return this.d.botAccount(botId);
    if (!this.d.cfg.perBotUid) return null;
    let name: string;
    try { name = botUserName(botId); } catch { return null; }
    const line = (this.readFile("/etc/passwd") ?? "").split("\n").find((l) => l.startsWith(`${name}:`));
    const f = line?.split(":");
    const uid = Number(f?.[2]), gid = Number(f?.[3]);
    return f && Number.isInteger(uid) && Number.isInteger(gid) && uid > 0 ? { uid, gid, home: f[5] || null } : null;
  }

  private realReads(st: StaticResult, paths: string[], ws: string, fsx: DevCommandFs): StaticResult {
    const realWs = fsx.realpath(ws) ?? ws;
    const inScope = (r: string) => r === realWs || r.startsWith(`${realWs}/`) || BENIGN_READ_ROOTS.some((p) => r.startsWith(p)) || BENIGN_READ_FILES.has(r);
    for (const p of paths) {
      const glob = p.search(/[*?[\]{}]/);
      const probe = glob === -1 ? p : path.dirname(p.slice(0, glob + 1));
      const real = fsx.realpath(probe);
      if (real === null) {
        // Bug 231 round 1: no real path is "not there" only when the path itself is missing. A link that doesn't
        // resolve (or a folder bothost may not enter) could lead anywhere: ask, like a credential read.
        if (this.missing(probe, fsx)) continue;
        return { ...st, readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"], signals: [...st.signals, "reads_unresolved_link"] };
      }
      if (CREDENTIAL_PATH.test(real)) return { ...st, readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"], signals: [...st.signals, "reads_credentials"] };
      if (!inScope(real)) return { ...st, readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"], signals: [...st.signals, "reads_outside_workspace"] };
    }
    return st;
  }

  /** True only when lstat says the path does not exist (ENOENT/ENOTDIR). A link, EACCES or anything else is not "missing". */
  private missing(p: string, fsx: DevCommandFs): boolean {
    if (fsx instanceof SnapshotFs && inHome(fsx.home, path.resolve(p))) return fsx.stat(p) === null; // a helper EACCES throws (unverifiable)
    try {
      fs.lstatSync(p);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
  }

  // ---------- target building ----------
  /**
   * Bug 231 round 1: the fs a decision is judged with. With the helper wired and a Bot home, paths inside the home are
   * answered from this call's snapshot (fetched as the Bot before the decision, prefetchHome); a path the snapshot
   * lacks throws HomeFsMiss (strict) and the decision fails closed. Elsewhere, and without the helper: plain fs.
   */
  private fsFor(botId: string, toolUseId: string, mode: "strict" | "record" = "strict"): DevCommandFs & { readFile(p: string): string | null } {
    // Bug 231 rounds 2-3 (B1): the judgement's reader is safeReadFs (unless a test injects one). The Bot's own home is
    // one of its roots only for plain fs (no helper: a box without per-Bot accounts, tests); with the helper, reads
    // inside the home come from the snapshot and never reach it.
    const account = this.botAccount(botId);
    const extra = account?.home && !this.d.homeFs ? account.home : "";
    let reader = this.judgedReaders.get(extra);
    if (!reader) { reader = safeReadFs(this.d.cfg, { roots: extra ? [extra] : [] }); this.judgedReaders.set(extra, reader); }
    const base = DEV_FS(this.d.readFile ?? reader);
    const home = this.d.homeFs ? account?.home : null;
    if (!home) return base;
    let snap = this.homeSnaps.get(toolUseId);
    if (!snap || snap.home !== home) snap = new HomeSnapshot(home);
    return new SnapshotFs(snap, base, mode);
  }

  /**
   * Bug 231 round 1: before a Shell/Bash decision, ask bot-fs-query (as the Bot) for what the judgement will read inside
   * the Bot's home: first the usual work-tree files around the cwd and a leading `cd`, then whatever a dry run of the
   * judgement still missed. Usually one helper call; at most three. A command that never reaches into the home makes none.
   */
  private async prefetchHome(botId: string, call: ToolCall): Promise<void> {
    if (!this.d.homeFs || (call.toolName !== "mcp__bot__Shell" && call.toolName !== "Bash")) return;
    const home = this.botAccount(botId)?.home;
    if (!home) return;
    const snap = new HomeSnapshot(home);
    this.homeSnaps.set(call.toolUseId, snap);
    if (this.homeSnaps.size > 500) this.homeSnaps.delete(this.homeSnaps.keys().next().value as string);
    const childId = this.ctxByToolUse.get(call.toolUseId)?.childId;
    const raw = call.toolName === "mcp__bot__Shell"
      ? rawShellCwd(this.d.cfg.workspace, call.input.working_directory, this.d.shellLastCwd?.(botId, childId), shellHome(this.d.cfg, botId))
      : String(call.cwd ?? this.bashCwdByToolUse.get(call.toolUseId) ?? this.d.cfg.workspace);
    const seeds = new Set<string>();
    if (inHome(home, raw)) seeds.add(raw);
    const cd = /^cd\s+(\S+)\s*&&/.exec(String(call.input.command ?? "").trim());
    if (cd) { const t = path.resolve(raw, expandHome(cd[1] as string, home)); if (inHome(home, t)) seeds.add(t); }
    let ops: [FsOp, string][] = seedOps(home, [...seeds]);
    for (let i = 0; i < 4; i++) {
      if (ops.length) {
        if (snap.calls >= 3) return; // what is still missing stays a miss: the decision fails closed
        await snap.fetch(this.d.homeFs, botId, ops);
        if (snap.failed) return;
      }
      const rec = this.fsFor(botId, call.toolUseId, "record") as SnapshotFs;
      try { const c = this.cls(botId, call); if (c.surface && c.target) this.prepare(botId, call, c, rec); } catch { /* the dry run only collects misses */ }
      ops = rec.misses.filter(([op, p]) => !snap.has(op, p));
      if (!ops.length) return;
      if (snap.calls === 0) ops = [...seedOps(home, [...new Set(ops.map(([, p]) => path.dirname(p)))]), ...ops];
    }
  }

  private prepare(botId: string, call: ToolCall, cls: Classification, fsOverride?: DevCommandFs & { readFile(p: string): string | null }): { target: RiskTarget; st: StaticResult; unbound: boolean; refused?: boolean; paths?: string[]; closedTree?: boolean } {
    let target = cls.target as RiskTarget;
    if (cls.surface === "box_shell" && target.action === "shell") {
      const ws = this.d.cfg.workspace;
      const command = String(call.input.command ?? "");
      const fsx = fsOverride ?? this.fsFor(botId, call.toolUseId);
      try {
        return this.prepareShell(botId, call, target, fsx);
      } catch (e) {
        if (!(e instanceof HomeFsMiss)) throw e;
        // Bug 231 round 1: something inside the Bot's home couldn't be checked as the Bot. Never "not there": the
        // command goes to the model with what the text alone shows, and never takes a fast path.
        const cwd = this.shellCwd(botId, call) ?? String(target.arguments.working_directory ?? ws);
        target = { ...target, arguments: { ...target.arguments, working_directory: cwd } };
        const st = analyzeShell(command, { workspace: ws, cwd, scopeReads: true });
        return { target, st: { ...st, readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"], signals: [...st.signals, "home_unverified"] }, unbound: e instanceof UnboundMiss, refused: e instanceof UnboundMiss };
      }
    }
    return this.prepareOther(botId, call, cls, target);
  }

  private prepareShell(botId: string, call: ToolCall, target0: RiskTarget, fsx: DevCommandFs & { readFile(p: string): string | null }): { target: RiskTarget; st: StaticResult; unbound: boolean; paths?: string[]; closedTree?: boolean } {
    let target = target0;
    {
      const ws = this.d.cfg.workspace;
      const command = String(call.input.command ?? "");
      // I2: recompute the real cwd so a change between review and execution changes the fingerprint.
      // Fix round 2: the Bot's own home is its private space (its 0700 home holds ~/code, bug 195's repos).
      const account = this.botAccount(botId);
      const realHome = account?.home ? fsx.realpath(account.home) : null;
      const bashCwd = this.bashCwd(call, [account?.home, realHome]);
      const cwdInfo = this.shellCwdInfo(botId, call, fsx);
      const cwd = cwdInfo?.path ?? bashCwd ?? String(target.arguments.working_directory ?? ws);
      target = { ...target, arguments: { ...target.arguments, working_directory: cwd } };
      // Bug 231 round 1: a Shell cwd bothost couldn't resolve is judged on the model's side, never as its raw text.
      if (cwdInfo && !cwdInfo.verified) throw new HomeFsMiss("realpath", cwd);
      // A work tree inside the Bot's home is judged with that tree as its workspace: its reads stay inside the repo
      // (never the home's own dotfiles), and the dev path treats the repo as a tree under a workspace.
      const realCwd = fsx.realpath(cwd);
      const homeTreeDir = realHome && realCwd && realCwd !== realHome && insideDir(realHome, realCwd, realHome) ? gitRootOf(realCwd, fsx) : null;
      let homeTree = homeTreeDir && homeTreeDir !== realHome && insideDir(realHome as string, homeTreeDir, realHome as string) ? homeTreeDir : null;
      let fromCd = false;
      // `cd ~/code/<repo> && …` from anywhere in the home (another repo included): judged in that repo, since the cd
      // is the command's first step.
      const lead = realHome && realCwd && insideDir(realHome, realCwd, realHome) ? /^cd (\/[^ ;&|]+) && /.exec(command.trim()) : null;
      if (lead) {
        const t = fsx.realpath(lead[1] as string);
        const r = t && realHome && insideDir(realHome, t, realHome) ? gitRootOf(t, fsx) : null;
        if (r && r !== realHome && insideDir(realHome as string, r, realHome as string) && t === lead[1]) { homeTree = r; fromCd = true; }
      }
      const scopeWs = homeTree ?? ws;
      // Only the Bot's own home can be a closed tree (final ruling): never the shared /workspace.
      const boundaries = realHome ? [realHome] : [];
      const outside = !homeTree && !insideDir(ws, cwd, ws);
      const withCwd = (st: StaticResult): StaticResult => {
        if (!outside) return st;
        return { ...st, signals: [...st.signals, "cwd_outside_workspace"], readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"] };
      };
      let e: ReturnType<typeof enrichShell>;
      try {
        // Bug 71 ruling: a script that EXISTS but the safe reader refuses (a symlink or hard link to a secret or into
        // host-private, a link out of the tree) is an attack signal: UnboundMiss, a hard deny. A script that simply
        // isn't there is ordinary unbound (a card).
        const readFile = (p: string) => {
          const r = fsx.readFile(p);
          if (r === null && existsNoFollow(p)) throw new UnboundMiss("read", p);
          return r;
        };
        e = enrichShell(command, { cwd, readFile, scrub: (t) => scrubTokenShapes(this.d.redact ? this.d.redact(botId, t) : t) });
      } catch (x) {
        // The script or package.json a command runs couldn't be read as the Bot: the reviewer can't see what runs.
        if (x instanceof HomeFsMiss) throw new UnboundMiss(x.op, x.p);
        throw x;
      }
      if (e.unbound) {
        // Bug 258: whether it runs in the Bot's own closed tree (its 0700 home, never the shared /workspace) and stays
        // there as written; then Full auto runs it with no card (preToolUse decides by mode).
        const root = homeTree ?? realCwd;
        const closedTree = !!(realHome && root && unboundInClosedTree(command, root, fsx, account, realHome));
        return { target, st: withCwd(analyzeShell(command, { workspace: scopeWs, cwd: homeTree && !fromCd ? (realCwd as string) : cwd, scopeReads: true })), unbound: true, closedTree };
      }
      // Bug 231 round 2 (defence in depth): the head the reviewer reads went through the Bot's own redaction and the
      // credential-shape scrubber (enrichShell's scrub, on the full text); the hash still pins the file's real contents.
      target = { ...target, enrichment: e.enrichment };
      const readPaths: string[] = [];
      const gitReads: string[] = [];
      const st0 = analyzeShell(command, { workspace: scopeWs, cwd: homeTree && !fromCd ? (realCwd as string) : cwd, scopeReads: true, readPaths, gitReads });
      // Every fast read segment's files, also inside a dev chain (`cat link/x && npm test`), are judged by real path.
      let st = this.realReads(st0, readPaths, scopeWs, fsx);
      // Fix round 2: a fast git read runs its repo's config and hooks: the repo must be inert and the Bot's own.
      for (const dir of gitReads) {
        const repo = gitRootOf(fsx.realpath(dir) ?? dir, fsx);
        if (repo && !gitReadTrusted(repo, fsx, account, boundaries)) {
          st = { ...st, readOnly: false, tierHint: Math.max(st.tierHint, 1) as StaticResult["tierHint"], signals: [...st.signals, "git_repo_untrusted"] };
          break;
        }
      }
      // speed-fastpath: the files and folders the reads open, so a path-scoped Ask-first rule reaches a shell read;
      // anything else (a dev command, a write) also gets its cwd, which it may read throughout.
      // Fix round 1: and their real paths, so a rule on the real folder also matches a read through a link.
      const textual = st0.readOnly ? readPaths : [cwd, ...readPaths];
      const paths = [...new Set([...textual, ...textual.map((p) => fsx.realpath(p)).filter((p): p is string => p !== null)])];
      st.signals.push(...e.extraSignals);
      // S1 lean engineering profile: the project's own build/test/commit command inside a git work tree skips
      // the model reviewer, and only when the static pass found nothing but the deletes/writes (and their F4) of
      // housekeeping that engineeringDevCommand judges operand by operand itself (2026-09-21 coding bench). A
      // never-floor (F7–F9) still stops at the reviewer's S3 before any fast path.
      // speed-fastpath #4: the dev commands (tests, builds, typecheck, lint, git add/commit, git reads) are fast for
      // EVERY Bot; the housekeeping deletes (rm/mkdir chores) stay engineering-mode only. A workspace test or build
      // script is the Bot's own code: it runs as the Bot, inside the Bot's box sandbox, exactly as it did after a review.
      const choresOnly = st.floorHits.every((f) => f === "F4") && st.signals.every((s) => /^(deletes|writes):/.test(s));
      const lean = this.d.bots.has(botId) && isLean(this.d.bots.summary(botId).settings);
      if (!outside && choresOnly && this.d.bots.has(botId)
        && engineeringDevCommand(command, { cwd, cwdKnown: call.toolName === "mcp__bot__Shell" || bashCwd !== undefined, workspace: homeTree ? path.dirname(homeTree) : ws, fs: fsx, chores: lean, owner: account, boundaries })) {
        return { target, st: { ...st, tierHint: 0, devFastPath: true }, unbound: false, paths };
      }
      return { target, st: withCwd(st), unbound: false, paths };
    }
  }

  private prepareOther(botId: string, call: ToolCall, cls: Classification, target: RiskTarget): { target: RiskTarget; st: StaticResult; unbound: boolean; paths?: string[] } {
    // Item 7 ruling: another Bot's standing instructions change only with the user's OK (F8 → always a card).
    if (OWNERSHIP.has(target.action)) return { target, st: { tierHint: 4, signals: ["standing_instructions_change"], floorHits: ["F8"], readOnly: false }, unbound: false };
    if (target.action === "write_file") {
      // Item 1c ruling: a Write/Edit to a git control file or a security control is F8, so it always raises a card.
      const p = path.resolve(this.d.cfg.workspace, String(target.arguments.path ?? ""));
      if (GIT_CONTROL_PATH.test(p) || SECURITY_PATH.test(p)) return { target, st: { tierHint: 4, signals: [`writes:${p}`], floorHits: ["F8"], readOnly: false }, unbound: false };
    }
    // P5 review I1/I2: the Mac-floor static pass (and CopyToBox's box_path under the F8 git-control/security floor).
    if (cls.surface === "host_shell") return { target, st: hostCallStatic(call, this.d.cfg.workspace), unbound: false };
    if (cls.surface === "computer" && call.toolName.startsWith("mcp__computer__") && uiNavKey(target)) return { target, st: { tierHint: 0, signals: ["ui_navigation_key"], floorHits: [], readOnly: true }, unbound: false };
    if (cls.surface === "control_plane" && target.action === "delete_agent") {
      return { target, st: { tierHint: 3, signals: ["irreversible Bot deletion"], floorHits: ["F4"], readOnly: false }, unbound: false };
    }
    return { target, st: { tierHint: 2, signals: [], floorHits: [], readOnly: false }, unbound: false };
  }

  private context(botId: string, target: RiskTarget, slot: TurnSlot | null, wakeUntrusted: string[] = []): ReviewContext {
    const tail = this.d.bots.tail(botId, 60);
    const user = tail.filter((e) => e.kind === "message" && !isAgentMessage(e)).map((e) => (e as { content: string }).content);
    const assistant = tail.filter((e) => e.kind === "send-message" && e.message.type === "text").map((e) => ((e as SendMessageEntry).message as { content: string }).content);
    const needles = JSON.stringify(target.arguments).match(/[\w.-]+@[\w.-]+|https?:\/\/[^\s"']+|[\w-]+\.(?:com|io|net|org|dev|app|site|example)\b/g) ?? [];
    // I2: untrusted wake text (event payloads, peer/group messages) is searched like fenced tool output.
    const untrusted = [...(slot?.untrusted ?? []), ...wakeUntrusted].flatMap((out) => {
      const hit = needles.find((n) => out.includes(n) && !user.some((u) => u.includes(n)));
      if (!hit) return [];
      const i = out.indexOf(hit);
      return [out.slice(Math.max(0, i - 400), i + 600)];
    });
    return { user_messages: user.slice(-2), assistant_messages: assistant.slice(-4), question_answers: [], untrusted_excerpts: untrusted.slice(0, 3) };
  }

  /** Both preToolUse and canUseTool key transient bookkeeping (ctxByToolUse, and preDecided for
   * preToolUse) off call.toolUseId. Every return path that will not end up with a pending Item in
   * `records` — which is the only structure settle()/forgetBot() ever clean up — must drop that
   * bookkeeping itself here, or it lives in the Map for the life of the Bot (fix round 1, finding 1). */
  private forgetCall(toolUseId: string): void {
    this.ctxByToolUse.delete(toolUseId);
    this.preDecided.delete(toolUseId);
    this.bashCwdByToolUse.delete(toolUseId);
    this.homeSnaps.delete(toolUseId);
  }

  /**
   * cost-diet-2 (coding-bench run 2): where a built-in Bash command will run, when the CLI told us and it is inside the
   * workspace; otherwise undefined and Bash is judged as before (cwd unknown). A cwd outside the workspace (the Bot's
   * .bot-cwd) is deliberately not used: it would only add a cwd_outside_workspace signal to commands judged fine today.
   */
  private bashCwd(call: ToolCall, homes: (string | null | undefined)[] = []): string | undefined {
    if (call.toolName !== "Bash") return undefined;
    const c = call.cwd ?? this.bashCwdByToolUse.get(call.toolUseId);
    const ws = this.d.cfg.workspace;
    // Fix round 2: also inside the Bot's own home (its repos under ~/code).
    return c && path.isAbsolute(c) && (insideDir(ws, c, ws) || homes.some((h) => !!h && insideDir(h, c, h))) ? path.resolve(c) : undefined;
  }

  // ---------- PreToolUse (APR-01) ----------
  async preToolUse(botId: string, call: ToolCall, ctx?: GateCallCtx): Promise<PreToolDecision> {
    if (ctx) this.ctxByToolUse.set(call.toolUseId, ctx);
    if (call.toolName === "Bash" && call.cwd) this.bashCwdByToolUse.set(call.toolUseId, call.cwd);
    await this.prefetchHome(botId, call); // bug 231 round 1: one bot-fs-query batch before anything reads the home
    // "ask" leaves the ctx/preDecided bookkeeping in place for the later canUseTool call (and its
    // eventual settle()); "defer" leaves ctx in place for the internal canUseTool call below. Every
    // other decision is final for this toolUseId, so it forgets the bookkeeping before returning.
    // Final secfix item 1: an allow is pinned from the ENRICHED classification (the draft_hash the card showed).
    let pinCls: Classification | undefined;
    const finish = (d: PreToolDecision): PreToolDecision => {
      if (d.decision === "allow" && !d.updatedInput) {
        const input = this.pinned(botId, call, pinCls);
        if (input) d = { ...d, updatedInput: input };
      }
      if (d.decision !== "ask" && d.decision !== "defer") this.forgetCall(call.toolUseId);
      return d;
    };
    const slot = this.slotFor(botId, call.toolUseId);
    if (slot?.quiescing) return finish({ decision: "deny", reason: TEXT.quiescing });
    if (slot?.awaitingUserSelection) return finish({ decision: "deny", reason: TEXT.awaiting });
    if (slot && slot.toolCallsTotal >= LIMITS.toolStepsPerTurn) return finish({ decision: "deny", reason: TEXT.maxSteps });
    const cls = this.cls(botId, call);
    if (cls.hardDeny) return finish({ decision: "deny", reason: cls.hardDeny });

    const pre = this.preDecided.get(call.toolUseId);
    if (pre) {
      this.preDecided.delete(call.toolUseId);
      if (pre.decision.behavior === "deny") return finish({ decision: "deny", reason: pre.decision.message });
      let now: Classification = cls;
      if (cls.target?.action === "google_write") {
        const e = await this.enrichGoogle(botId, call, cls);
        if (typeof e === "string") return finish({ decision: "deny", reason: e });
        now = e;
      }
      const fp = now.surface && now.target ? fingerprint(now.surface, this.prepare(botId, call, now).target) : pre.fingerprint;
      if (fp !== pre.fingerprint) return finish({ decision: "deny", reason: TEXT.toctou });
      pinCls = pre.cls;
      return finish({ decision: "allow" });
    }
    // Bug B: a detached card (its turn already ended) doesn't hold the Bot's later turns behind the barrier.
    if (cls.sideEffect && [...this.records.values()].some((r) => r.botId === botId && r.status === "pending" && !r.detached)) return finish({ decision: "deny", reason: TEXT.barrier });
    if (!cls.surface || !cls.target) return finish({ decision: "allow" });
    // Ruling (b): an ownership gate, not a review. Another Bot's standing instructions change only with the user's
    // OK: a card even with Auto-review off, and neither the reviewer nor an Allow rule can skip it.
    // + P5 review C3/I5 (shared instructions, skills, servers, tools) and I1/I2 (a Mac-floor hit or zsh-opaque command).
    const mode: PermMode = this.d.permMode?.(botId) ?? "ask";
    // Bug 258: No limits (on top of Full auto): the send asks and the private-file reads go; the NEVER walls stay.
    const noLimits = mode === "full-auto" && (this.d.noLimits?.(botId) ?? false);
    const env = noLimits ? { ...this.fixedEnv(), noLimits: true } : this.fixedEnv();
    /**
     * full-auto-quiet — ONE policy for Full auto. In that mode the shared classifier (@synapse/shared full-auto.ts,
     * the same module the Mac coordinator and the Browser classifier call) is the only thing that raises a card, and
     * it raises one for exactly four categories: DESTRUCTION of the user's data, SENDING OUTWARD, MONEY, and
     * SECURITY AND ACCESS. The fifth, the user's own written ask-first rules, stays with the reviewer below.
     *
     * So in Full auto the Mac floor, the Google gate, the ownership gates, the fixed ALWAYS-ASK and the F7/F8/F9
     * floors no longer force cards of their own — `fa` speaks for all of them. What they still do is BLOCK:
     * hardDeny, the walls and the fixed NEVER wall are untouched, in every mode.
     * The other modes are exactly as before.
     */
    const fa = mode === "full-auto" ? fullAutoAskFor(call, cls, env) : null;
    // fix-mac-gate-and-approval-expiry: in Full auto a zsh-opaque signal alone (e.g. the quoted glob in
    // `find ~/Downloads -name '*.pdf'`) doesn't force the card; the fixed rules' real parser below returns ALWAYS-ASK
    // for anything it can't prove. A Mac-floor hit still does, outside Full auto.
    const macSt = cls.surface === "host_shell" ? hostCallStatic(call, this.d.cfg.workspace) : null;
    const macCard = !fa && !!macSt && macSt.forceCard;
    // ORIG-GOOGLE: sending mail, calendar writes and Drive uploads act on the user's own accounts: always a card too.
    // full-auto-quiet: in Full auto only the ones the classifier names ask — but any Google write that IS going to
    // card still gets its host-side enrichment (the recipients the card shows, and the content hash the send is
    // pinned to), so a Full-auto send card is never the blind "send your draft" the ORIG-GOOGLE rule forbids.
    const googleWrite = cls.target.action === "google_write";
    const google = !fa && googleWrite;
    const ownership = !fa && (OWNERSHIP.has(cls.target.action) || isOwnershipAction(cls.target) || macCard || google);

    // ---- LAYER 1: the fixed rules (feat-mac-access-parity), before the reviewer ----
    // NEVER is a hard deny no mode or rule can lift; ALWAYS-ASK forces a card outside Full auto; ALWAYS-ALLOW skips
    // the reviewer entirely. The mode-based skips are applied further down, once the static floor is known.
    const fixed = fixedRuleFor(call, cls, env);
    if (fixed.verdict === "never") return finish({ decision: "deny", reason: fixed.reason });
    const fixedAsk = !fa && fixed.verdict === "always-ask" && !ownership;
    if (!ownership && !fixedAsk && !fa?.ask && fixed.verdict === "always-allow") return finish({ decision: "allow" }); // reads / build-test-git in a project dir

    // ORIG-GOOGLE draft-send card: gmail_send(draft_id) never raises a card until the draft's current
    // To/Cc/Bcc/Subject/body/attachments are fetched with the user's own token — so the user is never asked to
    // approve a blind "send your draft". A fetch failure denies outright rather than showing that blind card.
    // (cardCls carries the enrichment; cls itself is never reassigned, so its surface/target stay narrowed below.)
    let cardCls: Classification = cls;
    if (google || (googleWrite && fa?.ask)) {
      const enriched = await this.enrichGoogle(botId, call, cls);
      if (typeof enriched === "string") return finish({ decision: "deny", reason: enriched });
      cardCls = enriched;
    }
    pinCls = cardCls;

    const { target, st, unbound, refused, paths: readPaths, closedTree } = this.prepare(botId, call, cardCls);
    // Bug 71 ruling: the Bot's own read of the script was refused (a link to a secret or into host-private): denied.
    if (refused) return finish({ decision: "deny", reason: TEXT.unbound });
    // Bug 71 (usability ruling): a command whose scripts the pass couldn't see or follow never runs silently and is
    // never a flat deny: it is a card showing the exact command, in EVERY mode (Full auto included); the reviewer is
    // not asked (it couldn't see the script either), and no Allow rule or mode skip lifts it.
    // Bug 258: in Full auto, when the command runs in the Bot's own closed tree (closedAncestor under its 0700 home) and
    // stays there, it runs with no card: the scripts it can reach are the Bot's own. The shared /workspace keeps it.
    const unboundAsk = unbound && !(mode === "full-auto" && closedTree === true);
    const fp = fingerprint(cls.surface, target);
    const rehearsal = this.d.rehearsals?.active(botId, call, slot) ?? false;
    if (rehearsal && (st.tierHint >= 2 || st.floorHits.length > 0)) return finish({ decision: "deny", reason: STR.rehearsalStopped });
    if (this.deferApproved.delete(`${botId}:${fp}`)) return finish({ decision: "allow" });
    // ---- LAYER 1 (cont.) + MODES: reviewer skips, now that the static floor (F7/F8/F9) is known. A floor hit or an
    // ALWAYS-ASK always cards; otherwise Full auto runs, Auto-accept-edits runs an in-project edit, and Auto-review
    // OFF runs (the account master switch and the fixed NEVER already had their say above). Rehearsals win over all. ----
    const floorHit = st.floorHits.some((f) => f === "F7" || f === "F8" || f === "F9");
    // speed-fastpath #5 (the user's ruling): a box command that reads stored credentials (keys, tokens, the environment)
    // asks in EVERY mode, Full auto included; it never reaches the reviewer's fast path.
    const unresolvedAsk = cls.surface === "box_shell" && st.signals.includes("reads_unresolved_link");
    const credAsk = cls.surface === "box_shell" && (st.signals.includes("reads_credentials") || unresolvedAsk);
    // full-auto-quiet: in Full auto the F7/F8/F9 floor no longer holds a call back on its own either — F7
    // (credentials, exfiltration) and F9 (pipe-to-shell) are the classifier's SECURITY category, and F8's
    // git-control half is exactly the `git config --global` false positive this change removes.
    if (!unboundAsk && !ownership && !fixedAsk && !credAsk && (fa ? !fa.ask : !floorHit) && !rehearsal) {
      // full-auto-quiet: the classifier said no card. The user's OWN written ask-first rules still win, so when they
      // have written any, the reviewer still runs below and a block that matched one becomes a card; with none
      // written (the usual case) routine work runs silently and costs no reviewer call, exactly as before.
      if (mode === "full-auto" && this.askRules() === 0) return finish({ decision: "allow" });
      if (mode === "accept-edits" && modeAllowsWithoutCard("accept-edits", call, cls, this.fixedEnv())) return finish({ decision: "allow" });
      if (!this.d.settings.get().autoReviewEnabled) return finish({ decision: "allow" });
    }
    const bot = this.d.bots.summary(botId);
    const identityBefore = cls.surface === "computer" && this.d.displayIdentity ? await this.d.displayIdentity(botId) : null;
    const reviewTarget = identityBefore ? { ...target, arguments: { ...target.arguments, display_identity: identityBefore } } : target;
    const origin = slot ? originOf(slot.reviewSource ?? slot.source) : "user";
    const wb = wakeBlock(slot, origin, this.d.routinePrompt, botId);
    const ctx0 = this.context(botId, target, slot, wb.untrusted);
    // I2: for a non-user wake the 1:1 user messages are stale — they move to the wake block, labelled, and aren't the request.
    const wake: ReviewWake = { ...wb, stale_user_messages: origin === "user" ? [] : ctx0.user_messages };
    const reviewCtx: ReviewContext = origin === "user" ? ctx0 : { ...ctx0, user_messages: [] };
    // full-auto-quiet: in Full auto the classifier's verdict IS the card, and it never asks the reviewer.
    const outcome: ReviewOutcome = unboundAsk ? { kind: "block", stage: "floor", reason: TEXT.unboundCard, proposedRule: null, verdict: null }
      : fa?.ask ? { kind: "block", stage: "floor", reason: fa.reason, proposedRule: null, verdict: null }
      : credAsk ? { kind: "block", stage: "floor", reason: unresolvedAsk && !st.signals.includes("reads_credentials") ? UNRESOLVED_READ_REASON : CREDENTIAL_READ_REASON, proposedRule: null, verdict: null }
      : (ownership || fixedAsk) ? { kind: "block", stage: "floor", reason: ownership ? (google ? TEXT.googleWrite : OWNERSHIP.has(cls.target.action) ? TEXT.ownership : macCard ? TEXT.macFloor : TEXT.ownershipShared) : fixed.reason, proposedRule: fixedAsk ? (fixed.proposedRule ?? null) : null, verdict: null } : await this.d.reviewer.review({
      botId, botName: bot.profile.name, botDescription: bot.profile.description, surface: cls.surface, toolName: call.toolName, target: reviewTarget,
      origin, wake, context: reviewCtx,
      userMessageEpoch: this.d.bots.userMessageEpoch(botId), staticResult: st, fingerprint: fp,
      paths: [call.input.file_path, call.input.path, ...(readPaths ?? [])].filter((p): p is string => typeof p === "string"),
    });
    if (outcome.kind === "allow") {
      if (identityBefore !== null && (await this.d.displayIdentity!(botId)) !== identityBefore) return finish({ decision: "deny", reason: STRC.pageChanged });
      return finish({ decision: "allow" });
    }
    if (outcome.kind === "error") return finish({ decision: "deny", reason: outcome.message });
    // full-auto-quiet: Auto Review kept running (the user has ask-first rules, or the static floor flagged this).
    // A bad command is still BLOCKED — a floor-stage refusal denies. Anything else it merely wanted the user's OK
    // for is not one of the five categories, so in Full auto it runs and is only recorded in the activity log;
    // a block that matched one of the user's OWN ask-first rules is the exception and raises the card.
    if (fa && !fa.ask && !credAsk && !unboundAsk) {
      const matched = outcome.kind === "block" && (outcome.verdict?.matched_ask_rule_ids.length ?? 0) > 0;
      if (!matched) {
        if (outcome.kind === "block" && outcome.stage === "floor") return finish({ decision: "deny", reason: outcome.reason });
        return finish({ decision: "allow" });
      }
    }
    if (rehearsal) return finish({ decision: "deny", reason: STR.rehearsalStopped });                       // ORIG-08 §08.3: denied, not asked
    if (slot?.context.group || slot?.source === "group-member") return finish({ decision: "deny", reason: STR.groupApprovalUnavailable }); // GRP-07
    this.reviews.set(call.toolUseId, { outcome, cls: { ...cardCls, target }, fingerprint: fp });
    const reason = outcome.kind === "block" ? outcome.reason : outcome.reason;
    const path = this.d.flags().approvalPath;
    if (path === "canUseTool") return finish({ decision: "ask", reason });
    if (path === "hook") {
      const perm = await this.canUseTool(botId, call, new AbortController().signal, ctx);
      return finish(perm.behavior === "allow" ? (perm.updatedInput ? { decision: "allow", updatedInput: perm.updatedInput } : { decision: "allow" }) : { decision: "deny", reason: perm.message });
    }
    // defer (§13.2 B): the query ends now; the answer resumes the session with a hidden message
    const summary = cls.summary;
    void this.canUseTool(botId, call, new AbortController().signal, ctx).then((perm) => {
      if (perm.behavior === "allow") {
        this.deferApproved.add(`${botId}:${fp}`);
        this.d.onDeferredResolution(botId, `[Auto-review] The user approved: ${summary}. Run exactly that action now.`);
      } else this.d.onDeferredResolution(botId, `[Auto-review] ${perm.message}`);
    });
    if (slot) slot.awaitingUserSelection = true;
    return finish({ decision: "defer", reason: "Waiting for the user to approve this action." });
  }

  // ---------- canUseTool (APR-01 step 5, APR-19) ----------
  canUseTool(botId: string, call: ToolCall, signal: AbortSignal, ctx?: GateCallCtx): Promise<PermissionDecision> {
    if (ctx) this.ctxByToolUse.set(call.toolUseId, ctx);
    const existing = [...this.records.values()].find((r) => r.botId === botId && r.items.some((i) => i.toolUseId === call.toolUseId));
    if (existing) {
      const item = existing.items.find((i) => i.toolUseId === call.toolUseId) as Item;
      if (existing.status !== "pending") { this.forgetCall(call.toolUseId); return Promise.resolve(this.decisionFor(existing, item)); }
      return new Promise((resolve) => { item.resolve = resolve; });
    }
    const pr = this.reviews.get(call.toolUseId);
    if (!pr) { this.forgetCall(call.toolUseId); return Promise.resolve({ behavior: "deny", message: "Blocked: this action was not reviewed." }); }
    this.reviews.delete(call.toolUseId);
    if (this.pendingCount(botId) >= LIMITS.pendingApprovalsPerBot) { this.forgetCall(call.toolUseId); return Promise.resolve({ behavior: "deny", message: TEXT.tooMany }); }
    return new Promise((resolve) => {
      const item: Item = { toolUseId: call.toolUseId, call, cls: pr.cls, fingerprint: pr.fingerprint, summary: pr.cls.summary, status: "pending", resolve };
      const rec = this.raise(botId, pr, item);
      // Bug B: the session ending (rollover, interrupt) no longer expires the card: it stays answerable (detached).
      signal.addEventListener("abort", () => this.detach(rec), { once: true });
    });
  }

  private raise(botId: string, pr: PendingReview, item: Item): ApprovalRecord {
    const slot = this.slotFor(botId, item.toolUseId);
    const t = this.now();
    const items = [item];
    const messageId = slot?.toolUses.get(item.toolUseId)?.messageId;
    if (slot && messageId && !ApprovalGate.unbatchable(item.cls)) {
      for (const [tu, u] of slot.toolUses) {
        if (tu === item.toolUseId || u.messageId !== messageId || u.name !== item.call.toolName) continue;
        const call = { toolName: u.name, input: u.input, toolUseId: tu };
        const cls = this.cls(botId, call);
        if (!cls.surface || cls.surface !== pr.cls.surface || !cls.target || ApprovalGate.unbatchable(cls)) continue;
        const { target } = this.prepare(botId, call, cls);
        items.push({ toolUseId: tu, call, cls: { ...cls, target }, fingerprint: fingerprint(cls.surface, target), summary: cls.summary, status: "pending" });
      }
    }
    const bot = this.d.bots.summary(botId);
    const words = describeCall(item.call.toolName, item.call.input);
    const title = items.length > 1
      ? (words ? STR.batchTitle(bot.profile.name, words.future, items.length, words.nounPlural) : `${STR.approvalTitle[pr.cls.surface as string]} · ${items.length} actions`)
      : (STR.approvalTitle[pr.cls.surface as string] as string);
    const verdict = pr.outcome.kind === "block" ? pr.outcome.verdict : null;
    const turn = slot?.turnNo ?? this.d.bots.nextTurnNo(botId);
    const k = slot ? ++slot.nextSendK : 1;
    const rec: ApprovalRecord = {
      id: randomUUID(), botId, surface: pr.cls.surface as Surface, items, title,
      reason: (pr.outcome.kind === "block" ? pr.outcome.reason : pr.outcome.reason).slice(0, LIMITS.approvalReasonMax),
      summary: items.length > 1 ? items.map((i) => i.summary).join("\n") : item.summary.slice(0, LIMITS.approvalSummaryMax),
      command: items.map((i) => i.cls.command).filter(Boolean).join("\n").slice(0, LIMITS.approvalCommandMax) || null,
      proposedRule: pr.outcome.kind === "block" ? pr.outcome.proposedRule : null, verdict,
      stage: pr.outcome.kind === "block" ? pr.outcome.stage : "degraded", createdAt: t, settledAt: null,
      policy: !slot || slot.lane === "user" ? "park" : "ttl", status: "pending", cause: null,
      entryId: sendEntryId(turn, k), requestId: slot?.requestId ?? "", ruleAddedText: null,
    };
    this.records.set(rec.id, rec);
    // Bug B: every card waits for the answer; one left unanswered for 7 days is withdrawn for hygiene (cause ttl).
    this.hygiene(rec);
    this.d.bots.appendEntry(botId, { kind: "send-message", id: rec.entryId, requestId: rec.requestId, createdAt: t, message: { type: "auto-review-approval", approval: this.view(rec) } });
    if (slot) slot.segment += 1;
    this.d.bots.setAwaiting(botId, { tabId: "auto-review", reason: STR.approvalNeeded(item.summary), since: t });
    this.persist();
    return rec;
  }

  private hygiene(rec: ApprovalRecord): void {
    const left = rec.createdAt + LIMITS.backgroundApprovalTtlMs - this.now();
    rec.timer = setTimeout(() => this.settle(rec, "expired", "ttl"), Math.max(0, left));
    rec.timer.unref?.();
  }

  /** Bug B: the turn waiting on this card is gone. Its tool call returns now; the card stays pending and answerable. */
  private detach(rec: ApprovalRecord): void {
    if (rec.status !== "pending" || rec.detached) return;
    rec.detached = true;
    for (const item of rec.items) {
      item.resolve?.({ behavior: "deny", message: "The session ended while this action waited for the user. The card stays open: when the user answers it you'll be woken with the decision. Don't retry it now." });
      item.resolve = undefined;
      this.ctxByToolUse.delete(item.toolUseId);
    }
    this.persist();
  }

  /** Bug B: pending cards on disk, so a host restart between the card and the answer keeps them answerable. */
  private persist(): void {
    const f = this.d.persistFile;
    if (!f) return;
    const pending = [...this.records.values()].filter((r) => r.status === "pending").map(({ timer: _t, ...r }) => ({ ...r, items: r.items.map(({ resolve: _r, ...i }) => i) }));
    try {
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ records: pending }), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch { /* best effort: the card is still answerable in this process */ }
  }

  private restore(): void {
    const f = this.d.persistFile;
    if (!f) return;
    let data: { records?: ApprovalRecord[] };
    try { data = JSON.parse(fs.readFileSync(f, "utf8")) as { records?: ApprovalRecord[] }; } catch { return; }
    for (const r of data.records ?? []) {
      if (!r || typeof r.id !== "string" || r.status !== "pending" || !Array.isArray(r.items) || !this.d.bots.has(r.botId) || this.records.has(r.id)) continue;
      const rec: ApprovalRecord = { ...r, detached: true, timer: undefined };
      this.records.set(rec.id, rec);
      this.hygiene(rec);
    }
  }

  private view(r: ApprovalRecord): ApprovalCardView {
    const google = r.items[0]?.cls.target?.action === "google_write";
    const loc = google ? STRG.cardLocation : r.surface === "host_shell" ? STR.runsOnLocal : r.surface === "box_shell" || r.surface === "computer" || r.surface === "mcp" ? STR.runsOnBox : null;
    return {
      approvalId: r.id, requestId: r.requestId, surface: r.surface, title: r.title, reason: r.reason, summary: r.summary, locationLine: loc,
      details: r.command ? truncateDetails(r.command) : null, command: r.command,
      items: r.items.length > 1 ? r.items.map((i) => ({ toolUseId: i.toolUseId, summary: i.summary, status: i.status })) : [],
      hasProposedRule: Boolean(r.proposedRule), status: r.status, cause: r.cause,
      verdict: r.verdict
        ? { reason: r.verdict.reason, tier: r.verdict.risk_tier, matchedRuleIds: [...r.verdict.matched_ask_rule_ids, ...r.verdict.matched_allow_rule_ids], floorCategory: r.verdict.floor_category, stage: r.stage }
        : { reason: r.reason, tier: null, matchedRuleIds: [], floorCategory: null, stage: r.stage },
      ruleAddedText: r.ruleAddedText, createdAt: r.createdAt, settledAt: r.settledAt,
    };
  }

  // ---------- resolution ----------
  /** `note` (deny only, bug 142): the change the user asked for by voice; the Bot is told to redo the action with it. */
  resolve(botId: string, approvalId: string, choice: ApprovalChoice, note?: string): ApprovalStatus {
    const rec = this.records.get(approvalId);
    if (!rec || rec.botId !== botId) {
      throw new GatewayError("STALE_APPROVAL", "This Auto-review request is out of date, has expired, or isn't yours to answer.", 409);
    }
    if (rec.status !== "pending") return rec.status;
    if (choice === "deny" && note?.trim()) rec.note = note.trim().slice(0, 500);
    if (choice === "deny") this.settle(rec, "denied");
    else if (choice === "always" && rec.proposedRule) {
      const added = this.d.settings.addAllowRule(rec.proposedRule);
      rec.ruleAddedText = STR.ruleAdded(added.rule);
      this.d.reviewer.clearCache();
      this.settle(rec, "always");
    } else this.settle(rec, "approved");
    return rec.status;
  }

  private refingerprint(botId: string, item: Item): string {
    if (!item.cls.surface || !item.cls.target) return item.fingerprint;
    if (item.call.toolName === "mcp__bot__Shell") {
      const cls = this.cls(botId, item.call); // I2: a cwd now inside hostPrivate is a hard deny, so no fingerprint matches
      if (cls.hardDeny || !cls.target) return "";
    }
    return fingerprint(item.cls.surface, this.prepare(botId, item.call, item.cls).target);
  }

  private decisionFor(rec: ApprovalRecord, item: Item): PermissionDecision {
    if (rec.status === "approved" || rec.status === "always") {
      if (this.refingerprint(rec.botId, item) !== item.fingerprint) return { behavior: "deny", message: TEXT.toctou };
      const input = this.pinned(rec.botId, item.call, item.cls);
      return input ? { behavior: "allow", updatedInput: input } : { behavior: "allow" };
    }
    if (rec.status === "denied") return { behavior: "deny", message: denyText(rec) };
    return { behavior: "deny", message: TEXT.expired[rec.cause ?? "ttl"] ?? TEXT.expired.ttl as string };
  }

  private settle(rec: ApprovalRecord, status: ApprovalStatus, cause?: string): void {
    if (rec.status !== "pending") return;
    rec.status = status;
    rec.cause = cause ?? null;
    rec.settledAt = this.now();
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.detached) {
      // Bug B: nobody is waiting on these tool calls any more. The answer resumes the Bot (the defer path): an
      // approval is one-time and bound to the exact call's fingerprint and this Bot (deferApproved), and a stale
      // re-run whose fingerprint no longer matches simply gets a fresh card.
      const ok = status === "approved" || status === "always";
      for (const item of rec.items) {
        item.status = ok ? status : status === "expired" ? "expired" : "denied";
        if (ok) this.deferApproved.add(`${rec.botId}:${item.fingerprint}`);
      }
      if (this.d.bots.has(rec.botId) && status !== "expired") {
        this.d.onDeferredResolution(rec.botId, ok ? `[Auto-review] The user approved: ${rec.summary}. Run exactly that action now.` : `[Auto-review] ${denyText(rec)}`);
      }
    } else for (const item of rec.items) {
      const decision = this.decisionFor(rec, item);
      item.status = decision.behavior === "allow" ? status : status === "expired" ? "expired" : "denied";
      if (item.resolve) item.resolve(decision);
      else this.preDecided.set(item.toolUseId, { fingerprint: item.fingerprint, decision, cls: item.cls });
      this.ctxByToolUse.delete(item.toolUseId);
    }
    this.persist();
    this.settled = [...this.settled, rec.id].slice(-LIMITS.settledApprovalsMax);
    if (this.d.bots.has(rec.botId)) {
      const entry = this.d.bots.getEntry(rec.botId, rec.entryId);
      if (entry && entry.kind === "send-message") this.d.bots.updateEntry(rec.botId, { ...entry, message: { type: "auto-review-approval", approval: this.view(rec) } });
      const next = [...this.records.values()].filter((r) => r.botId === rec.botId && r.status === "pending").at(-1);
      this.d.bots.setAwaiting(rec.botId, next ? { tabId: "auto-review", reason: STR.approvalNeeded(next.items[0]!.summary), since: next.createdAt } : null);
    }
  }

  expireAll(botId: string, cause: ExpireCause): void {
    // Bug B: a host restart (quiesce) keeps the card answerable when it can be kept on disk; the new process restores it.
    // A new user message (user_redirect), Stop and a deleted Bot still withdraw it, with their own reason.
    if (cause === "quiesce" && this.d.persistFile) {
      for (const r of this.records.values()) if (r.botId === botId && r.status === "pending") this.detach(r);
      return;
    }
    for (const r of this.records.values()) if (r.botId === botId && r.status === "pending") this.settle(r, "expired", cause);
  }

  forgetBot(botId: string): void {
    this.expireAll(botId, "session_end");
    for (const [id, r] of this.records) if (r.botId === botId) this.records.delete(id);
    for (const [tu, c] of this.ctxByToolUse) if (c.slot.botId === botId) this.ctxByToolUse.delete(tu);
  }

  /** APR-10: a settings change ends pending cards; the review cache is cleared too (§01.8). */
  settingsChanged(): void {
    for (const r of this.records.values()) if (r.status === "pending") this.settle(r, "expired", "settings_change");
    this.d.reviewer.clearCache();
  }

  /** EVT-17: cards persisted as pending by a previous host process become expired (cause quiesce). */
  expirePersistedCards(): void {
    // Bug B: cards the previous process kept on disk come back pending (detached) and answerable; only a card with
    // no saved record (an older build, or no persist file) is expired as before.
    this.restore();
    for (const botId of this.d.bots.ids()) {
      for (const e of this.d.bots.tail(botId, 500)) {
        if (e.kind !== "send-message" || e.message.type !== "auto-review-approval" || e.message.approval.status !== "pending") continue;
        if (this.records.get(e.message.approval.approvalId)?.status === "pending") continue;
        this.d.bots.updateEntry(botId, { ...e, message: { type: "auto-review-approval", approval: { ...e.message.approval, status: "expired", cause: "quiesce", settledAt: this.now() } } });
      }
      const next = [...this.records.values()].filter((r) => r.botId === botId && r.status === "pending").at(-1);
      this.d.bots.setAwaiting(botId, next ? { tabId: "auto-review", reason: STR.approvalNeeded(next.items[0]!.summary), since: next.createdAt } : null);
    }
  }
}
