import { describe, expect, it } from "vitest";
import { SPEECH_STALL_MS, VoiceLoop } from "../../src/renderer/voice/voice-loop";
import { SentenceChunker } from "../../src/renderer/voice/sentences";

// voice-stall (bug-log 128): "after a while the AI voice stops working". voice.log, call ce221ffa:
// a two-Bot call (bm_george, then am_fenrir); the user's turn 7 ended while Fenrir was still speaking
// (helper end of turn reason=bot-spoke), and from then on replies arrived (mark first-text) but no
// line was ever spoken again.

function harness(o: { hang?: boolean } = {}) {
  const log: string[] = [];
  const pending: { text: string; botId?: string; done: () => void }[] = [];
  const marks: string[] = [];
  const h = { now: 0, log, pending, marks, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t) => { log.push(`send:${t}`); },
    speak: (t, s) => { log.push(`speak:${s?.botId ?? ""}:${t}`); return new Promise<void>((r) => pending.push({ text: t, botId: s?.botId, done: o.hang ? () => {} : r })); },
    cancelSpeech: () => log.push("cancel"),
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    mark: (w, ms) => marks.push(ms === undefined ? w : `${w}+${ms}`),
  });
  return h;
}
type H = ReturnType<typeof harness>;
const spoken = (h: H) => h.log.filter((l) => l.startsWith("speak:"));
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const finishAll = async (h: H) => { while (h.pending.length) { h.pending.shift()!.done(); await flush(); } };
const tickFor = (h: H, ms: number) => { for (let t = 0; t < ms; t += 200) { h.now += 200; h.loop.tick(); } };

describe("voice-stall: speech never stops for good", () => {
  it("reproduces ce221ffa: a user turn ending while one Bot speaks no longer silences the other Bot", async () => {
    const h = harness();
    h.loop.begin();
    // Turn 6 → Fenrir answers in two sentences; the first is spoken, the second (long) is still playing…
    h.loop.onFinal("what do you think Fenrir");
    h.loop.onBotStream("fenrir", "I think so. ");
    await finishAll(h);
    h.loop.onBotStream("fenrir", "I think so. And here is a much longer second sentence that takes about ten seconds to say out loud. ");
    expect(spoken(h).at(-1)).toMatch(/^speak:fenrir:And here/);
    // …when the helper ends the user's next turn because the Bot spoke (reason=bot-spoke).
    h.loop.onFinal("and George what about you");
    expect(h.loop.state).toBe("thinking");
    h.loop.onBotText("I think so. And here is a much longer second sentence that takes about ten seconds to say out loud.", "fenrir", "e-f");
    await finishAll(h); // sp-9 ends while the loop is "thinking"
    // Turn 7's reply comes from George: it must be spoken.
    h.loop.onBotStream("george", "Sure. I agree with him.");
    h.loop.onBotText("Sure. I agree with him.", "george", "e-g");
    expect(spoken(h).filter((l) => l.startsWith("speak:george"))).toEqual(["speak:george:Sure.", "speak:george:I agree with him."]);
    await finishAll(h);
    expect(h.loop.state).toBe("listening");
    expect(h.marks.filter((m) => m.startsWith("stall"))).toEqual([]); // fixed at the root, not by the watchdog
  });

  it("a long call: 30 turns, two voices, long sentences, users talking over the end of replies — every reply is spoken", async () => {
    const h = harness();
    h.loop.begin();
    let expected = 0;
    for (let turn = 0; turn < 30; turn++) {
      const bot = turn % 3 === 0 ? "fenrir" : "george";
      h.loop.onFinal(`question ${turn}`);
      const long = `Answer ${turn} starts here. ${"This sentence is deliberately long, with clauses, and more clauses, so that it runs on for a while".repeat(2)}. Done ${turn}.`;
      h.loop.onBotStream(bot, long.slice(0, 40));
      h.loop.onBotStream(bot, long);
      h.loop.onBotText(long, bot, `e${turn}`);
      expected += new SentenceChunker().finish(long).length;
      if (turn % 4 === 1) { h.pending.shift()!.done(); await flush(); } // the user's next turn lands mid-reply
      else await finishAll(h);
      tickFor(h, 400);
    }
    await finishAll(h);
    expect(spoken(h)).toHaveLength(expected);
    expect(h.loop.state).not.toBe("idle");
  });

  it("a Bot whose cut-off reply never got its final message still speaks its next reply", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("tell me a story");
    h.loop.onBotStream("george", "Once upon a time there was a fox. It");
    h.loop.onSpeechStart(); // the user talks over it; that reply's final message never arrives
    h.loop.onFinal("stop, what's the weather");
    h.loop.onBotStream("george", "It's sunny. ");
    h.loop.onBotText("It's sunny.", "george", "e2");
    expect(spoken(h).at(-1)).toBe("speak:george:It's sunny.");
  });

  it("…while the cut reply's own late final is still not spoken", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("tell me a story");
    h.loop.onBotStream("george", "Once upon a time there was a fox. It");
    h.loop.onSpeechStart();
    const before = spoken(h).length;
    h.loop.onBotStream("george", "Once upon a time there was a fox. It ran away. The end.");
    h.loop.onBotText("Once upon a time there was a fox. It ran away. The end.", "george", "e1");
    expect(spoken(h)).toHaveLength(before);
  });

  it("watchdog: a line whose end is never reported is let go, logged as stall-line, and the next reply is spoken", async () => {
    const h = harness({ hang: true });
    h.loop.begin();
    h.loop.onFinal("hi");
    h.loop.onBotText("Hello there.", "george", "e1");
    expect(spoken(h)).toEqual(["speak:george:Hello there."]);
    tickFor(h, 8_000 + 11 * 200 + 400);
    expect(h.marks).toContain("stall-line");
    expect(h.loop.state).toBe("listening");
    h.loop.onFinal("again");
    h.loop.onBotText("Still here.", "fenrir", "e2");
    expect(spoken(h).at(-1)).toBe("speak:fenrir:Still here.");
  });

  it("watchdog: reply text that sits unspoken for 3 s (a stream that stopped short of a sentence end) is spoken, and logged", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("status?");
    h.loop.onBotStream("george", "The build is green and the deploy is waiting on you");
    expect(spoken(h)).toEqual([]);
    tickFor(h, SPEECH_STALL_MS + 400);
    expect(h.marks.some((m) => m.startsWith("stall+"))).toBe(true);
    expect(spoken(h)).toEqual(["speak:george:The build is green and the deploy is waiting on you."]);
    // The rest of the stream continues after what was said; nothing is said twice.
    h.loop.onBotText("The build is green and the deploy is waiting on you. Approve it?", "george", "e1");
    expect(spoken(h)).toEqual(["speak:george:The build is green and the deploy is waiting on you.", "speak:george:Approve it?"]);
  });

  it("watchdog: a floor held by a Bot that stopped streaming (no final) is released after 3 s for the waiting Bot", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("both of you");
    h.loop.onBotStream("fenrir", "One. ");
    await finishAll(h); // fenrir keeps the floor: its reply isn't final
    h.loop.onBotText("George here.", "george", "e2");
    expect(spoken(h).some((l) => l.startsWith("speak:george"))).toBe(false);
    tickFor(h, SPEECH_STALL_MS + 400);
    expect(spoken(h).at(-1)).toBe("speak:george:George here.");
    expect(h.marks.some((m) => m.startsWith("stall+"))).toBe(true);
  });

  it("the watchdog stays quiet on a healthy call", async () => {
    const h = harness();
    h.loop.begin();
    for (let i = 0; i < 5; i++) {
      h.loop.onFinal(`q${i}`);
      h.loop.onBotText(`Answer ${i}. More ${i}.`, i % 2 ? "george" : "fenrir", `e${i}`);
      tickFor(h, 1_000);
      await finishAll(h);
      tickFor(h, 5_000);
    }
    expect(h.marks.filter((m) => m.startsWith("stall"))).toEqual([]);
  });
});

describe("SentenceChunker.flush / hasPending", () => {
  it("flushes a stream stopped mid-sentence, then continues after it", () => {
    const c = new SentenceChunker();
    expect(c.push("Waiting on you")).toEqual([]);
    expect(c.hasPending("Waiting on you")).toBe(true);
    expect(c.flush("Waiting on you")).toEqual(["Waiting on you."]);
    expect(c.hasPending("Waiting on you")).toBe(false);
    expect(c.finish("Waiting on you. Go?")).toEqual(["Go?"]);
  });
});
