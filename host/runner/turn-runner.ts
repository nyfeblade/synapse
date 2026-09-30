import { TEXT } from "../review/texts";
import { outsideLog } from "../review/outside-log";
import { OWNER_SOURCES } from "../review/full-auto-intent";
import { originOf } from "../approvals/origin";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_BOT_MODEL, LIMITS, STR, STR_COST, activityEntryId, isAgentMessage, userEntryId, voiceLowEffort,
  type EmailInMeta, type ModelId, type TranscriptEntry, type ToolCallEntry, type UserAttachmentEntry, type UserMessageEntry,
} from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { ConformanceFlags } from "../brain/conformance/flags";
import { classifyThrown } from "../brain/errors";
import { SEND_TOOL } from "../brain/tool-policy";
import type { ModelRouter } from "../brain/model-router";
import type {
  BotToolDef, BotToolResult, BrainWiring, Lane, ModelMessage, PreToolDecision, ToolCall, TurnEvent, TurnResult, WakeSource,
} from "../brain/types";
import { messageText, ZERO_USAGE } from "../brain/types";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { Redactor } from "../history/archive";
import { bodyFor, extractPartialContent, iconFor, isHiddenActivity, metricFor, stepTarget, stepText } from "../presence/activity";
import type { PresenceTracker } from "../presence/presence";
import type { HostSettingsStore } from "../store/host-settings";
import type { Supervisor } from "../supervisor/supervisor";
import { createBotTools } from "../tools/bot-tools";
import type { BotToolExtensions } from "../tools/registry";
import type { RunTask } from "../transcript/run-scheduler";
import { RunScheduler } from "../transcript/run-scheduler";
import type { TrayService } from "../trays/trays";
import { log } from "../util/log";
import { sleep } from "../util/sleep";
import type { AckLedger } from "./ack-ledger";
import { createBotWiring, type ApprovalGateLike } from "./bot-wiring";
import { CreationLedger } from "./creation-ledger";
import { isGenuinelyCutOff } from "./discipline";
import type { BotToolDeps } from "../tools/bot-tools";
import type { TurnHooks } from "./hooks";
import { notifyEvent, notifySettled, type TurnObserver as ModuleObserver } from "./observers";
import {
  ackRedriveText, clockReminder, collectHiddenTurn, collectUserTurn, HIDDEN_MARKER, kickstartText, loopContinueText, nudgeText, renderBotPrompt, restartResumeText,
} from "./prompt-collector";
import { LOOP_HELD, LoopGuard, type LoopTrip } from "./loop-guard";
import type { ResumeLedger } from "./resume-ledger";
import type { SendAcceptanceLedger } from "./send-acceptance";
import { countsAsSideEffect, type TurnContext } from "./turn-context";
import type { RoomReview } from "../groups/member-prompt";
import { newSlot, type TurnSlot } from "./turn-slot";
import { classifySteer, type SteerIntent } from "./steer-intent";
import { steerLetsThrough } from "./steer-policy";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { isLean, TaskClock } from "../engineering/lean-profile";
import { ttft } from "../util/ttft-trace";
import { botCodeDir } from "../walls/bot-uid";

/**
 * Review of new-user walk finding 3: a call ends "stopped" only when Stop cut it short — its approval was withdrawn by
 * Stop, or it was interrupted — never merely because it failed on its own while a Stop was pending.
 */
export function cutByStop(isError: boolean, stopRequested: boolean, output: unknown): boolean {
  if (!isError || !stopRequested) return false;
  const text = typeof output === "string" ? output : "";
  return text.startsWith(TEXT.expired.stopped ?? "\u0000") || /\b(interrupt(ed)?|abort(ed)?|cancell?ed)\b/i.test(text);
}

export type ExpireCause = "user_redirect" | "quiesce" | "session_end" | "settings_change" | "ttl" | "stopped";

export type { ApprovalGateLike } from "./bot-wiring";

export interface RunnerDeps {
  cfg: HostConfig;
  bots: BotService;
  acks: AckLedger;
  sendAcceptance: SendAcceptanceLedger;
  trays: TrayService;
  presence: PresenceTracker;
  settings: HostSettingsStore;
  resume: ResumeLedger;
  flags(): ConformanceFlags;
  now?: () => number;
  timings?: { ackRedriveIdleMs?: number; retryBaseMs?: number };
  /** Awaited before every turn; the host uses it to hold turns until first-boot conformance finishes (§13.1). */
  beforeTurn?: () => Promise<void>;
  /** Bug 364: why no Bot turn may start right now (the box firewall is missing), or null. Refused turns are dropped with a tray. */
  turnBlocked?: () => Promise<string | null>;
  /** Phase 3 (T28): appended after the base system prompt, inside the same promptSnapshot render so the epoch freeze (CTX-03) still applies. */
  extraSystemAppend?(botId: string): string;
  /** Phase 3 (T28): Bot tools beyond the Phase 1 four (Screenshot, request_box_help, Shell/AwaitShell, Task/…). */
  extraTools?(botId: string): BotToolDef[];
  /** Phase 3 (T28): SendMessage types beyond "text" (secret-request, card). */
  extraSendHandlers?(botId: string): BotToolDeps["sendHandlers"];
  /** Phase 3 (T28): wraps the Bot's BrainWiring with secret redaction and the disk reminder. */
  wrapWiring?(botId: string, wiring: BrainWiring): BrainWiring;
  hooks?: TurnHooks;
  toolExtensions?: BotToolExtensions;
  metrics?: { bump(botId: string, field: "coalescedTurns"): void };
  /** Phase 5 seams: modules observe turns without owning the single `hooks` slot, append their own
   *  system-prompt notes, and wrap/add bot tools (an extra tool with an existing name replaces it). */
  observers?: ModuleObserver[];
  systemAppendExtras?: (botId: string) => string;
  extraBotTools?: (botId: string, slot: () => TurnSlot | null, base: BotToolDef[]) => BotToolDef[];
  /** cost-diet-2 lever 1: the per-turn model router ("Save usage"); absent = every turn on the Bot's own model. */
  router?: Pick<ModelRouter, "decide" | "settled">;
  /** bug 198 fix round 1: the same secret scanner every other Bot-visible string goes through
   *  (transcript-mirror.ts / approval-gate.ts), applied to a tool-call step's own body before it is
   *  stored — a step's Read/Write/Edit/Bash content is stored and streamed exactly like every other
   *  Bot-visible string, and must not carry a secret unredacted just because this path is newer.
   *  fix round 2, finding 1: `Redactor` (host/history/archive.ts) answers `null` while it cannot
   *  redact yet — that must mean "no body", never "store it unredacted". */
  redact?: Redactor;
  /** saving-settings, "Call replies": whether a call this Bot is on is live right now (typed turns during a call run at
   *  low effort under "Fast on the whole call"). Absent = never. */
  callLive?(botId: string): boolean;
}

export interface MaintenanceJob { id: string; run(signal: AbortSignal): Promise<void> }
export type AttachmentInput = Omit<UserAttachmentEntry, "kind" | "id" | "batchId" | "createdAt">;
export interface SendOpts {
  attachmentEntries?: AttachmentInput[];
  replyToId?: string;
  skillIds?: string[];
  /** CHAT-08 voice tag, PLG-06 mention hints. */
  voiceDurationMs?: number;
  /** Bug 101: spoken in voice mode (a call): the turn asks for a brief, spoken-style reply. */
  voiceCall?: boolean;
  hints?: string[];
  /** 4.3 Email in: the owner emailed this task. `text` is only their own added words; `email.quoted` is outside content. */
  email?: EmailInMeta;
}

export interface HiddenSpec {
  source: WakeSource;
  lane: Lane;
  text: string;
  silenceAllowed: boolean;
  head?: boolean;
  ackToken?: string | null;
  userSeqMax?: number;
  nudgeRound?: number;
  /** 0.1.4: a follow-up (a reply or closing nudge) of a turn the owner didn't start: the reviewer, Full auto's
   *  intent rule, plans and trusted sends follow the causing turn's source, never the nudge's owner-like one. */
  origin?: FollowUpOrigin;
  /** EVT-16: the wake's turn has actually started. Durable background work (a shell exit code, a
   *  subagent report) clears its pending-wake marker here, not at enqueue time — until this fires the
   *  result exists only as an in-memory scheduler task that a quit or a crash discards. */
  onStart?(): void;
  /** The queued wake was removed (Stop, delete, quiesce, dropQueued) before it ever ran. */
  onDropped?(): void;
}

/** What a synthetic follow-up turn inherits from the turn that caused it (like a subagent's parent origin). */
export interface FollowUpOrigin { source: WakeSource; wakeText: string; context: Pick<TurnContext, "wake" | "routineRun">; roomReview?: RoomReview }

/**
 * 0.1.4: the origin a follow-up of this turn must carry, or null when the owner caused it (it stays an owner turn).
 * Only a turn whose own (or inherited) source is an owner source is owner-caused; MCP, routines, outside events,
 * other Bots, broadcasts, approval resumes and every revival keep their non-owner origin through any nudge.
 */
export function followUpOrigin(slot: TurnSlot, source: WakeSource): FollowUpOrigin | null {
  const cause = slot.reviewSource ?? source;
  if (originOf(cause) === "user" && OWNER_SOURCES.has(cause)) return null;
  return { source: cause, wakeText: slot.wakeText, context: { wake: slot.context.wake, routineRun: slot.context.routineRun }, ...(slot.roomReview ? { roomReview: slot.roomReview } : {}) };
}

/** Phase 4 (EVT-01/EVT-02): a typed wake for anything that isn't the user's own message. */
export interface WakeSpec {
  id?: string;
  source: WakeSource;
  lane: Lane;
  silenceAllowed: boolean;
  head?: boolean;
  groupMember?: boolean;      // EVT-03: sorts after the Bot's own user-lane work
  /** Voice calls: a group member answering a spoken post (low effort, own model). */
  voiceCall?: boolean;
  hidden?: boolean;           // default true
  context?: Partial<TurnContext>;
  prompt(): ModelMessage[];   // built when the task is dequeued, so inbox folds and digests are current
  onStart?(slot: TurnSlot): void;
  onSettle?(slot: TurnSlot, result: TurnResult | null): void;
  onDropped?(): void;         // the queued wake was removed (Stop, delete, quiesce, dropQueued) before it ran
  ackToken?: string | null;
}
export interface TurnObserver {
  onTurnStart?(botId: string, slot: TurnSlot): void;
  onBeforeFirstVisible?(botId: string, slot: TurnSlot): void;
  onSettle?(botId: string, slot: TurnSlot, result: TurnResult | null): void;
}
/**
 * `slot` is `null` when postToolUse fires with no active turn for this bot — e.g. a direct
 * `wiring(botId).postToolUse()` call before any wake has started (the brief's own Step-1 test does
 * exactly this). That's required, not a mistake: don't assume the non-null `TurnSlot` a literal
 * reading of the brief's Produces line would suggest. Narrow with the exported `hasTurn()` guard
 * before reading turn state (context, counters, …) instead of an ad hoc null-check. (Fix round 1,
 * finding 1 — flagged for Tasks 29/30/38, which register post-tool hooks of their own.)
 */
export type PostToolHook = (botId: string, slot: TurnSlot | null, call: ToolCall, output: string) => string | null;
/** Type guard for `PostToolHook` implementations: narrows `TurnSlot | null` to `TurnSlot`. See the doc
 *  comment on `PostToolHook` above for when and why `slot` can be null. */
export function hasTurn(slot: TurnSlot | null): slot is TurnSlot {
  return slot !== null;
}
export type ToolProvider = (botId: string, slot: () => TurnSlot | null) => BotToolDef[];
export type StateTargetHandler = (botId: string, slot: TurnSlot | null, args: Record<string, unknown>) => Promise<BotToolResult>;
export type SendRouter = (botId: string, slot: TurnSlot, args: Record<string, unknown>) => Promise<BotToolResult> | null;
export interface PromptDecorator { (botId: string, info: { source: WakeSource; silenceAllowed: boolean; lane: Lane }): ModelMessage | null }
export type RecipientState = "idle" | "user" | "agent" | "background" | "group-member" | "parked";

interface TurnSpec {
  lane: Lane;
  source: WakeSource;
  hidden: boolean;
  silenceAllowed: boolean;
  prompt: ModelMessage[];
  userSeqMax: number;
  ackToken: string | null;
  acceptedAtMs: number;
  nudgeRound: number;
  replyTo?: string | null;
  userTexts?: string[];
  /** The newest user message was spoken in a voice call. */
  voiceCall?: boolean;
  context?: Partial<TurnContext>;
  /** 0.1.4: see HiddenSpec.origin. */
  origin?: FollowUpOrigin;
  onStart?(slot: TurnSlot): void;
  onSettle?(slot: TurnSlot, result: TurnResult | null): void;
  /** The turn never started (the Bot is gone, or no supervisor lease was granted), so onSettle never fires. */
  onDropped?(): void;
}

const userMessage = (e: TranscriptEntry | null): e is UserMessageEntry => e !== null && e.kind === "message" && !isAgentMessage(e);

/** Bug 198: a user message sent while a turn runs, waiting for that turn's next safe point (or its end). */
interface SteerItem {
  seq: number; entryId: string; intent: SteerIntent;
  /** A question ("how long?"): only a SendMessage with reply_to this message answers it. */
  question: boolean;
  /** Its content can't ride a note (a file, a skill, or past the note's limits): it reaches the Bot at turn end. */
  needsTurn: boolean;
  delivered: boolean;
  answered: boolean;
}

/** Bug 198: a side-effect call the Bot made before reading the user's new message is held, not run. */
const STEER_HELD = "Not run: the user just sent you a message (in the note with this result). Read it first, then make this call again if it still fits.";
const escapeSteer = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface BotRuntime {
  scheduler: RunScheduler; slot: TurnSlot | null; wiring: BrainWiring; redrive: ReturnType<typeof setTimeout> | null;
  deleted: boolean; maintenance: AbortController | null;
  /** Bug 198: messages steering the running turn, oldest first. Emptied when the turn ends (flushSteer). */
  steer: SteerItem[];
  /** Bug 198: SendMessage calls in flight → the steering messages already delivered when each was made.
   *  Cleared when the turn ends, is stopped or is interrupted. */
  steerSends: Map<string, SteerItem[]>;
  /** 5.7: stopped on repeated failure. While set, no new turn of this Bot starts (queued ones wait, never dropped)
   *  and every tool call is refused; Continue, Stop, or a new message from the user clears it. */
  loopHold: LoopHold | null;
}

interface LoopHold { trayId: string; trip: LoopTrip; lane: Lane; owed: boolean; origin: FollowUpOrigin | null }

const MAX_PROMPT_CHARS = 100_000;

export class TurnRunner {
  private rt = new Map<string, BotRuntime>();
  /** Box maintenance: no new turn starts while true (holdNewTurns). */
  private held = false;
  private supervisor: Supervisor | null = null;
  private gate: ApprovalGateLike | null = null;
  private now: () => number;
  private creations: CreationLedger;
  // Phase 4 extension registries (Task 2).
  private providers: ToolProvider[] = [];
  private stateTargets: Record<string, StateTargetHandler> = {};
  private sendRouters: SendRouter[] = [];
  private observers: TurnObserver[] = [];
  private postHooks: PostToolHook[] = [];
  private decorators: PromptDecorator[] = [];
  private taskClock = new TaskClock();
  /** 5.7: stop on repeated failure, for every brain (it reads the turn's events, never a prompt). */
  private loops: LoopGuard;
  private dropCbs = new Map<string, () => void>();
  private sections: ((botId: string) => string | null)[] = [];
  /** Bug 142: while true for a Bot (on a fast-path call), its full session's streamed text isn't published. */
  private quietPartials: ((botId: string) => boolean) | null = null;

  constructor(private d: RunnerDeps) {
    this.now = d.now ?? Date.now;
    this.loops = new LoopGuard(this.now);
    this.creations = new CreationLedger(path.join(d.cfg.hostPrivate, "bot-creations.json"), this.now);
    // A Bot mid-turn keeps the teammates list from its spawn: Bot-list changes ride the next tool result.
    this.postHooks.push((botId) => {
      const r = this.d.bots.takeRosterUpdate(botId);
      return r ? `<system_reminder>${r}</system_reminder>` : null;
    });
    // Bug 198: a message the user sent while the Bot works rides the next tool result (the safe point
    // between tool calls), so the Bot sees it without the turn being cut off.
    this.postHooks.push((botId, slot) => (slot ? this.deliverSteer(botId, slot) : null));
    d.bots.onBeforeVisibleAppend((botId) => {
      const s = this.slot(botId);
      if (!s || s.visibleWritten) return;
      s.visibleWritten = true;
      for (const o of this.observers) o.onBeforeFirstVisible?.(botId, s);
    });
  }

  /** The profile-update and Bot-list reminders, taken once (the Bot-list one may already have ridden a tool result mid-turn). */
  private pendingReminder(botId: string): string | null {
    return [this.d.bots.takeModeUpdate(botId), this.d.bots.takeProfileUpdate(botId), this.d.bots.takeRosterUpdate(botId)].filter(Boolean).join("\n") || null;
  }

  private get h(): TurnHooks {
    return this.d.hooks ?? {};
  }

  attach(supervisor: Supervisor, gate: ApprovalGateLike): void {
    this.supervisor = supervisor;
    this.gate = gate;
  }

  // ---------- Phase 4 extension points (Task 2) ----------
  registerToolProvider(p: ToolProvider): void { this.providers.push(p); }
  registerStateTarget(target: string, h: StateTargetHandler): void { this.stateTargets[target] = h; }
  registerSendRouter(r: SendRouter): void { this.sendRouters.push(r); }
  addObserver(o: TurnObserver): void { this.observers.push(o); }
  addPostToolHook(h: PostToolHook): void { this.postHooks.push(h); }
  addPromptDecorator(d: PromptDecorator): void { this.decorators.push(d); }
  /** Extra sections of the appended system prompt (RTN-21 routine list). They are frozen with the prompt snapshot. */
  addSystemSection(fn: (botId: string) => string | null): void { this.sections.push(fn); }
  /** Bug 142: the voice fast path speaks through the Bot's voice alone; the full session's stream stays unpublished. */
  setQuietPartials(fn: ((botId: string) => boolean) | null): void { this.quietPartials = fn; }

  /** ORIG-09 §09.8 recipient states. */
  recipientState(botId: string): RecipientState {
    const s = this.rt.get(botId)?.slot;
    if (!s) return "idle";
    if (s.awaitingUserSelection || (this.d.bots.has(botId) && this.d.bots.summary(botId).awaiting)) return "parked";
    if (s.context.group) return "group-member";
    return s.lane;
  }

  queued(botId: string, pred: (t: RunTask) => boolean): number {
    const r = this.rt.get(botId);
    if (!r) return 0;
    return (["user", "agent", "background"] as const).reduce((n, lane) => n + r.scheduler.pending(lane).filter(pred).length, 0);
  }

  dropQueued(botId: string, pred: (t: RunTask) => boolean): void {
    const r = this.rt.get(botId);
    if (!r) return;
    this.notifyDropped(r, pred);
    r.scheduler.drop(pred);
  }

  /** Calls WakeSpec.onDropped for queued wakes that are about to be removed. */
  private notifyDropped(r: BotRuntime, pred: (t: RunTask) => boolean): void {
    for (const lane of ["user", "agent", "background"] as const) {
      for (const t of r.scheduler.pending(lane)) {
        if (!pred(t)) continue;
        const cb = this.dropCbs.get(t.id);
        this.dropCbs.delete(t.id);
        cb?.();
      }
    }
  }

  /** EVT-14 + ORIG-09 §09.8: interrupt agent/background/group-member runs only; never user-lane or parked runs. */
  async interruptForPriority(botId: string, reason: string): Promise<boolean> {
    const st = this.recipientState(botId);
    if (st === "agent" || st === "background" || st === "group-member") {
      await this.interruptActive(botId, reason);
      return true;
    }
    return false;
  }

  /** Phase 4 (EVT-01): enqueue a typed wake (agent delivery, routine fire, revival, …). Returns the wake's id. */
  enqueueWake(botId: string, spec: WakeSpec): string {
    const id = spec.id ?? `${spec.source}-${randomUUID()}`;
    if (!this.d.bots.has(botId)) return id;
    const r = this.runtime(botId);
    if (spec.onDropped) this.dropCbs.set(id, spec.onDropped);
    r.scheduler.enqueue(
      {
        id, lane: spec.lane, source: spec.source, acceptedAtMs: this.now(), groupMember: spec.groupMember,
        run: async () => {
          this.dropCbs.delete(id);
          if (r.deleted || !this.d.bots.has(botId)) { spec.onDropped?.(); return; }
          const hidden = spec.hidden ?? true;
          const body = spec.prompt();
          const profileUpdate = this.pendingReminder(botId);
          const prompt = hidden
            ? this.hiddenPrompt(body, profileUpdate)
            : [...(profileUpdate ? [{ text: `<system_reminder>${profileUpdate}</system_reminder>` }] : []), ...body];
          await this.execute(botId, {
            lane: spec.lane, source: spec.source, hidden, silenceAllowed: spec.silenceAllowed, nudgeRound: 0, prompt,
            userSeqMax: 0, ackToken: spec.ackToken ?? null, acceptedAtMs: this.now(),
            context: spec.context, onStart: spec.onStart, onSettle: spec.onSettle, onDropped: spec.onDropped,
            ...(spec.voiceCall ? { voiceCall: true } : {}),
          });
        },
      },
      { head: spec.head },
    );
    return id;
  }

  /** A hidden wake's first message gets `[HIDDEN_PROMPT]` only when it doesn't already start with it. */
  private hiddenPrompt(body: ModelMessage[], profileUpdate: string | null): ModelMessage[] {
    const out: ModelMessage[] = profileUpdate ? [{ text: `<system_reminder>${profileUpdate}</system_reminder>` }] : [];
    body.forEach((m, i) => out.push(i === 0 && "text" in m && !m.text.startsWith(HIDDEN_MARKER) ? { text: `${HIDDEN_MARKER}\n${m.text.trim()}` } : m));
    return out;
  }

  /**
   * EVT-05 / EVT-12: reminders go above the prompt for silence-allowed wakes, below it (before the reply reminder) otherwise.
   * Bug #50: every turn — user, wake, routine, nudge, kickstart — opens with the clock, read from `now`
   * as the turn is dispatched. It is added here, the one path every turn takes, so no wake can be
   * written without it. A user turn keeps its messages first and the reply reminder last, so the
   * clock sits with the other reminders just before it; a wake has no reply reminder, and its own
   * text stays last, so the clock leads it.
   */
  private decorate(botId: string, spec: TurnSpec): ModelMessage[] {
    const clock: ModelMessage[] = this.clockDue(botId) ? [{ text: clockReminder(this.now(), this.d.settings.timeZone()) }] : [];
    const extra = this.decorators
      .map((d) => d(botId, { source: spec.source, silenceAllowed: spec.silenceAllowed, lane: spec.lane }))
      .filter((m): m is ModelMessage => m !== null);
    if (spec.source === "user" && !spec.silenceAllowed) return [...spec.prompt.slice(0, -1), ...clock, ...extra, ...spec.prompt.slice(-1)];
    if (spec.silenceAllowed) return [...clock, ...extra, ...spec.prompt];
    return [...clock, ...spec.prompt, ...extra];
  }

  /** S1 lean engineering profile: engineering mode sends the clock on a task's first turn only (TaskClock); standard, every turn. */
  private clockDue(botId: string): boolean {
    if (!isLean(this.d.bots.summary(botId).settings)) {
      this.taskClock.forget(botId);
      return true;
    }
    return this.taskClock.opensTask(botId, this.now(), this.d.bots.sessionId(botId));
  }

  private mergedTools(botId: string, base: BotToolDef[]): BotToolDef[] {
    const byName = new Map(base.map((t) => [t.name, t]));
    for (const p of this.providers) for (const t of p(botId, () => this.slot(botId))) byName.set(t.name, t);
    return [...byName.values()];
  }

  private sup(): Supervisor {
    if (!this.supervisor) throw new Error("TurnRunner not attached");
    return this.supervisor;
  }
  private g(): ApprovalGateLike {
    if (!this.gate) throw new Error("TurnRunner not attached");
    return this.gate;
  }

  private runtime(botId: string): BotRuntime {
    let r = this.rt.get(botId);
    if (r) return r;
    // Phase 1/2 tools + Phase 3 extras; Phase 5 modules may add or replace by name; Phase 4 providers merge last (mergedTools).
    // Rebuilt on every read, not frozen at first use: a Phase 5 module's tool list can depend on durable
    // state (PLG-01 mounts the eight manage-an-installed-connector tools once a connector exists), and a
    // set computed once here would have pinned every Bot to whatever was true the first time it ran.
    // Cheap: this is read a handful of times per turn (spawn, the spawn key), not per tool call.
    const tools = (): BotToolDef[] => {
      const base = [
        ...createBotTools({
          botId, slot: () => this.slot(botId), bots: this.d.bots, acks: this.d.acks, creations: this.creations, now: this.now,
          createBot: (a: { name: string; description?: string; model?: ModelId }) => this.d.bots.create({ ...a, origin: "bot", kickstart: false }),
          ext: this.d.toolExtensions,
          sendHandlers: this.d.extraSendHandlers?.(botId),
          stateTargets: () => this.stateTargets,
          sendRouters: () => this.sendRouters,
        }),
        ...(this.d.extraTools?.(botId) ?? []),
      ];
      const extra = this.d.extraBotTools?.(botId, () => this.slot(botId), base) ?? [];
      return [...base.filter((t) => !extra.some((x) => x.name === t.name)), ...extra];
    };
    const scheduler = new RunScheduler({
      onWatchdogInterrupt: () => void this.interruptActive(botId, "watchdog"),
      onEscape: (t) => log.warn("run escaped the watchdog", { botId, task: t.id }),
      onIdle: () => this.onIdle(botId),
      hold: () => this.held || Boolean(this.rt.get(botId)?.loopHold),
    });
    const baseWiring = createBotWiring({
      botId, slot: () => this.slot(botId), gate: () => this.g(), tools: () => this.mergedTools(botId, tools()), flags: this.d.flags,
      hooks: () => this.h, postToolHooks: () => this.postHooks, now: this.now,
      steerGate: (call) => this.steerGate(botId, call),
    });
    r = {
      scheduler, slot: null, redrive: null, deleted: false, maintenance: null, steer: [], steerSends: new Map(), loopHold: null,
      wiring: this.d.wrapWiring ? this.d.wrapWiring(botId, baseWiring) : baseWiring,
    };
    this.rt.set(botId, r);
    return r;
  }

  wiring(botId: string): BrainWiring {
    return this.runtime(botId).wiring;
  }

  slot(botId: string): TurnSlot | null {
    return this.rt.get(botId)?.slot ?? null;
  }

  /**
   * Box maintenance (portable install, fix round 1): while the Bots' computer is re-provisioned, no NEW turn
   * starts on any Bot — user messages, routines and wakes are accepted and queued (never dropped: a user's
   * message is also a durable ack obligation, so even a host restart in the middle answers it at boot) —
   * and turns already running finish. Released, every held queue runs.
   */
  holdNewTurns(on: boolean): void {
    if (this.held === on) return;
    this.held = on;
    log.info(on ? "box maintenance: holding new turns" : "box maintenance: over; running held turns");
    if (!on) for (const r of this.rt.values()) if (!r.deleted) r.scheduler.resume();
  }

  newTurnsHeld(): boolean { return this.held; }

  /** Bug 258: when the user last sent a message to any Bot (a background box update waits 5 minutes after it). */
  private lastUserMessage: number | null = null;
  lastUserMessageAt(): number | null { return this.lastUserMessage; }

  /** A turn is running on this Bot right now (queued-but-held turns are not). */
  isRunning(botId: string): boolean {
    return this.rt.get(botId)?.scheduler.running() ?? false;
  }

  isIdle(botId: string): boolean {
    const r = this.rt.get(botId);
    return !r || r.scheduler.isIdle();
  }

  systemAppend(botId: string): string {
    const base = this.d.bots.promptSnapshot(botId, () =>
      [this.renderBase(botId), ...this.sections.map((f) => f(botId)), this.d.extraSystemAppend?.(botId)].filter((x): x is string => Boolean(x)).join("\n\n"),
    );
    // Phase 5: appended outside the frozen snapshot, so a module's notes can follow durable state
    // (a connector being installed) without waiting for the compaction epoch to bump. It is still ONE
    // system block to the API and therefore one prompt-cache unit: text that changes between two turns
    // of a session re-writes the whole block. See host/test/perf/prompt-stability.test.ts.
    const extra = this.d.systemAppendExtras?.(botId)?.trim();
    return extra ? `${base}\n\n${extra}` : base;
  }

  private renderBase(botId: string): string {
    const me = this.d.bots.summary(botId);
    const teammates = this.d.bots.list().filter((b) => b.id !== botId).map((b) => ({
      id: b.id, name: b.profile.name, title: b.profile.title, description: b.profile.description,
      ...(b.group ? { group: { memberNames: b.group.memberIds.map((m) => (this.d.bots.has(m) ? this.d.bots.summary(m).profile.name : m)) } } : {}),
    }));
    return renderBotPrompt({
      profile: me.profile, timeZone: this.d.settings.timeZone(), teammates, workspace: this.d.cfg.workspace, codeDir: botCodeDir(this.d.cfg, botId),
      sections: this.h.promptSections?.(botId) ?? { memory: "", skills: "" },
    });
  }

  // ---------- wakes ----------
  sendPrompt(botId: string, text: string, clientNonce: string, opts: SendOpts = {}): { entryId: string } {
    this.d.bots.require(botId);
    const attachments = opts.attachmentEntries ?? [];
    if (!text.trim() && !attachments.length && !opts.skillIds?.length && !opts.email) throw new GatewayError("EMPTY_MESSAGE", "The message is empty.");
    if (text.length > MAX_PROMPT_CHARS) throw new GatewayError("MESSAGE_TOO_LONG", "The message is too long.");
    const acc = this.d.sendAcceptance.check(botId, clientNonce, text);
    if (acc.kind === "duplicate") return { entryId: acc.entryId };
    const r = this.runtime(botId);
    // Bug 198: while a turn runs, a message steers it (delivered at its next safe point) instead of
    // cancelling it — unless it says stop, or the turn is one a message has always interrupted.
    const intent = classifySteer(text);
    const active = r.slot;
    const steering = active !== null && intent !== "stop" && this.steerable(botId, active, opts);
    const seq = this.d.bots.nextUserSeq(botId);
    const id = userEntryId(seq);
    const createdAt = this.now();
    const entry: UserMessageEntry = {
      kind: "message", id, role: "user", content: text, clientNonce, createdAt,
      ...(opts.replyToId ? { replyToId: opts.replyToId, branched: true } : {}),
      ...(attachments.length ? { attachmentEntryIds: attachments.map((_, k) => `${id}a${k + 1}`) } : {}),
      ...(opts.skillIds?.length ? { skillIds: opts.skillIds } : {}),
      ...(opts.voiceDurationMs || opts.voiceCall ? { voice: { durationMs: Math.round(opts.voiceDurationMs ?? 0), ...(opts.voiceCall ? { call: true } : {}) } } : {}),
      ...(opts.hints?.length ? { hints: opts.hints.slice(0, 5) } : {}),
      ...(steering ? { steer: "queued" as const } : {}),
      ...(opts.email ? { email: opts.email } : {}),
    };
    // 4.3: the forwarded part of an emailed task is outside content from this moment, for Full auto's checks (bug 415).
    if (opts.email) outsideLog.record(botId, [opts.email.subject, opts.email.quoted, opts.email.attachments.join("\n")].filter(Boolean).join("\n"), createdAt);
    this.d.bots.appendEntry(botId, entry);
    attachments.forEach((a, k) => this.d.bots.appendEntry(botId, { kind: "user-attachment", ...a, id: `${id}a${k + 1}`, batchId: id, createdAt }));
    this.d.sendAcceptance.record(botId, clientNonce, text, entry.id);
    if (text.trim() && !opts.email) this.d.bots.seedNameIfDefault(botId, text);
    this.d.bots.bumpUserMessageEpoch(botId);
    this.lastUserMessage = createdAt;
    this.d.acks.record(botId);
    this.d.trays.clearForBot(botId);
    this.releaseLoopHold(botId, r); // 5.7: the user is here and has spoken: that answers the stop
    r.maintenance?.abort(); // EVT-09: a user message interrupts maintenance, too
    if (steering) {
      // No scheduler task while the turn runs: a queued user task arms the run watchdog, which would cut
      // the long turn off after runWatchdogMs. The turn's end enqueues one if anything is still owed.
      // Pending approval cards stay: the user may still answer them, and the turn is not redirected.
      r.steer.push({
        seq, entryId: entry.id, intent, question: intent === "status" || /\?\s*$/.test(text), delivered: false, answered: false,
        needsTurn: attachments.length > 0 || Boolean(opts.skillIds?.length) || r.steer.filter((m) => !m.delivered).length >= LIMITS.steerQueueMax,
      });
      return { entryId: entry.id };
    }
    ttft.start(botId);
    this.g().expireAll(botId, "user_redirect");
    if (active && intent === "stop") active.stopRequested = true;
    // The new turn carries every unconfirmed message, the steering ones included.
    this.releaseSteer(botId, r, "delivered");
    if (active?.dispatched) void this.interruptActive(botId, "superseded by a new user message");
    r.scheduler.enqueue({ id: entry.id, lane: "user", source: "user", acceptedAtMs: createdAt, run: () => this.runUserTurn(botId, seq) });
    return { entryId: entry.id };
  }

  /** Bug 198: turns a new message steers rather than interrupts: the Bot's own work on the user's request
   *  (a user-source turn). Hidden and background turns (wakes, nudges, redrives, resumes) keep the interrupt
   *  and the run watchdog; so do a voice call (barge-in), a group member's turn, a turn parked on a
   *  question, and any turn while an approval card is pending (the message may answer or overrule it).
   *  A turn already being stopped or quiesced takes nothing more. */
  private steerable(botId: string, s: TurnSlot, opts: SendOpts): boolean {
    return !opts.voiceCall && s.source === "user" && !s.hidden && !s.context.group && !s.awaitingUserSelection && !s.quiescing && !s.stopRequested
      && !(this.g().pendingCount?.(botId) ?? 0);
  }

  /** Bug 198, defence in depth: a side-effect call made while a message is still unread is held, and the
   *  note rides beside the denial; so is every other side-effect call from the same model message. */
  private steerGate(botId: string, call: ToolCall): PreToolDecision | null {
    const r = this.rt.get(botId);
    // 5.7: stopped on repeated failure: nothing more runs until the user answers (the interrupt may land after a call).
    if (r?.loopHold) return { decision: "deny", reason: LOOP_HELD };
    const slot = r?.slot;
    // Fail closed (fix round 2): only the read-only allowlist runs while a message is unread or its note is
    // still on its way to the model; everything else, unknown tools included, is held.
    if (!r || !slot || steerLetsThrough(call)) return null;
    const note = r.steer.some((m) => !m.delivered) ? this.deliverSteer(botId, slot) : null;
    if (note) return { decision: "deny", reason: STEER_HELD, additionalContext: note };
    if (slot.steerHold) return { decision: "deny", reason: STEER_HELD };
    return null;
  }

  /** Bug 198: shows every undelivered message to the running turn, oldest first, as a note beside the tool
   *  result just returned (or beside a held call). The user's words sit in a tag carrying this turn's random
   *  nonce, escaped, so text in a tool's output can't pass for them. What can't ride the note — a file, a
   *  skill, anything past LIMITS.steerQueueMax / steerNoteMaxChars, and everything after it, to keep the
   *  order — is counted in the note and reaches the Bot in a user turn when this turn ends. */
  private deliverSteer(botId: string, slot: TurnSlot): string | null {
    const r = this.rt.get(botId);
    if (!r || r.slot !== slot || slot.stopRequested || slot.quiescing) return null;
    const batch = r.steer.filter((m) => !m.delivered);
    if (!batch.length) return null;
    slot.steerNonce ??= randomBytes(6).toString("hex");
    const lines: string[] = [];
    let chars = 0;
    let overflow = 0;
    for (const m of batch) {
      m.delivered = true;
      const e = this.d.bots.getEntry(botId, m.entryId);
      if (!userMessage(e)) continue;
      this.d.bots.updateEntry(botId, { ...e, steer: "delivered" });
      if (overflow || m.needsTurn || chars + e.content.length > LIMITS.steerNoteMaxChars) {
        m.needsTurn = true;
        overflow += 1;
        continue;
      }
      chars += e.content.length;
      // Mention hints come from the client with the message, so they are escaped inside the same tag.
      const hints = (e.hints ?? []).map((h) => `\n(hint: ${escapeSteer(h)})`).join("");
      lines.push(`<user_steer id="${slot.steerNonce}">[${e.id}] ${escapeSteer(e.content)}${hints}</user_steer>`);
    }
    // Every other non-read-only call of this model message is held until its tool batch ends (PostToolBatch,
    // bot-wiring.ts): the model reads the note only on its next call. Keyed on the hooks, not on tool_start,
    // so it holds whichever order the stream events and the hooks arrive in.
    slot.steerHold = true;
    const kind = batch.some((m) => m.intent === "status" && !m.needsTurn) ? "a status question: say what's done, what's left and roughly how long" : "steering";
    const more = overflow ? `${overflow} more message${overflow === 1 ? "" : "s"} (a file, a skill, or past this note's limit) will reach you when this turn ends; wrap up soon if they may matter.` : "";
    return fillTemplate(loadPrompt("wakes/steer.md"), { KIND: kind, NONCE: slot.steerNonce, MESSAGES: [...lines, more].filter(Boolean).join("\n") }).trim();
  }

  /** Bug 198: a SendMessage that went out after messages were delivered. It covers the plain steering ones;
   *  a question counts as answered only when the send is reply_to that question. */
  private noteSteerAnswer(input: Record<string, unknown>, deliveredBefore: SteerItem[]): void {
    for (const m of deliveredBefore) {
      if (m.answered || m.needsTurn) continue;
      if (!m.question || input.reply_to === m.entryId) m.answered = true;
    }
  }

  /** Bug 198: confirms the answered steering messages that directly follow the confirmed ones (a gap — an
   *  unanswered message — stops it: confirmation is a watermark), and clears the reply obligation when
   *  nothing the user sent is left unanswered. Returns whether something still is. */
  private confirmSteerAnswers(botId: string, items: SteerItem[]): boolean {
    let confirmed = this.d.bots.confirmedUserSeq(botId);
    for (const m of [...items].sort((a, b) => a.seq - b.seq)) {
      if (m.seq <= confirmed) continue;
      if (m.seq !== confirmed + 1 || !m.answered) break;
      confirmed = m.seq;
    }
    this.d.bots.confirmUserSeq(botId, confirmed);
    if (confirmed < this.d.bots.latestUserSeq(botId)) return true;
    const token = this.d.acks.token(botId);
    if (token) this.d.acks.clear(botId, token);
    return false;
  }

  /** Bug 198: empties the steering queue when the turn is cut off. The messages either go to the turn that
   *  now carries them ("delivered"), or are dropped with the rest of the queue by Stop / quiesce (null). */
  private releaseSteer(botId: string, r: BotRuntime, state: "delivered" | null): void {
    const items = r.steer;
    r.steer = [];
    r.steerSends.clear();
    if (!this.d.bots.has(botId)) return;
    if (state && items.length) this.confirmSteerAnswers(botId, items);
    for (const m of items) {
      if (m.delivered) continue;
      const e = this.d.bots.getEntry(botId, m.entryId);
      if (!userMessage(e) || !e.steer) continue;
      const { steer: _old, ...rest } = e;
      this.d.bots.updateEntry(botId, state ? { ...rest, steer: state } : rest);
    }
  }

  /** Bug 198: at a turn's end, anything the user sent during it that is still unanswered — never delivered,
   *  only announced (a file, overflow), or a question nobody replied to — gets one user turn, in order. */
  private flushSteer(botId: string, r: BotRuntime): boolean {
    if (!r.steer.length) return false;
    const items = r.steer;
    r.steer = [];
    if (r.deleted || !this.d.bots.has(botId)) return false;
    if (!this.confirmSteerAnswers(botId, items)) return false;
    const latest = Math.max(...items.map((m) => m.seq));
    r.scheduler.enqueue({ id: `steer-${userEntryId(latest)}`, lane: "user", source: "user", acceptedAtMs: this.now(), run: () => this.runUserTurn(botId, latest) });
    return true;
  }

  /**
   * Bug 142 (voice fast path): a spoken utterance on a call that the Bot's VOICE answers (host/voice/front.ts).
   * It is recorded in the chat like any voice-call message, but no full-session turn runs for it: the voice owns
   * the reply (so nothing is owed: the seq is confirmed at once), and the full session keeps working on whatever
   * it was doing — an utterance never interrupts it, and never expires a pending card (the user may be answering it).
   */
  recordVoiceUtterance(botId: string, text: string, clientNonce: string, o: { durationMs?: number }): { entryId: string } {
    this.d.bots.require(botId);
    if (!text.trim()) throw new GatewayError("EMPTY_MESSAGE", "The message is empty.");
    if (text.length > MAX_PROMPT_CHARS) throw new GatewayError("MESSAGE_TOO_LONG", "The message is too long.");
    const acc = this.d.sendAcceptance.check(botId, clientNonce, text);
    if (acc.kind === "duplicate") return { entryId: acc.entryId };
    const seq = this.d.bots.nextUserSeq(botId);
    const entry: UserMessageEntry = {
      kind: "message", id: userEntryId(seq), role: "user", content: text, clientNonce, createdAt: this.now(),
      voice: { durationMs: Math.round(o.durationMs ?? 0), call: true },
    };
    this.d.bots.appendEntry(botId, entry);
    this.d.sendAcceptance.record(botId, clientNonce, text, entry.id);
    this.d.bots.confirmUserSeq(botId, seq);
    this.d.trays.clearForBot(botId);
    const rt = this.rt.get(botId);
    if (rt) this.releaseLoopHold(botId, rt); // 5.7: the user is on the call and speaking: that answers the stop
    return { entryId: entry.id };
  }

  private async runUserTurn(botId: string, seq: number): Promise<void> {
    if (!this.d.bots.has(botId) || this.runtime(botId).deleted) return;
    if (seq < this.d.bots.latestUserSeq(botId)) return; // EVT-10: the newest message's turn carries this one
    ttft.mark(botId, "dequeued");
    const messages = this.d.bots.userMessagesAfter(botId, this.d.bots.confirmedUserSeq(botId));
    // Bug 198: everything was already answered mid-turn (a steered message the running turn replied to).
    if (!messages.length) return;
    for (const m of messages) if (m.steer === "queued") this.d.bots.updateEntry(botId, { ...m, steer: "delivered" });
    if (messages.length >= 2) this.d.metrics?.bump(botId, "coalescedTurns"); // EVT-10 burst → one turn (USE-05)
    const decorated = messages.map((entry) => ({ entry, ...(this.h.decorateUserMessage?.(botId, entry) ?? { before: [], after: [] }) }));
    const queryText = messages.map((m) => m.content).join("\n");
    const blocks = this.h.turnBlocks?.(botId, { source: "user", hidden: false, silenceAllowed: false, queryText }) ?? [];
    ttft.mark(botId, "turn blocks built (memory recall, restore)");
    await this.execute(botId, {
      lane: "user", source: "user", hidden: false, silenceAllowed: false, nudgeRound: 0,
      prompt: collectUserTurn({ messages: decorated, profileUpdate: this.pendingReminder(botId), blocks }),
      userSeqMax: seq, ackToken: this.d.acks.token(botId), acceptedAtMs: this.now(),
      replyTo: [...messages].reverse().find((m) => m.replyToId)?.replyToId ?? null, userTexts: messages.map((m) => m.content),
      ...(messages.at(-1)?.voice?.call ? { voiceCall: true } : {}),
    });
  }

  /** ORIG-07 §07.7: re-run the newest user turn after an overflow was fixed; the owed reply is still unconfirmed. */
  retryUserTurn(botId: string): boolean {
    if (!this.d.bots.has(botId)) return false;
    const seq = this.d.bots.latestUserSeq(botId);
    if (seq <= this.d.bots.confirmedUserSeq(botId)) return false;
    this.runtime(botId).scheduler.enqueue({ id: `retry-${seq}-${this.now()}`, lane: "user", source: "user", acceptedAtMs: this.now(), run: () => this.runUserTurn(botId, seq) });
    return true;
  }

  kickstart(botId: string): void {
    if (!this.d.bots.introductionPending(botId)) return;
    const r = this.runtime(botId);
    r.scheduler.enqueue({
      id: `kickstart-${botId}`, lane: "user", source: "kickstart", acceptedAtMs: this.now(),
      run: async () => {
        if (!this.d.bots.has(botId) || this.d.bots.latestUserSeq(botId) > 0 || !this.d.bots.introductionPending(botId)) return;
        await this.execute(botId, { lane: "user", source: "kickstart", hidden: true, silenceAllowed: false, nudgeRound: 0, prompt: collectHiddenTurn(kickstartText()), userSeqMax: 0, ackToken: null, acceptedAtMs: this.now() });
      },
    });
  }

  enqueueHidden(botId: string, spec: HiddenSpec): void {
    if (!this.d.bots.has(botId)) {
      spec.onDropped?.();
      return;
    }
    const r = this.runtime(botId);
    const id = `${spec.source}-${randomUUID()}`;
    if (spec.onDropped) this.dropCbs.set(id, spec.onDropped);
    r.scheduler.enqueue(
      {
        id, lane: spec.lane, source: spec.source, acceptedAtMs: this.now(),
        run: async () => {
          this.dropCbs.delete(id);
          if (r.deleted || !this.d.bots.has(botId)) { spec.onDropped?.(); return; }
          await this.execute(botId, {
            lane: spec.lane, source: spec.source, hidden: true, silenceAllowed: spec.silenceAllowed, nudgeRound: spec.nudgeRound ?? 0,
            prompt: collectHiddenTurn(
              spec.text, this.pendingReminder(botId),
              this.h.turnBlocks?.(botId, { source: spec.source, hidden: true, silenceAllowed: spec.silenceAllowed, queryText: spec.text }) ?? [],
            ),
            userSeqMax: spec.userSeqMax ?? 0,
            ackToken: spec.ackToken ?? null, acceptedAtMs: this.now(),
            ...(spec.origin ? { origin: spec.origin, context: { wake: spec.origin.context.wake, routineRun: spec.origin.context.routineRun } } : {}),
            ...(spec.onStart ? { onStart: () => spec.onStart?.() } : {}),
          });
        },
      },
      { head: spec.head },
    );
  }

  // ---------- turn execution ----------
  private async execute(botId: string, spec: TurnSpec): Promise<void> {
    // Every early return below skips onSettle, so whatever queued this turn would wait forever
    // (a routine fire holds a host-wide gate slot until it is told). onDropped is that one report.
    if (!this.d.bots.has(botId)) return spec.onDropped?.();
    await this.d.beforeTurn?.();
    const blocked = await this.d.turnBlocked?.();
    if (blocked) {
      this.d.trays.add({ botId: null, title: blocked, dedupeKey: "box-firewall" });
      return spec.onDropped?.();
    }
    ttft.mark(botId, "beforeTurn gate passed");
    const lease = await this.sup().acquire(botId, spec.lane, spec.acceptedAtMs).catch(() => null);
    ttft.mark(botId, "supervisor lease");
    if (!lease) return spec.onDropped?.();
    const r = this.runtime(botId);
    const slot = newSlot({
      botId, requestId: `req_${randomUUID()}`, turnNo: this.d.bots.nextTurnNo(botId), lane: spec.lane, source: spec.source, hidden: spec.hidden,
      silenceAllowed: spec.silenceAllowed, userSeqMax: spec.userSeqMax, ackToken: spec.ackToken, userMessageEpoch: this.d.bots.userMessageEpoch(botId), startedAt: this.now(),
      context: spec.context,
    });
    slot.replyTo = spec.replyTo ?? null;
    // coding-parity: an engineering-mode Bot works like the CLI (discipline.ts quietWork).
    slot.quietWork = isLean(this.d.bots.summary(botId).settings);
    if (spec.source !== "user") {
      slot.wakeText = spec.prompt.map(messageText).join("\n"); // I2: the reviewer's wake block
      outsideLog.record(botId, slot.wakeText, this.now()); // bug 415: a wake's text is outside content for Full auto's checks
    }
    // 0.1.4: a follow-up of a non-owner turn reviews as that turn: its source, and its wake text (not the nudge's).
    if (spec.origin) { slot.reviewSource = spec.origin.source; slot.wakeText = spec.origin.wakeText; if (spec.origin.roomReview) slot.roomReview = spec.origin.roomReview; }
    r.slot = slot;
    this.loops.turnStart(botId, spec.source);
    for (const o of this.observers) o.onTurnStart?.(botId, slot);
    spec.onStart?.(slot);
    this.d.presence.turnStarted(botId);
    const prompt = this.decorate(botId, spec);
    let result: TurnResult | null = null;
    const model = this.d.bots.summary(botId).profile.model ?? DEFAULT_BOT_MODEL;
    // cost-diet-2 lever 1: a simple turn may run on a faster model (off unless "Save usage" is on).
    // Voice calls run on the Bot's own model (the same voice, the same mind); speed comes from low effort.
    let routed = spec.voiceCall ? null : this.d.router?.decide(botId, {
      source: spec.source, lane: spec.lane, images: spec.prompt.filter((m) => "image" in m).length,
      text: spec.source === "user" ? (spec.userTexts ?? []).join("\n") : spec.prompt.map(messageText).join("\n"),
    }) ?? null;
    let routedFailed = false;
    // saving-settings, "Call replies": decided once, here, so a change never reaches a turn already running.
    const callLive = this.d.callLive?.(botId) ?? false;
    slot.callLive = callLive;
    const lowEffort = voiceLowEffort(this.d.settings.savings?.().callReplies ?? "default", { voiceCall: spec.voiceCall === true, callLive });
    try {
      const routine = spec.source === "routine";
      const maxAttempts = routine ? LIMITS.streamRetriesRoutine : LIMITS.streamRetriesInteractive;
      for (let attempt = 0; ; attempt++) {
        ttft.mark(botId, "runTurn called (prompt decorated, router decided)");
        result = await lease.brain.runTurn(
          { prompt, hidden: spec.hidden, lane: spec.lane, source: spec.source, silenceAllowed: spec.silenceAllowed, requestId: slot.requestId, systemAppend: this.systemAppend(botId), model, autoReviewEpoch: "continue", ...(routed ? { routedModel: routed.model } : {}), ...(lowEffort ? { voiceTurn: true as const } : {}) },
          (e) => this.onEvent(botId, slot, e),
        );
        // A routed turn that failed before doing or saying anything reruns once on the Bot's own model, straight
        // away and not counted as a retry: the faster model is never the reason a message goes unanswered.
        if (routed && result.error && !result.aborted && result.toolCallCount === 0 && result.sentMessageCount === 0) {
          routed = null;
          routedFailed = true;
          attempt--;
          continue;
        }
        const retry = result.error?.retryable && result.toolCallCount === 0 && result.sentMessageCount === 0 && !result.aborted && attempt < maxAttempts;
        if (!retry) break;
        const base = this.d.timings?.retryBaseMs ?? (routine ? 1000 : LIMITS.streamRetryMinMs);
        await sleep(Math.min(routine ? 15_000 : LIMITS.streamRetryMaxMs, base * 2 ** attempt) * (0.5 + Math.random() / 2));
      }
    } catch (e) {
      // ENG-01: a turn that throws is a FAILED turn, not a turn that never happened. Leaving `result`
      // null skipped recordRequestId, settle() (tray + reply nudge) and every onSettle, so a user
      // message or an already-taken peer batch vanished with one log line. Synthesize the result the
      // brain would have resolved with, so the same settle path runs and the wake can requeue itself.
      log.error("turn failed", { botId, error: String(e) });
      result = {
        sentMessageCount: slot.sentTexts.length, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false,
        quiesced: slot.quiescing, usage: ZERO_USAGE, error: classifyThrown(e), finalText: "", toolCallCount: slot.toolUses.size, model,
      };
    } finally {
      ttft.end(botId);
      r.slot = null;
      r.steerSends.clear();
      this.d.presence.turnEnded(botId);
      if (this.d.bots.has(botId)) this.d.bots.publishTyping(botId, false, null);
      lease.release();
    }
    const steerFlushed = this.flushSteer(botId, r);
    const turnTrip = this.loops.turnEnd(botId, {
      error: !!result?.error, aborted: !!result?.aborted || slot.stopRequested === true, toolCalls: result?.toolCallCount ?? 0,
      sentTexts: slot.sentTexts, ...(result?.usage.costUsd !== undefined ? { costUsd: result.usage.costUsd } : {}),
    });
    if (turnTrip && !r.deleted && this.d.bots.has(botId)) this.stopForLoop(botId, slot, spec.source, turnTrip);
    this.d.router?.settled(botId, {
      escalated: !!result?.escalated, failed: routedFailed,
      workTools: [...slot.toolUses.values()].filter((u) => u.name !== SEND_TOOL).length,
    });
    for (const o of this.observers) o.onSettle?.(botId, slot, result);
    spec.onSettle?.(slot, result);
    if (!result || !this.d.bots.has(botId)) return;
    this.d.bots.recordRequestId(botId, { id: slot.requestId, at: slot.startedAt, prompt: spec.prompt.map(messageText).join("\n"), source: spec.source });
    this.settle(botId, spec, slot, result, steerFlushed);
    this.h.afterSettle?.(botId, {
      source: spec.source, lane: spec.lane, hidden: spec.hidden, requestId: slot.requestId, turnNo: slot.turnNo, userSeqMax: spec.userSeqMax,
      userTexts: spec.userTexts ?? [], sentTexts: slot.sentTexts, finalText: result.finalText, aborted: result.aborted,
      superseded: spec.source === "user" && spec.userSeqMax < this.d.bots.latestUserSeq(botId),
      error: result.error ?? null, usage: result.usage, startedAt: slot.startedAt, firstEventAt: slot.firstEventAt, endedAt: this.now(),
    });
    notifySettled(this.d.observers, {
      botId, requestId: slot.requestId, lane: spec.lane, source: spec.source, hidden: spec.hidden, startedAt: slot.startedAt, endedAt: this.now(),
      model: result.model ?? model, userText: spec.userTexts?.length ? spec.userTexts.join("\n") : null,
      sentTexts: slot.sentTexts, result, voice: spec.voiceCall === true, callLive: slot.callLive ?? false,
      ownerTask: followUpOrigin(slot, spec.source) === null, notifyRequested: slot.notifyRequested === true, stopped: slot.stopRequested === true,
    });
  }

  private onEvent(botId: string, slot: TurnSlot, e: TurnEvent): void {
    if (!this.d.bots.has(botId)) return;
    notifyEvent(this.d.observers, botId, e);
    const trip = this.loops.event(botId, e);
    if (trip && !slot.stopRequested && !slot.quiescing) this.stopForLoop(botId, slot, slot.source, trip);
    if (slot.firstEventAt === null && e.kind !== "session") slot.firstEventAt = this.now();
    switch (e.kind) {
      case "session":
        if (e.sessionId && e.sessionId !== this.d.bots.sessionId(botId)) this.d.bots.setSessionId(botId, e.sessionId);
        break;
      case "dispatched":
        slot.dispatched = true;
        break;
      case "thinking":
        ttft.mark(botId, "first thinking event");
        slot.steerHold = false; // bug 198 backstop: the model is answering again, so it has the note (PostToolBatch clears it first)
        this.d.presence.thinking(botId, e.active);
        break;
      case "text_delta":
        slot.steerHold = false;
        break;
      case "tool_start": {
        slot.toolUses.set(e.toolUseId, { messageId: e.messageId, name: e.name, input: e.input });
        if (e.name === SEND_TOOL) {
          const delivered = this.rt.get(botId)?.steer.filter((m) => m.delivered && !m.answered) ?? [];
          if (delivered.length) this.rt.get(botId)?.steerSends.set(e.toolUseId, delivered);
        }
        this.d.presence.toolStart(botId, e.name, e.input);
        if (e.name === SEND_TOOL) {
          ttft.mark(botId, "SendMessage tool_start → typing published");
          this.d.bots.publishTyping(botId, true, null);
          if (typeof e.input.content === "string" && (e.input.type ?? "text") === "text") slot.sentTexts.push(e.input.content);
          break;
        }
        if (isHiddenActivity(e.name)) break;
        slot.nextActK += 1;
        const entry: ToolCallEntry = {
          kind: "tool-call", id: activityEntryId(slot.turnNo, slot.nextActK), requestId: slot.requestId, segmentId: `${slot.requestId}:${slot.segment}`,
          hidden: slot.hidden, name: e.name, step: stepText(e.name, e.input, "", true), icon: iconFor(e.name), metric: null, status: "running", startedAt: this.now(),
        };
        slot.toolEntries.set(e.toolUseId, entry);
        this.d.bots.appendEntry(botId, entry);
        break;
      }
      case "tool_end": {
        const steerSends = this.rt.get(botId)?.steerSends;
        const steerSent = steerSends?.get(e.toolUseId);
        if (steerSent) {
          steerSends!.delete(e.toolUseId);
          if (!e.isError) this.noteSteerAnswer(slot.toolUses.get(e.toolUseId)?.input ?? {}, steerSent);
        }
        // ORIG-02 §02.7: side-effect counting for retries. SendMessage is skipped for activity rows
        // but still emits tool_end, so this counts it too.
        const used = slot.toolUses.get(e.toolUseId);
        if (!e.isError && used && countsAsSideEffect(e.name, used.input, { workspace: this.d.cfg.workspace, hostPrivate: this.d.cfg.hostPrivate })) slot.context.sideEffects += 1;
        if (slot.awaitingUserSelection && !slot.quiescing) void this.interruptActive(botId, "awaiting the user's selection");
        this.d.presence.toolEnd(botId, e.name);
        const entry = slot.toolEntries.get(e.toolUseId);
        if (!entry) break;
        const input = slot.toolUses.get(e.toolUseId)?.input ?? {};
        const done: ToolCallEntry = {
          // New-user walk, finding 3: a call cut off by Stop never ran, so it says what it was, not "Ran …".
          ...entry, status: e.isError ? (cutByStop(e.isError, !!slot.stopRequested, e.output) ? "stopped" : "error") : "done", endedAt: this.now(),
          step: cutByStop(e.isError, !!slot.stopRequested, e.output) ? stepTarget(e.name, input) : stepText(e.name, input, e.output),
          metric: e.isError ? null : metricFor(e.name, input, e.output),
          // fix round 2, finding 1: fail closed — no `?? t` fallback. Without a real redactor this is
          // `undefined`, and `bodyFor` itself refuses to build a body at all rather than an unredacted one.
          body: this.d.redact ? bodyFor(e.name, input, e.output, e.isError, (t) => this.d.redact!(botId, t)) : null,
        };
        slot.toolEntries.set(e.toolUseId, done);
        this.d.bots.updateEntry(botId, done);
        break;
      }
      case "retry":
        // A provider stream that failed partway is discarded whole (spec §6): its partial reply goes with it.
        if (e.resetStream) slot.partialJson = "";
        break;
      case "send_message_delta":
        if (this.d.flags().sendStreaming) {
          slot.partialJson += e.partialJson;
          const partial = this.quietPartials?.(botId) ? null : extractPartialContent(slot.partialJson);
          if (partial) ttft.mark(botId, "first partial text published (SSE)");
          this.d.bots.publishTyping(botId, true, partial);
        }
        break;
      default:
        break;
    }
    this.h.onEvent?.(botId, e, slot);
  }

  private settle(botId: string, spec: TurnSpec, slot: TurnSlot, result: TurnResult, steerFlushed = false): void {
    const flags = this.d.flags();
    if (spec.source === "kickstart") this.d.bots.clearIntroduction(botId);
    if (result.error) {
      this.d.trays.add({ botId, title: result.error.trayTitle, detail: result.error.message, requestId: slot.requestId, dedupeKey: `${botId}:${result.error.code}` });
      return;
    }
    if (result.aborted || result.awaitingUserSelection || spec.silenceAllowed || result.quiesced) return;
    const owed = result.sentMessageCount === 0 && !result.reacted;
    if (spec.source === "kickstart") {
      if (owed) this.d.trays.add({ botId, title: STR.trayIntroFailed, requestId: slot.requestId, dedupeKey: `${botId}:intro` });
      return;
    }
    if (flags.stopNudge) return; // the Stop hook nudged in-turn; ack redrive (onIdle) is the backstop
    if (steerFlushed) return; // bug 198: the user turn queued for the steering messages carries every unanswered one
    const round = spec.nudgeRound + 1;
    // 0.1.4: a nudge inherits the causing turn's origin; only an owner-caused nudge is an owner turn.
    const inherit = followUpOrigin(slot, spec.source);
    const origin = inherit ? { origin: inherit } : {};
    if (owed && round <= LIMITS.replyNudgesMax) {
      this.enqueueHidden(botId, { source: "reply-nudge", lane: "user", head: true, silenceAllowed: false, text: nudgeText("reply", result.finalText), ackToken: spec.ackToken, userSeqMax: spec.userSeqMax, nudgeRound: round, ...origin });
    } else if (!owed && result.endedOnSilentToolCalls && spec.source !== "closing-nudge") {
      this.enqueueHidden(botId, { source: "closing-nudge", lane: "user", head: true, silenceAllowed: false, text: nudgeText("closing", result.finalText), ackToken: spec.ackToken, userSeqMax: spec.userSeqMax, nudgeRound: LIMITS.replyNudgesMax, ...origin });
    }
  }

  // ---------- stop on repeated failure (5.7) ----------
  /**
   * The Bot kept failing the same way: its turn is cut now (no further model call is paid for), nothing else of it
   * runs, and one tray says so with Continue and Stop. Queued work waits; nothing is dropped until the user says Stop.
   */
  private stopForLoop(botId: string, slot: TurnSlot, source: WakeSource, trip: LoopTrip): void {
    const r = this.rt.get(botId);
    if (!r || r.loopHold || r.deleted) return;
    const name = this.d.bots.summary(botId).profile.name;
    const tray = this.d.trays.add({
      botId, title: STR_COST.loopStopped(name, trip.step), detail: STR_COST.loopDetail(trip.tries, trip.spentUsd), requestId: slot.requestId,
      dedupeKey: `${botId}:loop`, buttons: [{ label: STR_COST.loopContinue, action: "loop-continue" }, { label: STR_COST.loopStop, action: "loop-stop" }],
    });
    r.loopHold = { trayId: tray.id, trip, lane: slot.lane, owed: this.d.acks.get(botId) !== null, origin: followUpOrigin(slot, source) };
    log.warn("bot stopped on repeated failure", { botId, kind: trip.kind, tries: trip.tries, spentUsd: trip.spentUsd });
    if (r.slot === slot) void this.interruptActive(botId, "stopped: the same step kept failing");
  }

  /** A tray's Continue or Stop. Returns false for a tray this doesn't own. */
  async loopAction(trayId: string, action: "loop-continue" | "loop-stop"): Promise<boolean> {
    const found = [...this.rt.entries()].find(([, x]) => x.loopHold?.trayId === trayId);
    if (!found) { if (this.d.trays.get(trayId)) this.d.trays.dismiss(trayId); return false; }
    const [botId, r] = found;
    const hold = r.loopHold!;
    // Stop: the queue and the reply obligation go first (interruptAgent), so nothing held starts in between.
    if (action === "loop-stop" && this.d.bots.has(botId)) { await this.interruptAgent(botId); return true; }
    if (action === "loop-stop" || !this.d.bots.has(botId) || r.deleted) { this.releaseLoopHold(botId, r); return true; }
    // The hold stays until the Continue turn is at the head of the queue, so it runs first.
    // Continue: one hidden turn that says what happened, ahead of whatever was queued, then the queue runs again.
    this.enqueueHidden(botId, {
      source: "loop-continue", lane: hold.lane, head: true, silenceAllowed: !hold.owed, text: loopContinueText(hold.trip.step, hold.trip.tries),
      ackToken: this.d.acks.token(botId), userSeqMax: this.d.bots.latestUserSeq(botId), ...(hold.origin ? { origin: hold.origin } : {}),
    });
    this.releaseLoopHold(botId, r);
    return true;
  }

  /** Whether this Bot is stopped on repeated failure (the tray is up, nothing of it runs). */
  loopStopped(botId: string): boolean {
    return Boolean(this.rt.get(botId)?.loopHold);
  }

  private releaseLoopHold(botId: string, r: BotRuntime): void {
    const hold = r.loopHold;
    this.loops.reset(botId);
    if (!hold) return;
    r.loopHold = null;
    if (this.d.trays.get(hold.trayId)) this.d.trays.dismiss(hold.trayId);
    if (!r.deleted) r.scheduler.resume(); // what was held runs (or, with nothing queued, the Bot goes idle)
  }

  /** Whether this tray is a stop-on-repeated-failure tray (a plain dismiss of it is a Stop: it said "Stopped"). */
  ownsLoopTray(trayId: string): boolean {
    return [...this.rt.values()].some((x) => x.loopHold?.trayId === trayId);
  }

  // ---------- ack redrive (OUT-08) ----------
  private onIdle(botId: string): void {
    this.h.onIdle?.(botId);
    // ENG-02: materialise the runtime rather than reading `rt`. At boot, resumeAtBoot() walks the
    // durable ack obligations, and a Bot that was idle when the process died has no `rt` entry yet —
    // `rt.get()` returned undefined and the redrive that owes the user a reply was never armed.
    if (!this.d.bots.has(botId) || !this.d.acks.get(botId)) return;
    const r = this.runtime(botId);
    if (r.deleted) return;
    if (r.redrive) clearTimeout(r.redrive);
    r.redrive = setTimeout(() => this.redrive(botId), this.d.timings?.ackRedriveIdleMs ?? LIMITS.ackRedriveIdleMs);
  }

  private redrive(botId: string): void {
    // Same invariant as onIdle: the obligation is durable, the runtime is not. retryTray() reaches
    // here directly, and after a restart `rt` is empty — reading it would silently do nothing.
    if (!this.d.bots.has(botId) || !this.d.acks.get(botId)) return;
    const r = this.runtime(botId);
    if (r.deleted || !r.scheduler.isIdle()) return;
    const attempts = this.d.acks.noteRedrive(botId);
    if (attempts > LIMITS.ackRedriveMax) {
      this.d.acks.drop(botId);
      this.d.trays.add({ botId, title: STR.trayBotFailed, retry: true, dedupeKey: `${botId}:unanswered` });
      return;
    }
    this.enqueueHidden(botId, { source: "ack-redrive", lane: "background", silenceAllowed: false, text: ackRedriveText(), ackToken: this.d.acks.token(botId), userSeqMax: this.d.bots.latestUserSeq(botId) });
  }

  retryTray(trayId: string): void {
    const tray = this.d.trays.get(trayId);
    this.d.trays.dismiss(trayId);
    if (!tray?.botId || !this.d.bots.has(tray.botId)) return;
    this.d.acks.record(tray.botId);
    this.redrive(tray.botId);
  }

  // ---------- maintenance jobs (ORIG-07 §07.2) ----------
  maintenanceActive(botId: string): boolean {
    return Boolean(this.rt.get(botId)?.maintenance);
  }

  /** ORIG-07 §07.2: a background task on the Bot's scheduler; it never overlaps a turn, and a user message aborts it. */
  runMaintenance(botId: string, job: MaintenanceJob): boolean {
    if (!this.d.bots.has(botId)) return false;
    const r = this.runtime(botId);
    if (r.deleted || r.maintenance || r.scheduler.pending("background").some((t) => t.source === "maintenance")) return false;
    r.scheduler.enqueue({
      id: `maintenance-${job.id}`, lane: "background", source: "maintenance", acceptedAtMs: this.now(),
      run: async () => {
        if (!this.d.bots.has(botId) || r.deleted) return;
        const lease = await this.sup().acquire(botId, "background", this.now()).catch(() => null);
        if (!lease) return;
        const ac = new AbortController();
        r.maintenance = ac;
        try {
          await lease.brain.cool("maintenance", true); // the job opens its own query on the same session
          if (!ac.signal.aborted) await job.run(ac.signal);
        } catch (e) {
          log.warn("maintenance job failed", { botId, job: job.id, error: String(e) });
        } finally {
          r.maintenance = null;
          lease.release();
        }
      },
    });
    return true;
  }

  async coolBrain(botId: string, reason: string): Promise<void> {
    if (!this.supervisor) return;
    await this.sup().brainFor(botId).cool(reason, true);
  }

  // ---------- interrupts ----------
  /** ENG-04: an interrupt that fails must never abort its caller. Most call sites are `void`-called
   *  (preempt, the scheduler watchdog, the awaiting-selection path), where a rejection becomes an
   *  unhandled rejection and takes the host process down on Node's default; beginDelete's is awaited,
   *  and a throw there left the Bot marked deleted, still listed and permanently inert. The brain's
   *  own interrupt() already falls back to a forced cool, so the interrupt is best-effort by design. */
  async interruptActive(botId: string, reason: string): Promise<void> {
    if (!this.supervisor) return;
    try {
      await this.sup().brainFor(botId).interrupt(reason);
    } catch (e) {
      log.error("interrupt failed", { botId, reason, error: String(e) });
    }
  }

  /** CHAT-18 Stop: interrupt, no message, and no turn until the next event. */
  async interruptAgent(botId: string): Promise<void> {
    this.d.bots.require(botId);
    const r = this.runtime(botId);
    this.notifyDropped(r, () => true);
    r.scheduler.drop(() => true);
    this.releaseSteer(botId, r, null);
    this.releaseLoopHold(botId, r);
    if (r.slot) r.slot.stopRequested = true;
    if (r.redrive) clearTimeout(r.redrive);
    this.d.acks.drop(botId);
    // New-user walk, finding 3: the user stopped it; the card says "Stopped by you", not "Approval expired".
    this.g().expireAll(botId, "stopped");
    await this.interruptActive(botId, "stopped by the user");
  }

  preempt(botId: string): void {
    void this.interruptActive(botId, "preempted for a user turn");
  }

  /** BOT-09 order: mark deleted, drop obligations and pending wakes, interrupt, drain, clear trays, forget, remove data. */
  async deleteBot(botId: string): Promise<void> {
    await this.beginDelete(botId);
    await this.finishDelete(botId);
  }

  /** I6 step 1: mark deleted, drop obligations and pending wakes, interrupt and drain. No new turn starts after this. */
  async beginDelete(botId: string): Promise<void> {
    this.d.bots.require(botId);
    const r = this.runtime(botId);
    r.deleted = true;
    r.steer = [];
    r.steerSends.clear();
    if (r.redrive) clearTimeout(r.redrive);
    this.d.acks.drop(botId);
    this.notifyDropped(r, () => true);
    r.scheduler.drop(() => true);
    this.g().expireAll(botId, "session_end");
    await this.interruptActive(botId, "bot deleted");
    const deadline = this.now() + 5000;
    while (r.scheduler.active && this.now() < deadline) await sleep(20);
  }

  /** I6 last step: clear trays, forget the brain, remove the Bot's data and session files. */
  async finishDelete(botId: string): Promise<void> {
    this.loops.forget(botId);
    this.d.trays.clear(botId);
    this.g().forgetBot(botId);
    await this.sup().forget(botId);
    this.rt.delete(botId);
    this.d.bots.remove(botId);
  }

  // ---------- quiesce and restart resume (EVT-17, EVT-19) ----------
  quiesce(): void {
    for (const [botId, r] of this.rt) {
      if (r.deleted) continue;
      // Bug 2 (EVT-19): a live slot alone used to be "busy" enough for a resume marker, so quiesce()
      // landing the instant a turn-ending SendMessage completed — before the host's own trailing settle/
      // afterSettle work let the slot go — wrote "Continue from where you left off" for a reply that had
      // already gone out, with no tool call actually left to re-run. A queued-but-unstarted task (the old
      // `!r.scheduler.isIdle()` arm) is the same story: nothing started, so nothing to resume either.
      // isGenuinelyCutOff asks the slot itself: owed (nothing sent yet) or still working after a send.
      const busy = r.slot !== null && isGenuinelyCutOff(r.slot);
      if (busy) this.d.resume.add({ botId, source: r.slot?.source ?? "user" });
      if (r.slot) r.slot.quiescing = true;
      this.g().expireAll(botId, "quiesce");
      this.notifyDropped(r, () => true);
      r.scheduler.drop(() => true);
      this.releaseSteer(botId, r, null); // the ack obligation stays: restart resume and redrive answer them
    }
  }

  resumeAtBoot(): void {
    for (const m of this.d.resume.take()) {
      if (!this.d.bots.has(m.botId)) continue;
      this.enqueueHidden(m.botId, { source: "restart-resume", lane: "background", silenceAllowed: m.source !== "user", text: restartResumeText(), ackToken: this.d.acks.token(m.botId), userSeqMax: this.d.bots.latestUserSeq(m.botId) });
    }
    for (const o of this.d.acks.pending()) if (this.d.bots.has(o.botId)) this.onIdle(o.botId);
    for (const id of this.d.bots.ids()) this.kickstart(id);
  }
}
