import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { ScriptedFrontSession, SdkFrontSession, type FrontSpec } from "../../voice/front-session";
import { VoiceFronts } from "../../voice/front";
import type { QueryFn } from "../../usage/metered-query";

// Speed plan #8b (bug 216): a speculative start the user talked past never reaches the model if it is still queued.
// The voice runs its turns one after another, so a stale run used to hold the real turn back until it had streamed
// its whole reply (voice.log: first text p50 ~1,509 ms after a cancel against ~810 with no speculation). A run
// already streaming is NOT interrupted: Query.interrupt() ends the CLI's query for good (CT-03), and a fresh voice
// costs a cold start and the call's context — more than the ~0.5 s the stale reply has left. Fewer runs go stale in
// the first place: the loop waits 60 ms for Apple's trailing partial (voice-latency-budget.test.ts).

const LONG = "Sure, here is a fairly long answer that keeps going for a while so the stale run takes real time to stream out.";

function harness() {
  const typing: { at: number; text: string | null }[] = [];
  const began: { at: number; message: string }[] = [];
  const sessions: ScriptedFrontSession[] = [];
  const bot = { id: "nova", profile: { name: "Nova", title: "", description: "", model: "claude-sonnet-5" } } as unknown as BotSummary;
  const fronts = new VoiceFronts({
    bots: { has: () => true, summary: () => bot, appendEntry: () => {}, publishTyping: (_i, t, p) => { if (t) typing.push({ at: Date.now(), text: p }); }, tail: () => [] as TranscriptEntry[], nextTurnNo: () => 1 },
    runner: { recordVoiceUtterance: () => ({ entryId: "u" }), enqueueWake: () => "w" },
    gate: null, calls: { roster: () => ["nova"] },
    factory: (spec: FrontSpec) => { const s = new ScriptedFrontSession(spec, (m) => { began.push({ at: Date.now(), message: m }); return { text: LONG, firstTextMs: 600 }; }, { chunkMs: 40 }); sessions.push(s); return s; },
    enabled: () => true, now: () => Date.now(),
  });
  fronts.callChanged("nova");
  return { fronts, typing, sessions, began };
}

beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

describe("speed plan #8b: a cancelled speculative run that is still queued never runs", () => {
  it("a cancelled speculation still queued adds at most 50 ms to the real turn (it used to add its whole reply)", async () => {
    const h = harness();
    h.fronts.userPost("nova", "hey", "n0"); // the voice is busy with a turn
    await vi.advanceTimersByTimeAsync(100);
    h.fronts.speculate("nova", "s1", "what's on my calendar"); // queued behind it
    await vi.advanceTimersByTimeAsync(100);
    h.fronts.cancelSpeculation("nova", "s1");
    h.fronts.userPost("nova", "what's on my calendar tomorrow", "n1");
    await vi.advanceTimersByTimeAsync(20_000);
    const n0End = 600 + LONG.split(/(?<=\s)/).length * 40; // the turn ahead of it: first text, then its words
    const real = h.began.find((b) => b.message.endsWith("User: what's on my calendar tomorrow"))!;
    expect(real.at - n0End).toBeLessThanOrEqual(50);
  });

  it("a speculation cancelled before its run began never reaches the model", async () => {
    const h = harness();
    h.fronts.userPost("nova", "hey", "n0"); // a turn in flight: the speculation queues behind it
    h.fronts.speculate("nova", "s1", "and what about");
    h.fronts.cancelSpeculation("nova", "s1");
    h.fronts.userPost("nova", "and what about tomorrow", "n1");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sessions[0]!.messages.filter((m) => m.includes("User: and what about\n") || m.endsWith("User: and what about"))).toEqual([]);
    expect(h.sessions[0]!.messages.some((m) => m.endsWith("User: and what about tomorrow"))).toBe(true);
  });

  it("review 1: a start dropped before it reached the model tells the voice nothing (it never saw that reply)", async () => {
    const h = harness();
    h.fronts.userPost("nova", "hey", "n0"); // the voice is busy: the start queues behind it
    h.fronts.speculate("nova", "s1", "and what about");
    h.fronts.cancelSpeculation("nova", "s1");
    h.fronts.userPost("nova", "and what about tomorrow", "n1");
    await vi.advanceTimersByTimeAsync(20_000);
    const last = h.sessions[0]!.messages.at(-1)!;
    expect(last.endsWith("User: and what about tomorrow")).toBe(true);
    expect(last).not.toContain("since your last heard reply");
  });

  it("the voice is still told its last reply was dropped (the correction note rides the next turn)", async () => {
    const h = harness();
    h.fronts.speculate("nova", "s1", "book a table");
    await vi.advanceTimersByTimeAsync(700);
    h.fronts.cancelSpeculation("nova", "s1");
    h.fronts.userPost("nova", "book a table for four", "n1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sessions[0]!.messages.at(-1)).toContain("since your last heard reply");
  });

  it("SdkFrontSession: a turn aborted before it began never reaches the CLI; one in flight is not interrupted", async () => {
    vi.useRealTimers();
    const events: string[] = [];
    let wake: (() => void) | null = null;
    const pending: unknown[] = [];
    // A fake query: each user message streams a text delta, then waits; interrupt() ends the turn with a result.
    const queryFn = ((params: { prompt: AsyncIterable<unknown> }) => {
      const out = (async function* () {
        for await (const m of params.prompt) {
          const text = (m as { message: { content: { text: string }[] } }).message.content[0]!.text;
          events.push(`in:${text}`);
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: `re:${text}` } } };
          if (text === "stale") await new Promise<void>((r) => { wake = r; });
          yield { type: "result", subtype: pending.length ? "error_during_execution" : "success", is_error: pending.length > 0, usage: {} };
          pending.length = 0;
        }
      })();
      return Object.assign(out, { interrupt: async () => { events.push("interrupt"); pending.push(1); wake?.(); }, close: () => {} });
    }) as unknown as QueryFn;
    const s = new SdkFrontSession({ botId: "nova", model: "m", system: "s" }, { env: {}, cwd: "/", queryFn });
    const inFlight = new AbortController();
    const first = s.turn("stale", () => {}, () => {}, inFlight.signal); // in flight, waiting
    const queued = new AbortController();
    const skipped = s.turn("never", () => {}, () => {}, queued.signal);
    queued.abort();
    await new Promise((r) => setTimeout(r, 20));
    inFlight.abort(); // aborting after it began changes nothing for the CLI (no interrupt: it would end the query)
    wake!();
    expect((await first).text).toBe("re:stale");
    expect((await skipped).error).toBe("interrupted");
    expect((await s.turn("real", () => {}, () => {})).text).toBe("re:real");
    expect(events).toEqual(["in:stale", "in:real"]);
    s.close();
  });
});
