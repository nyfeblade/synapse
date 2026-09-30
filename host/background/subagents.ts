import { randomUUID } from "node:crypto";
import { APP_NAME, COMPUTER_NAME, DEFAULT_BOT_MODEL, LIMITSC, STRC, SUBAGENT_TYPES, activityEntryId, formatDuration, isProviderModelRef, type AsyncTaskView, type ComputerPerception, type ScreenView, type SubagentType, type ToolCallEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult, SupervisedBrain, TurnEvent, WakeSource } from "../brain/types";
import { bodyFor, iconFor, isHiddenActivity, metricFor, stepText } from "../presence/activity";
import type { SseHub } from "../gateway/sse-hub";
import type { Redactor } from "../history/archive";
import { fillTemplate, loadPrompt } from "../prompts";
import type { TurnContext } from "../runner/turn-context";
import type { RoomReview } from "../groups/member-prompt";
import { NATIVE_VIEW } from "../computer/screen-view";
import { LoopGuard, type LoopTrip } from "../runner/loop-guard";
import { newSlot, type TurnSlot } from "../runner/turn-slot";
import type { Supervisor } from "../supervisor/supervisor";
import type { PendingWakes } from "./pending-wakes";
import type { Revivals } from "./revivals";

/** origin: the launching turn's wake source and wake context, so the child's actions are reviewed like that turn's. */
export interface ChildSpec { id: string; parentBotId: string; type: SubagentType; title: string; model: string; systemAppend: string; rehearsal?: boolean;
  /** "Computer perception: Live (beta)" for a computerUse child: Look/Act/Screenshot instead of the Computer tool. */
  perception?: "live";
  /** A computer or browser child whose model can't read images: text reads of the screen and page, no screenshots. */
  textOnly?: true;
  /** A computer child's screen as its model sees it (screenshot size = coordinate space); absent = the display, 1:1. */
  view?: ScreenView;
  origin?: { source: WakeSource; wakeText: string; context: Pick<TurnContext, "wake" | "routineRun">; roomReview?: RoomReview } }
export interface ChildHooks { slot(): TurnSlot; setSessionId(id: string): void; getSessionId(): string | null; onAction(line: string): void }
export interface SubagentDeps {
  /** Bug 195 S2: a child is starting for this Bot (a pending GitHub sign-in is cancelled). */
  onWork?(botId: string): void;
  supervisor: Pick<Supervisor, "adopt" | "acquire" | "forget">;
  makeBrain(spec: ChildSpec, hooks: ChildHooks): SupervisedBrain;
  revivals: Pick<Revivals, "complete">;
  pending: PendingWakes;
  hub: SseHub;
  bots: Pick<BotService, "summary" | "nextTurnNo" | "userMessageEpoch">;
  /** Bug #66: a child session lives in its parent Bot's own CLI config dir once the box is migrated. */
  transcriptPath(sessionId: string, parentBotId: string): string | null;
  /** I6: a child session started; the parent records its file so deleting the parent removes it. */
  onChildSession?(parentBotId: string, sessionId: string): void;
  now?(): number;
  wallClockMs?: number;
  /** CHAT-22: a child's tool calls become visible activity steps in the parent's transcript ("Browsed 6 pages"). */
  activity?: { append(botId: string, e: ToolCallEntry): void; update(botId: string, e: ToolCallEntry): void };
  /** I3: Teach a task rehearsals (host/teach/rehearsal-registry.ts), registered for the child's whole run. */
  rehearsals?: { start(botId: string, childTaskId: string): void; end(childTaskId: string): void };
  /** The launching Bot's current turn slot (TurnRunner.slot), for the child's review origin. */
  parentSlot?(botId: string): TurnSlot | null;
  /** The parent Bot's effective "Computer perception" (default screenshots). */
  perception?(botId: string): ComputerPerception;
  /** bug 198 fix round 1: same as RunnerDeps.redact — a child's mirrored tool-call body is stored in
   *  the PARENT's transcript, so it is redacted with the parent's own secrets.
   *  fix round 2, finding 1: `Redactor` (host/history/archive.ts) answers `null` while it cannot
   *  redact yet — that must mean "no body", never "store it unredacted". */
  redact?: Redactor;
  /** Whether this model reads images in tool results (catalog, then measured evidence). A computer or browser child on
   *  a model that doesn't gets the text-only tools. Absent: every model does (Claude, tests). */
  seesImages?(modelRef: string): boolean;
  /** The screen as this model sees it (host/computer/screen-view.ts). Absent: the display, 1:1. */
  screenView?(modelRef: string): ScreenView;
}
interface Child {
  spec: ChildSpec; brain: SupervisedBrain | null; slot: TurnSlot; status: AsyncTaskView["status"]; startedAt: number; runningSince: number | null;
  endedAt: number | null; sessionId: string | null; toolCalls: number; actions: string[]; report: string; steering: string[];
  stopped: boolean; timedOut: boolean; steeredForTime: boolean;
  /** 5.7: the loop guard stopped it (the same step kept failing); every brain, Claude or provider, alike. */
  loop: LoopTrip | null;
}
const COMPUTER_TYPES: ReadonlySet<SubagentType> = new Set(["computerUse", "browserUse"]);
const PROMPT: Record<SubagentType, string> = { generalPurpose: "subagents/general-purpose.md", computerUse: "subagents/computer-use.md", browserUse: "subagents/browser-use.md" };
const TEXT_PROMPT: Partial<Record<SubagentType, string>> = { computerUse: "subagents/computer-use-text.md", browserUse: "subagents/browser-use-text.md" };
/** Computer and browser children run on the Bot's own provider model; a Claude Bot's run on this Claude model. */
export const CLAUDE_COMPUTER_MODEL = "claude-sonnet-5";

export function childSystemAppend(type: SubagentType, perception?: "live", o: { textOnly?: boolean; view?: ScreenView } = {}): string {
  const file = type === "computerUse" && perception === "live" ? "subagents/computer-use-live.md" : (o.textOnly && TEXT_PROMPT[type]) || PROMPT[type];
  const v = o.view ?? NATIVE_VIEW;
  return fillTemplate(loadPrompt(file), { APP_NAME, COMPUTER_NAME, SCREEN_W: String(v.w), SCREEN_H: String(v.h), MAX_X: String(v.w - 1), MAX_Y: String(v.h - 1) });
}

export class SubagentService {
  private children = new Map<string, Child>();
  private retired = new Set<string>(); // I6: deleted Bots never start another child
  private now: () => number;
  /** 5.7: the runner's loop guard, over each child's own events (keyed by child id). */
  private loops: LoopGuard;

  constructor(private d: SubagentDeps) {
    this.now = d.now ?? Date.now;
    this.loops = new LoopGuard(this.now);
  }

  private live(c: Child) { return c.status === "queued" || c.status === "running"; }

  activeComputerChild(botId: string): string | null {
    for (const c of this.children.values()) if (c.spec.parentBotId === botId && COMPUTER_TYPES.has(c.spec.type) && this.live(c)) return c.spec.id;
    return null;
  }

  list(botId: string): AsyncTaskView[] {
    return [...this.children.values()].filter((c) => c.spec.parentBotId === botId).map((c) => ({
      id: c.spec.id, kind: "subagent", botId, type: c.spec.type, title: c.spec.title, status: c.status, startedAt: c.startedAt, endedAt: c.endedAt,
    }));
  }

  private publish(botId: string): void {
    this.d.hub.publish({ channel: "async-tasks", payload: { botId, tasks: this.list(botId) } });
  }

  async launch(botId: string, a: { description: string; prompt: string; subagent_type?: string; rehearsal?: boolean }): Promise<BotToolResult> {
    if (this.retired.has(botId)) return { text: "This Bot was deleted.", isError: true };
    const type = (a.subagent_type ?? "generalPurpose") as SubagentType;
    if (!SUBAGENT_TYPES.includes(type)) return { text: `Unknown subagent_type "${String(a.subagent_type)}". Use generalPurpose, computerUse or browserUse.`, isError: true };
    const mine = [...this.children.values()].filter((c) => c.spec.parentBotId === botId && this.live(c));
    if (COMPUTER_TYPES.has(type) && this.activeComputerChild(botId)) return { text: STRC.computerUseBusy, isError: true };
    if (mine.length >= LIMITSC.childrenPerBot || [...this.children.values()].filter((c) => this.live(c)).length >= LIMITSC.childrenTotal) return { text: STRC.tooManyTasks, isError: true };
    const id = `subagent-${randomUUID()}`;
    const title = String(a.description ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITSC.taskTitleMax) || "Task";
    const own = this.d.bots.summary(botId).profile.model ?? DEFAULT_BOT_MODEL;
    // No feature needs Claude: a provider Bot's computer and browser children run on its own model.
    const computer = COMPUTER_TYPES.has(type);
    const model = computer && !isProviderModelRef(own) ? CLAUDE_COMPUTER_MODEL : own;
    const textOnly = computer && this.d.seesImages ? !this.d.seesImages(model) : false;
    const view = type === "computerUse" && this.d.screenView ? this.d.screenView(model) : NATIVE_VIEW;
    const p = this.d.parentSlot?.(botId) ?? null;
    const origin = p ? { source: p.reviewSource ?? p.source, wakeText: p.wakeText, context: { wake: p.context.wake, routineRun: p.context.routineRun }, ...(p.roomReview ? { roomReview: p.roomReview } : {}) } : undefined;
    const perception = type === "computerUse" && this.d.perception?.(botId) === "live" ? ("live" as const) : undefined;
    const spec: ChildSpec = {
      id, parentBotId: botId, type, title, model, systemAppend: childSystemAppend(type, perception, { textOnly, view }), ...(perception ? { perception } : {}),
      ...(textOnly ? { textOnly: true as const } : {}), ...(view.w !== NATIVE_VIEW.w || view.h !== NATIVE_VIEW.h ? { view } : {}),
      ...(a.rehearsal === true ? { rehearsal: true } : {}), ...(origin ? { origin } : {}),
    };
    const slot = this.freshSlot(spec);
    const c: Child = { spec, brain: null, slot, status: "queued", startedAt: this.now(), runningSince: null, endedAt: null, sessionId: null, toolCalls: 0, actions: [], report: "", steering: [], stopped: false, timedOut: false, steeredForTime: false, loop: null };
    this.children.set(id, c);
    this.d.onWork?.(botId);
    if (a.rehearsal === true) this.d.rehearsals?.start(botId, id); // I3: ended in run() whatever way the child finishes
    c.brain = this.d.makeBrain(spec, {
      slot: () => c.slot, getSessionId: () => c.sessionId, setSessionId: (s) => { c.sessionId = s; this.d.onChildSession?.(botId, s); },
      onAction: (line) => { c.actions.push(line); if (c.actions.length > LIMITSC.checkLastActions) c.actions.shift(); },
    });
    this.d.supervisor.adopt(`child:${id}`, c.brain);
    this.d.pending.add({ kind: "subagent", botId, taskId: id });
    const admitted = this.d.supervisor.acquire(`child:${id}`, "background", this.now());
    const queued = await Promise.race([admitted.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), 0))]);
    void this.run(c, String(a.prompt ?? ""), admitted);
    this.publish(botId);
    return { text: `Started ${type} subagent ${id} (“${title}”). Its result wakes you when it's done, so there's no need to wait for it.${queued ? " (queued: waiting for a free slot)" : ""}` };
  }

  private freshSlot(spec: ChildSpec): TurnSlot {
    const slot = newSlot({
      botId: spec.parentBotId, requestId: `child:${spec.id}`, turnNo: this.d.bots.nextTurnNo(spec.parentBotId), lane: "background", source: "subagent-done",
      hidden: true, silenceAllowed: true, userSeqMax: 0, ackToken: null, userMessageEpoch: this.d.bots.userMessageEpoch(spec.parentBotId), startedAt: this.now(),
      ...(spec.origin ? { context: spec.origin.context } : {}),
    });
    if (spec.origin) { slot.reviewSource = spec.origin.source; slot.wakeText = spec.origin.wakeText; if (spec.origin.roomReview) slot.roomReview = spec.origin.roomReview; }
    return slot;
  }

  private async run(c: Child, firstText: string, firstLease: ReturnType<SubagentDeps["supervisor"]["acquire"]>): Promise<void> {
    let text = firstText;
    let leaseP = firstLease;
    try {
      for (;;) {
        const lease = await leaseP;
        if (c.stopped) { c.status = "aborted"; lease.release(); break; }
        c.status = "running";
        c.runningSince ??= this.now();
        this.publish(c.spec.parentBotId);
        this.loops.turnStart(c.spec.id, "subagent-done");
        const sink = (e: TurnEvent) => {
          if (e.kind === "tool_start") c.toolCalls += 1;
          this.mirror(c, e);
          const trip = this.loops.event(c.spec.id, e);
          if (trip && !c.loop && !c.stopped) { c.loop = trip; void c.brain?.interrupt("loop guard"); }
        };
        const r = await (c.brain as SupervisedBrain).runTurn({
          prompt: [{ text }], hidden: true, lane: "background", source: "subagent-done", silenceAllowed: true, requestId: `child:${c.spec.id}`,
          systemAppend: c.spec.systemAppend, model: c.spec.model, autoReviewEpoch: "continue",
        }, sink);
        lease.release();
        if (r.finalText) c.report = r.finalText;
        if (c.loop) {
          c.report = `Stopped by ${APP_NAME}: “${c.loop.step}” kept failing (${c.loop.tries} tries in a row).${c.report ? `\nLast words before the stop:\n${c.report}` : ""}`;
          c.status = "error";
          break;
        }
        const steer = c.steering.shift();
        if (!c.stopped && !c.timedOut && steer !== undefined) {
          text = fillTemplate(loadPrompt("subagents/steer.md"), { TEXT: steer }).trimEnd();
          c.slot = this.freshSlot(c.spec);
          leaseP = this.d.supervisor.acquire(`child:${c.spec.id}`, "background", this.now());
          continue;
        }
        c.status = c.timedOut ? "timed_out" : c.stopped ? "aborted" : r.error ? "error" : "done";
        break;
      }
    } catch (e) {
      c.status = "error";
      c.report ||= (e as Error).message;
    }
    c.endedAt = this.now();
    this.loops.forget(c.spec.id);
    if (c.spec.rehearsal) this.d.rehearsals?.end(c.spec.id);
    await c.brain?.cool("child finished").catch(() => {});
    await this.d.supervisor.forget(`child:${c.spec.id}`).catch(() => {});
    this.publish(c.spec.parentBotId);
    if (c.status === "aborted") {
      this.d.pending.remove(c.spec.id);
      return;
    }
    this.d.revivals.complete({ kind: "subagent", botId: c.spec.parentBotId, taskId: c.spec.id, block: this.block(c) });
  }

  /** CHAT-22: one tool-call entry per child call, in the parent's transcript, one segment per child. */
  private mirror(c: Child, e: TurnEvent): void {
    const a = this.d.activity;
    if (!a || (e.kind !== "tool_start" && e.kind !== "tool_end") || isHiddenActivity(e.name)) return;
    if (e.kind === "tool_start") {
      c.slot.toolUses.set(e.toolUseId, { messageId: e.messageId, name: e.name, input: e.input });
      c.slot.nextActK += 1;
      const entry: ToolCallEntry = {
        kind: "tool-call", id: activityEntryId(c.slot.turnNo, c.slot.nextActK), requestId: `child:${c.spec.id}`, segmentId: `child:${c.spec.id}`,
        hidden: false, name: e.name, step: stepText(e.name, e.input, "", true), icon: iconFor(e.name), metric: null, status: "running", startedAt: this.now(),
      };
      c.slot.toolEntries.set(e.toolUseId, entry);
      a.append(c.spec.parentBotId, entry);
      return;
    }
    const entry = c.slot.toolEntries.get(e.toolUseId);
    if (!entry) return;
    const input = c.slot.toolUses.get(e.toolUseId)?.input ?? {};
    const done: ToolCallEntry = {
      ...entry, status: e.isError ? "error" : "done", endedAt: this.now(), step: stepText(e.name, input, e.output),
      metric: e.isError ? null : metricFor(e.name, input, e.output),
      // fix round 2, finding 1: fail closed — no `?? t` fallback (see turn-runner.ts's tool_end).
      body: this.d.redact ? bodyFor(e.name, input, e.output, e.isError, (t) => this.d.redact!(c.spec.parentBotId, t)) : null,
    };
    c.slot.toolEntries.set(e.toolUseId, done);
    a.update(c.spec.parentBotId, done);
  }

  private block(c: Child): string {
    const word = c.status === "timed_out" ? "timed out" : c.status === "error" ? "failed" : "done";
    const took = formatDuration((c.endedAt ?? this.now()) - c.startedAt);
    const tp = c.sessionId ? this.d.transcriptPath(c.sessionId, c.spec.parentBotId) : null;
    return `Task “${c.spec.title}” (${c.spec.id}, ${c.spec.type}) — ${word} after ${took}.\n${c.report ? `Report:\n${c.report}` : "(no report)"}${tp ? `\nTranscript: ${tp}` : ""}`;
  }

  private mine(botId: string, id: string): Child | null {
    const c = this.children.get(id);
    return c && c.spec.parentBotId === botId ? c : null;
  }

  check(botId: string, id: string): BotToolResult {
    const c = this.mine(botId, id);
    if (!c) return { text: `No subagent ${id}.`, isError: true };
    const state = c.status === "queued" ? "queued" : c.status === "running" ? `running for ${formatDuration(this.now() - c.startedAt)}` : `${c.status.replace("_", " ")} after ${formatDuration((c.endedAt ?? this.now()) - c.startedAt)}`;
    const tp = c.sessionId ? this.d.transcriptPath(c.sessionId, c.spec.parentBotId) : null;
    return { text: `${id} (${c.spec.type}) “${c.spec.title}” — ${state} · ${c.toolCalls} tool call${c.toolCalls === 1 ? "" : "s"}${c.actions.length ? `\nLast actions:\n${c.actions.map((x) => `- ${x}`).join("\n")}` : ""}${tp ? `\nTranscript: ${tp}` : ""}${!this.live(c) && c.report ? `\nReport:\n${c.report}` : ""}` };
  }

  async message(botId: string, id: string, text: string): Promise<BotToolResult> {
    const c = this.mine(botId, id);
    if (!c) return { text: `No subagent ${id}.`, isError: true };
    if (!this.live(c)) return { text: `${id} already finished; start a new Task instead.`, isError: true };
    c.steering.push(text);
    if (c.status === "running") await c.brain?.interrupt("steering message");
    return { text: `Sent your steering message to ${id}.` };
  }

  async stop(botId: string, id: string): Promise<BotToolResult> {
    const c = this.mine(botId, id);
    if (!c) return { text: `No subagent ${id}.`, isError: true };
    if (!this.live(c)) return { text: `${id} already finished.` };
    c.stopped = true;
    await c.brain?.interrupt("stopped by the parent");
    return { text: `Stopped ${id}. It won't report back.` };
  }

  /** ORIG-15: steer at 90 % of the wall-clock, stop at 100 % and revive the parent with "timed out". */
  async tick(): Promise<void> {
    const limit = this.d.wallClockMs ?? LIMITSC.subagentWallClockMs;
    for (const c of this.children.values()) {
      if (c.status !== "running") continue;
      const age = this.now() - c.startedAt;
      if (age >= limit && !c.timedOut) {
        c.timedOut = true;
        await c.brain?.interrupt("wall-clock limit");
      } else if (age >= LIMITSC.subagentSteerAt * limit && !c.steeredForTime) {
        c.steeredForTime = true;
        await this.message(c.spec.parentBotId, c.spec.id, loadPrompt("subagents/time-nearly-up.md").trim());
      }
    }
  }

  /** EVT-17: children die with the host; their markers become "interrupted" revivals. */
  recoverAtBoot(): void {
    for (const w of this.d.pending.list().filter((x) => x.kind === "subagent")) {
      this.d.revivals.complete({ kind: "subagent", botId: w.botId, taskId: w.taskId, block: `Task ${w.taskId} was interrupted by a restart of the app before it finished. Start it again if it's still needed.` });
    }
  }

  /** Any child of this Bot queued or running. */
  hasLive(botId: string): boolean {
    return [...this.children.values()].some((c) => c.spec.parentBotId === botId && this.live(c));
  }

  async forgetBot(botId: string): Promise<void> {
    this.retired.add(botId);
    for (const c of [...this.children.values()].filter((x) => x.spec.parentBotId === botId)) {
      c.stopped = true;
      await c.brain?.interrupt("bot deleted").catch(() => {});
      this.children.delete(c.spec.id);
    }
    this.d.pending.dropBot(botId);
  }
}
