import type { ModelMessage, SupervisedBrain, TurnEvent, TurnResult } from "../../brain/types";
import { LoopGuard, type LoopTrip } from "../../runner/loop-guard";
import { AsyncQueue } from "../../util/async-queue";
import type { CodingChild, CodingEngineId, CodingMessage } from "./types";

/**
 * A coding agent driven through a SupervisedBrain (ProviderBrain for provider-loop, AcpBrain for a vendor CLI): the task
 * is the first turn; a reply or the time-up nudge joins the running turn at its next step (or starts the next turn);
 * Stop ends the step and the agent waits for a message; close ends it for good. The agent settles with ONE `result`:
 * its last message when a turn ends with nothing pending, or the reason it stopped.
 *
 * The runner's loop guard (runner/loop-guard.ts) watches every step, as it watches every Bot: the same tool failing the
 * same way, or the same call repeating with nothing changed, stops the agent with a plain reason.
 */
export interface LoopChildDeps {
  engine: CodingEngineId;
  /** The loop guard's key and the turns' request ids: the agent id. */
  key: string;
  model: string;
  brain: SupervisedBrain & { readonly pendingMessages?: number };
  /** A model-call cap for the whole task (the brain's own per-turn cap is set to it too). */
  maxModelCalls: number;
  /** A new step starts: the signal tool handlers use (a running command stops with it). */
  onStep?(signal: AbortSignal): void;
  /** The engine's session id (for a later resume). */
  session?(): string | null;
  now?(): number;
}

const TRANSCRIPT_OUTPUT_MAX = 4_000;
export const LOOP_STOPPED = (t: LoopTrip) => `Stopped: the agent kept failing at ${t.step} (${t.tries} tries), so Synapse ended it. Its work so far is on the branch.`;
export const CALLS_STOPPED = (n: number) => `Stopped after ${n} model calls without finishing. Its work so far is on the branch.`;

export class LoopChild implements CodingChild {
  private q = new AsyncQueue<CodingMessage>();
  private closed = false;
  private running = false;
  private waiting: string[] = [];
  private wake: (() => void) | null = null;
  private step = new AbortController();
  private guard: LoopGuard;
  private calls = 0;
  private turns = 0;

  constructor(private d: LoopChildDeps, prompt: string) {
    this.guard = new LoopGuard(d.now ?? Date.now);
    void this.run([{ text: prompt }]);
  }

  get messages(): AsyncIterable<CodingMessage> { return this.q; }

  sessionId(): string | null { return this.d.session?.() ?? null; }

  push(text: string): void {
    if (this.closed) return;
    if (this.running) this.d.brain.pushUserMessage({ text });
    else { this.waiting.push(text); this.wake?.(); }
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    this.step.abort();
    await this.d.brain.interrupt("coding agent: stopped");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.step.abort();
    void this.d.brain.interrupt("coding agent: closed").catch(() => {}).finally(() => { void this.d.brain.dispose().catch(() => {}); });
    this.q.end();
    this.wake?.();
  }

  private emit(m: CodingMessage): void {
    if (!this.closed && !this.q.isClosed) this.q.push(m);
  }

  private settle(ok: boolean, text: string): void {
    this.emit({ type: "result", subtype: ok ? "success" : "error", result: text, engine: this.d.engine, model: this.d.model, metered: true });
  }

  private async run(first: ModelMessage[]): Promise<void> {
    let prompt = first;
    for (;;) {
      if (this.closed) return;
      this.step = new AbortController();
      this.d.onStep?.(this.step.signal);
      this.running = true;
      this.guard.turnStart(this.d.key, "coding-agent");
      let text = "";
      let tripped: LoopTrip | null = null;
      const flush = () => { if (text.trim()) this.emit({ type: "progress", step: "text", text }); text = ""; };
      const sink = (e: TurnEvent) => {
        if (this.closed) return;
        if (e.kind === "thinking" && e.active) this.calls++;
        else if (e.kind === "retry") this.calls--;
        else if (e.kind === "text_delta") text += e.text;
        else if (e.kind === "tool_start") { flush(); this.emit({ type: "progress", step: "tool", id: e.toolUseId, name: e.name, input: e.input }); }
        else if (e.kind === "tool_end") this.emit({ type: "progress", step: "tool_result", id: e.toolUseId, name: e.name, isError: e.isError, output: e.output.slice(0, TRANSCRIPT_OUTPUT_MAX) });
        const trip = this.guard.event(this.d.key, e);
        if (trip && !tripped) {
          tripped = trip;
          this.step.abort();
          void this.d.brain.interrupt("coding agent: loop guard");
        }
      };
      let r: TurnResult;
      try {
        r = await this.d.brain.runTurn({
          prompt, hidden: false, lane: "background", source: "coding-agent", silenceAllowed: true,
          requestId: `${this.d.key}-${++this.turns}`, systemAppend: "", model: this.d.model, autoReviewEpoch: "continue",
        }, sink);
      } catch (e) {
        this.running = false;
        if (!this.closed) this.settle(false, `The coding agent failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
        return;
      } finally {
        flush();
      }
      this.running = false;
      if (this.closed) return;
      if (tripped) { this.settle(false, LOOP_STOPPED(tripped)); return; }
      if (r.error) { this.settle(false, r.error.message); return; }
      if (this.calls >= this.d.maxModelCalls) { this.settle(false, CALLS_STOPPED(this.calls)); return; }
      // A message that arrived during the turn (and wasn't taken in it) starts the next one.
      if ((this.d.brain.pendingMessages ?? 0) > 0 || this.waiting.length) { prompt = this.waiting.splice(0).map((t) => ({ text: t })); continue; }
      if (r.aborted) {
        // Stopped with nothing to do next: wait for the next message (a reply), as the Claude Code session does.
        await new Promise<void>((res) => { this.wake = res; if (this.waiting.length || this.closed) res(); });
        this.wake = null;
        if (this.closed) return;
        prompt = this.waiting.splice(0).map((t) => ({ text: t }));
        continue;
      }
      this.settle(true, r.finalText.trim() || "The coding agent finished without a report.");
      return;
    }
  }
}
