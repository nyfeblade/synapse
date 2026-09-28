import { randomUUID } from "node:crypto";
import type {
  BrainWiring, ClassifiedError, ModelMessage, ProcState, SupervisedBrain, TurnEvent, TurnEventSink, TurnInput, TurnResult,
} from "./types";
import { messageText, ZERO_USAGE } from "./types";

export type FakeToolStep = { tool: string; input: Record<string, unknown>; output?: string; /** a slow tool: runs this long (an interrupt cuts it short) */ delayMs?: number };
export type FakeStep =
  | FakeToolStep
  /** startsAfterHooks: each call's tool_start is emitted after its PreToolUse hook, not up front (event-order tests). */
  | { parallel: FakeToolStep[]; startsAfterHooks?: boolean }
  | { text: string }
  | { think: true }
  | { wait: number }
  | { fail: ClassifiedError }
  | { crash: true }
  | { compact: true }
  | { context: number }
  | { emit: TurnEvent }
  /** FUZZ/E2E: send the previous tool's output as a message, so a journey can see what the Bot was told. */
  | { relayLastToolOutput: true }
  /** Steps decided mid-turn from what the tool results have told the Bot so far (bug 198: a steering note). */
  | { then: (ctx: { notes: readonly string[] }) => FakeStep[] };
export interface FakeScriptCtx { turnIndex: number; nudge?: string }
export type FakeScript = (input: TurnInput, ctx: FakeScriptCtx) => FakeStep[];
export interface FakeBrainOptions {
  sessionId?: string | null;
  now?: () => number;
  spawnDelayMs?: number;
  toolRunner?: (name: string, input: Record<string, unknown>) => Promise<string>;
}

const CRASH: ClassifiedError = { code: "BOT-E0403", message: "Claude exited unexpectedly", retryable: true, trayTitle: "Bot failed to respond" };

class Crashed extends Error {}

/** Scripted BrainSession used by unit tests, E2E and FUZZ mode. It follows Claude Code's permission order: hook → canUseTool. */
export class FakeBrain implements SupervisedBrain {
  procState: ProcState = "cold";
  lastActiveAt = 0;
  lastEventAt = 0;
  turnStartedAt = 0;
  toolInFlight = false;
  pid: number | null = null;
  private lastToolOutput = "";
  readonly inputs: TurnInput[] = [];
  readonly pushed: ModelMessage[] = [];
  /** Every PostToolUse `additionalContext` the Bot was shown, in order (reminders, steering notes). */
  readonly notes: string[] = [];
  private session: string | null;
  private listeners = new Set<(s: ProcState, prev: ProcState) => void>();
  private abort: AbortController | null = null;
  private turnIndex = 0;
  private seq = 0;
  private now: () => number;

  constructor(readonly botId: string, private wiring: BrainWiring, private script: FakeScript, private opts: FakeBrainOptions = {}) {
    this.session = opts.sessionId ?? null;
    this.now = opts.now ?? Date.now;
  }

  get sessionId(): string | null {
    return this.session;
  }

  onStateChange(cb: (s: ProcState, prev: ProcState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(s: ProcState): void {
    const prev = this.procState;
    if (prev === s) return;
    this.procState = s;
    for (const l of this.listeners) l(s, prev);
  }

  async runTurn(input: TurnInput, sink: TurnEventSink): Promise<TurnResult> {
    this.inputs.push(input);
    const emit: TurnEventSink = (e) => { this.lastEventAt = this.now(); sink(e); };
    if (this.procState === "cold" || this.procState === "crashed") {
      this.setState("spawning");
      if (this.opts.spawnDelayMs) await new Promise((r) => setTimeout(r, this.opts.spawnDelayMs));
      this.session ??= randomUUID();
      this.pid = 10_000 + Math.floor(Math.random() * 10_000);
      emit({ kind: "session", sessionId: this.session, model: input.model ?? "fake", tools: [], cliVersion: "fake" });
    }
    this.setState("running");
    this.turnStartedAt = this.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let finalText = "";
    let toolCallCount = 0;
    let error: ClassifiedError | undefined;
    let steps = this.script(input, { turnIndex: this.turnIndex++ });
    emit({ kind: "dispatched" });
    try {
      for (let round = 0; round < 5 && !signal.aborted && !error; round++) {
        const queue = [...steps];
        while (queue.length) {
          const raw = queue.shift()!;
          if (signal.aborted || error) break;
          if ("then" in raw) { queue.unshift(...raw.then({ notes: this.notes })); continue; }
          const step: FakeStep = "relayLastToolOutput" in raw ? { tool: "mcp__bot__SendMessage", input: { content: this.lastToolOutput } } : raw;
          if ("wait" in step) await new Promise<void>((r) => { const t = setTimeout(r, step.wait); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
          else if ("think" in step) { emit({ kind: "thinking", active: true }); emit({ kind: "thinking", active: false }); }
          else if ("text" in step) { finalText = step.text; emit({ kind: "text_delta", text: step.text }); }
          else if ("fail" in step) error = step.fail;
          else if ("crash" in step) throw new Crashed();
          else if ("compact" in step) emit({ kind: "compact_boundary" });
          else if ("context" in step) emit({ kind: "context", tokens: step.context });
          else if ("emit" in step) emit(step.emit);
          else {
            const group = "parallel" in step ? step.parallel : [step];
            const messageId = `msg_fake_${++this.seq}`;
            const calls = group.map((s) => ({ step: s, call: { toolName: s.tool, input: s.input, toolUseId: `toolu_fake_${++this.seq}` } }));
            const late = "parallel" in step && step.startsAfterHooks === true;
            const start = (c: { toolName: string; input: Record<string, unknown>; toolUseId: string }) => emit({ kind: "tool_start", toolUseId: c.toolUseId, name: c.toolName, input: c.input, messageId });
            if (!late) for (const { call } of calls) start(call);
            for (const { step: s, call } of calls) {
              if (signal.aborted) break;
              toolCallCount++;
              await this.runTool(s, call, emit, signal, late ? () => start(call) : undefined);
            }
            // The CLI's PostToolBatch: once per model message's tool batch (its end-turn answer is ignored here).
            if (!signal.aborted) await this.wiring.toolBatch?.(calls.map((c) => c.call));
          }
        }
        if (signal.aborted || error) break;
        const stop = await this.wiring.stop({ lastAssistantText: finalText, stopHookActive: round > 0 });
        if (!stop.block) break;
        steps = this.script(input, { turnIndex: this.turnIndex - 1, nudge: stop.reason });
      }
    } catch (e) {
      if (!(e instanceof Crashed)) throw e;
      this.setState("crashed");
      this.setState("cold");
      return { ...this.wiring.turnCounters(), aborted: false, quiesced: false, usage: ZERO_USAGE, error: CRASH, finalText, toolCallCount, model: input.model ?? null };
    }
    this.lastActiveAt = this.now();
    const aborted = signal.aborted;
    this.abort = null;
    if (this.procState === "running" || this.procState === "interrupted") this.setState("warm_idle");
    return { ...this.wiring.turnCounters(), aborted, quiesced: false, usage: ZERO_USAGE, error, finalText, toolCallCount, model: input.model ?? null };
  }

  private async runTool(step: FakeToolStep, call: { toolName: string; input: Record<string, unknown>; toolUseId: string }, emit: TurnEventSink, signal: AbortSignal, startLate?: () => void): Promise<void> {
    const pre = await this.wiring.preToolUse(call);
    startLate?.();
    let input = call.input;
    let denied: string | null = null;
    if (pre.decision === "allow") input = pre.updatedInput ?? input;
    else if (pre.decision === "deny") { denied = pre.reason; if (pre.additionalContext) this.notes.push(pre.additionalContext); }
    else if (pre.decision === "defer") {
      emit({ kind: "tool_end", toolUseId: call.toolUseId, name: call.toolName, isError: true, output: pre.reason });
      this.abort?.abort();
      return;
    } else {
      const perm = await this.wiring.canUseTool(call, signal);
      if (perm.behavior === "allow") input = perm.updatedInput ?? input;
      else denied = perm.message;
    }
    if (denied !== null) {
      emit({ kind: "tool_end", toolUseId: call.toolUseId, name: call.toolName, isError: true, output: denied });
      return;
    }
    this.toolInFlight = true;
    let output: string;
    let isError = false;
    try {
      const botTool = this.wiring.botTools().find((t) => `mcp__bot__${t.name}` === call.toolName || `mcp__computer__${t.name}` === call.toolName);
      if (botTool) {
        const r = await botTool.handler(input);
        output = r.text + (r.images?.length ? ` [${r.images.length} image]` : "");
        isError = Boolean(r.isError);
      } else {
        if (step.delayMs) await new Promise<void>((r) => { const t = setTimeout(r, step.delayMs); signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
        output = step.output ?? (this.opts.toolRunner ? await this.opts.toolRunner(call.toolName, input) : `(fake) ${call.toolName} ok`);
      }
    } finally {
      this.toolInFlight = false;
    }
    this.lastToolOutput = output;
    const post = isError ? {} : await this.wiring.postToolUse({ ...call, input }, output);
    if (post.additionalContext) this.notes.push(post.additionalContext);
    emit({ kind: "tool_end", toolUseId: call.toolUseId, name: call.toolName, isError, output: post.replaceOutput ?? output });
  }

  pushUserMessage(msg: ModelMessage): void {
    this.pushed.push(msg);
  }

  async interrupt(_reason: string): Promise<void> {
    if (this.procState !== "running") return;
    this.setState("interrupted");
    this.abort?.abort();
  }

  async cool(_reason: string): Promise<void> {
    if (this.procState === "cold") return;
    this.abort?.abort();
    this.setState("cooling");
    this.pid = null;
    this.setState("cold");
  }

  async dispose(): Promise<void> {
    await this.cool("dispose");
  }
}
