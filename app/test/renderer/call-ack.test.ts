import { describe, expect, it } from "vitest";
import { STRV } from "@synapse/shared";
import { ackLines, phraseBags, stockLines } from "../../src/renderer/voice/call-phrases";
import { ackMood, VoiceLoop, type PhraseKind } from "../../src/renderer/voice/voice-loop";

// Bug 218 (the user's choice (a)): a short sound in the Bot's own voice the moment the user stops — only when the
// answer can't start at once, varied, pre-rendered (no model call). The call-level timing is pinned in
// host/test/voice/voice-latency-budget.test.ts; these are the pieces.

function loop() {
  const log: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const h = { now: 0, log, sendResult: undefined as unknown, holdPhrases: false, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => {}, stop: () => {},
    send: (t, _d, x) => { log.push(`send:${t}${x?.speculated ? " (speculated)" : ""}`); return Promise.resolve(h.sendResult); },
    speak: (t, s) => { log.push(`speak:${s?.phrase ? `(${s.phrase}) ` : ""}${t}`); return s?.phrase && !h.holdPhrases ? Promise.resolve() : new Promise<void>(() => {}); },
    cancelSpeech: () => log.push("cancel"), now: () => h.now, silenceMs: 700, helperEndpoints: true,
    members: () => [{ id: "nova", name: "Nova" }],
    phrase: (kind: string, _who: string, mood?: string) => (kind === "ack" ? `ack-${mood}` : `${kind} line`),
    speculate: (t) => log.push(`speculate:${t}`), cancelSpeculation: () => log.push("cancel-spec"),
    after: (ms, fn) => { timers.push({ at: h.now + ms, fn }); },
  });
  const advance = async (ms: number) => {
    const end = h.now + ms;
    for (let i = 0; i < 5; i++) await Promise.resolve(); // what is already settled runs first, as in real time
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      h.now = t.at;
      t.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    h.now = end;
  };
  h.loop.begin();
  return Object.assign(h, { advance });
}
const acks = (log: string[]) => log.filter((l) => l.startsWith("speak:(ack)"));

describe("bug 218: the end-of-turn sound", () => {
  it("no kept start: the sound goes a natural beat (~250 ms) after the user's final, not at it", async () => {
    const h = loop();
    h.loop.onFinal("What's on my calendar tomorrow?");
    await h.advance(200);
    expect(acks(h.log)).toEqual([]);
    await h.advance(60);
    expect(acks(h.log)).toEqual(["speak:(ack) ack-question"]);
  });

  it("review 1: the answer ready within 300 ms — no sound", async () => {
    const h = loop();
    h.loop.onFinal("What's the weather?");
    await h.advance(200);
    h.loop.onBotStream("nova", "It's sunny and warm. ");
    await h.advance(200);
    expect(acks(h.log)).toEqual([]);
    expect(h.log).toContain("speak:It's sunny and warm.");
  });

  it("review 1: the user started again after their final — no sound", async () => {
    const h = loop();
    h.loop.onFinal("So I was thinking");
    await h.advance(120);
    h.loop.onSpeechStart();
    h.loop.onPartial("about the launch");
    await h.advance(300);
    expect(acks(h.log)).toEqual([]);
  });

  it("review 1: talking over the sound cuts it (the fade) and nothing else: no 'sorry', the answer still comes", async () => {
    const h = loop();
    h.holdPhrases = true; // the sound is still playing when the user talks
    h.loop.onFinal("what's the weather");
    await h.advance(260);
    expect(acks(h.log)).toHaveLength(1);
    h.loop.onSpeechStart(); // the user goes on, over the "Mm."
    expect(h.log.at(-1)).toBe("cancel"); // the sound fades out
    h.loop.onPartial("for tomorrow");
    h.loop.onFinal("for tomorrow");
    await h.advance(300);
    expect(h.log.some((l) => l.startsWith("speak:(sorry)"))).toBe(false);
    expect(h.log.filter((l) => l.startsWith("send:"))).toEqual(["send:what's the weather", "send:for tomorrow"]);
    // The first answer was never cancelled: it still plays when it arrives.
    h.loop.onBotStream("nova", "It's sunny tomorrow. ");
    expect(h.log).toContain("speak:It's sunny tomorrow.");
  });

  it("review 1: hanging up mid-speculation leaves nothing for the next call", async () => {
    const h = loop();
    h.loop.onLikelyEnd("book a table");
    await h.advance(100);
    expect(h.log).toContain("speculate:book a table");
    h.loop.end();
    h.loop.begin();
    h.loop.onPartial("hello");
    expect(h.log).not.toContain("cancel-spec");
    h.loop.onLikelyEnd("hello there");
    await h.advance(100);
    expect(h.log.at(-1)).toBe("speculate:hello there");
  });

  it("a kept start whose reply the host says already has words: no sound, the answer plays alone", async () => {
    const h = loop();
    h.sendResult = { entryId: "u1", ready: true };
    h.loop.onLikelyEnd("What's on my calendar tomorrow?");
    await h.advance(600); // the start is old enough to have words
    h.loop.onFinal("What's on my calendar tomorrow?");
    await h.advance(400);
    expect(h.log).toContain("send:What's on my calendar tomorrow? (speculated)");
    expect(acks(h.log)).toEqual([]);
  });

  it("a kept start with no words yet: the sound goes as soon as the host says so", async () => {
    const h = loop();
    h.sendResult = { entryId: "u1", ready: false };
    h.loop.onLikelyEnd("Book a table for four.");
    await h.advance(600);
    h.loop.onFinal("Book a table for four.");
    await h.advance(1);
    expect(acks(h.log)).toEqual(["speak:(ack) ack-request"]);
  });

  it("never while the user is talking again, and never once the answer's text is streaming", async () => {
    const h = loop();
    h.sendResult = { entryId: "u1" };
    h.loop.onLikelyEnd("so I was thinking");
    await h.advance(600);
    h.loop.onFinal("so I was thinking");
    h.loop.onSpeechStart(); // the user goes on before the sound
    await h.advance(400);
    expect(acks(h.log)).toEqual([]);
    const k = loop();
    k.sendResult = { entryId: "u1" };
    k.loop.onLikelyEnd("what's the weather");
    await k.advance(600);
    k.loop.onFinal("what's the weather");
    k.loop.onBotStream("nova", "It's sunny");
    await k.advance(400);
    expect(acks(k.log)).toEqual([]);
  });

  it("with a sound played, the filler waits longer (one cover sound, not two back to back)", async () => {
    const h = loop();
    h.loop.onFinal("Summarise the doc.");
    await h.advance(260);
    expect(acks(h.log)).toHaveLength(1);
    for (let t = 0; t < 2_000; t += 100) { h.now += 100; h.loop.tick(); }
    expect(h.log.filter((l) => l.startsWith("speak:(filler)"))).toEqual([]); // it would have played at 1,500 ms
    for (let t = 0; t < 600; t += 100) { h.now += 100; h.loop.tick(); }
    expect(h.log.filter((l) => l.startsWith("speak:(filler)"))).toEqual(["speak:(filler) filler line"]);
  });

  it("reads the user's words for the kind of sound", () => {
    expect(ackMood("What's on my calendar tomorrow?")).toBe("question");
    expect(ackMood("did Sam text me back")).toBe("question");
    expect(ackMood("Can you read me the last email from Priya?")).toBe("request");
    expect(ackMood("Text Sam that I'm running late.")).toBe("request");
    expect(ackMood("okay, remind me to call the dentist")).toBe("request");
    expect(ackMood("Thanks, that's perfect.")).toBe("other");
    expect(ackMood("So I was thinking about the launch")).toBe("other");
  });
});

describe("bug 218: the sounds themselves", () => {
  it("are short and pre-rendered with the call's other stock lines (no model call, no live render)", () => {
    for (const t of ackLines()) expect(t.length).toBeLessThan(12);
    for (const t of ackLines()) expect(stockLines()).toContain(t);
    expect(new Set(ackLines()).size).toBeGreaterThanOrEqual(8);
  });

  it("only a sound already rendered in the Bot's voice is drawn; none ready = no sound", () => {
    const ready = new Set(["Mm-hm.", "Yeah."]);
    const bags = phraseBags({ ready: (_who, t) => ready.has(t), rand: () => 0.3 });
    const drawn = Array.from({ length: 6 }, () => bags.next("ack", "nova", "other"));
    expect(drawn.every((t) => t === "Mm-hm." || t === "Yeah.")).toBe(true);
    const none = phraseBags({ ready: () => false });
    expect(none.next("ack", "nova", "question")).toBeNull();
  });

  it("a shuffle bag per kind of sound: every sound once before any repeats", () => {
    const bags = phraseBags({ rand: () => 0.42 });
    const n = STRV.acks.request.length;
    const first = Array.from({ length: n }, () => bags.next("ack", "nova", "request"));
    expect(new Set(first).size).toBe(n);
  });

  it("the loop never says the same sound twice running, even across kinds", async () => {
    const texts = ["Mm.", "Mm.", "Hmm."];
    const h = loop();
    const said: string[] = [];
    (h.loop as unknown as { d: { phrase: (k: PhraseKind) => string | null } }).d.phrase = () => texts.shift() ?? null;
    h.loop.onFinal("what time is it");
    await h.advance(260);
    said.push(...acks(h.log));
    expect(said).toEqual(["speak:(ack) Mm."]);
  });
});
