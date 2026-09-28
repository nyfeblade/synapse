import { describe, expect, it, vi } from "vitest";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";

// Voice calls: idle → listening → thinking → speaking → (barge-in) listening, with the reply spoken
// sentence by sentence while it streams, one Bot at a time.

function harness() {
  const log: string[] = [];
  const pending: { text: string; botId?: string; done: () => void }[] = [];
  const cut: [string, string | undefined, string][] = [];
  const marks: string[] = [];
  const h = { now: 0, log, pending, cut, marks, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t) => { log.push(`send:${t}`); },
    speak: (t, o) => { log.push(`speak:${o?.botId ?? ""}:${t}${o?.queue ? " (queued)" : ""}`); return new Promise<void>((r) => pending.push({ text: t, botId: o?.botId, done: r })); },
    cancelSpeech: () => log.push("cancel"),
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    onInterrupted: (b, e, s) => cut.push([b, e, s]),
    mark: (w, ms) => marks.push(ms === undefined ? w : `${w}+${ms}`),
  });
  return h;
}
const speaks = (log: string[]) => log.filter((l) => l.startsWith("speak:"));
const finishOne = async (h: ReturnType<typeof harness>) => { h.pending.shift()!.done(); await Promise.resolve(); await Promise.resolve(); };

describe("call state machine", () => {
  it("walks idle → listening → thinking → speaking → listening", async () => {
    const h = harness();
    expect(h.loop.state).toBe("idle");
    h.loop.begin();
    expect(h.loop.state).toBe("listening");
    h.loop.onFinal("what time is it");
    expect(h.loop.state).toBe("thinking");
    h.loop.onBotStream("b", "It is nine. ");
    expect(h.loop.state).toBe("speaking");
    h.loop.onBotText("It is nine.", "b", "t1b");
    await finishOne(h);
    expect(h.loop.state).toBe("listening");
  });

  it("speaks the first sentence as soon as it is complete, queues the next, and says nothing twice", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("tell me about Tokyo");
    h.loop.onBotStream("b", "Tokyo is big");
    expect(speaks(h.log)).toEqual([]);
    expect(h.loop.state).toBe("thinking");
    h.loop.onBotStream("b", "Tokyo is big. It has fourteen million people. It");
    expect(speaks(h.log)).toEqual(["speak:b:Tokyo is big. (queued)", "speak:b:It has fourteen million people. (queued)"]);
    h.loop.onBotText("Tokyo is big. It has fourteen million people. It is the capital.", "b", "t1b");
    expect(speaks(h.log)).toHaveLength(3);
    expect(speaks(h.log)[2]).toBe("speak:b:It is the capital. (queued)");
    await finishOne(h); await finishOne(h);
    expect(h.loop.state).toBe("speaking");
    await finishOne(h);
    expect(h.loop.state).toBe("listening");
  });

  it("barge-in cancels what is playing and everything queued, and the reply is cut at what was said", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("tell me a story");
    h.loop.onBotStream("b", "Once upon a time. There was a fox. It");
    await finishOne(h); // "Once upon a time" was spoken
    h.loop.onSpeechStart();
    expect(h.log).toContain("cancel");
    expect(h.loop.state).toBe("listening");
    // The rest keeps streaming into the chat but is never spoken.
    h.loop.onBotStream("b", "Once upon a time. There was a fox. It ran away. The end.");
    h.loop.onBotText("Once upon a time. There was a fox. It ran away. The end.", "b", "t2b");
    expect(speaks(h.log)).toHaveLength(2);
    // Bug 187: the chat marks the cut once the user's words show it was a real interruption (not "mm-hm").
    expect(h.cut).toEqual([]);
    h.loop.onFinal("wait, which fox?");
    expect(speaks(h.log)).toHaveLength(2);
    expect(h.cut).toEqual([["b", "t2b", "Once upon a time."]]);
    // A late end of the cut-off speech changes nothing: the user's new turn owns the state.
    h.pending.shift()?.done();
    await Promise.resolve();
    expect(h.loop.state).toBe("thinking");
  });

  it("group call: one Bot speaks at a time; the next waits its turn", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what should we cook");
    h.loop.onBotStream("nova", "Pasta. ");
    h.loop.onBotStream("ledger", "Rice is cheaper. ");
    expect(speaks(h.log)).toEqual(["speak:nova:Pasta. (queued)"]);
    h.loop.onBotText("Pasta.", "nova", "e1");
    h.loop.onBotText("Rice is cheaper.", "ledger", "e2");
    await finishOne(h);
    expect(speaks(h.log)).toEqual(["speak:nova:Pasta. (queued)", "speak:ledger:Rice is cheaper. (queued)"]);
    await finishOne(h);
    expect(h.loop.state).toBe("listening");
  });

  it("the stream's last text arriving after the final message is not spoken again", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("hi");
    h.loop.onBotStream("b", "Hello there. How are");
    h.loop.onBotText("Hello there. How are you?", "b", "e1");
    h.loop.onBotStream("b", "Hello there. How are you?"); // a late typing event for the same reply
    expect(speaks(h.log)).toEqual(["speak:b:Hello there. (queued)", "speak:b:How are you? (queued)"]);
  });

  it("a (pass) is never spoken", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("anyone?");
    h.loop.onBotText("(pass)", "ledger", "e3");
    expect(speaks(h.log)).toEqual([]);
  });

  it("marks the latency: sent, first reply text and first audio out, timed from the end of turn", () => {
    const h = harness();
    h.loop.begin();
    h.now = 1000; h.loop.onFinal("hi");
    h.now = 2400; h.loop.onBotStream("b", "Hey");
    h.now = 2600; h.loop.onBotStream("b", "Hey there. ");
    h.now = 2700; h.loop.onAudioOut();
    h.now = 3000; h.loop.onAudioOut();
    expect(h.marks).toEqual(["sent", "first-text+1400", "first-audio+1700"]);
  });

  it("an 'on it' line, then a later message while the work runs, are both spoken", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("fix the build");
    h.loop.onBotText("On it, running the tests now.", "b", "e1");
    await finishOne(h);
    expect(h.loop.state).toBe("listening");
    h.loop.onBotStream("b", "All green. ");
    expect(h.loop.state).toBe("speaking");
    vi.useRealTimers();
  });
});
