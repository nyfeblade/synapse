import { describe, expect, it } from "vitest";
import { CALL_FEEL } from "@synapse/shared";
import { VoiceLoop, type PhraseKind } from "../../src/renderer/voice/voice-loop";

// The call-behaviour branch ("better logic for how bots act during calls; it's clunky"), the loop's side: what the
// Bot does around the user's own speech. Each case is a clunky moment counted on the user's real calls
// (~/Library/Logs/Synapse/voice.log*, 236 user turns).

type Member = { id: string; name: string };
function harness(o: { members?: Member[] } = {}) {
  const log: string[] = [];
  const pending: { text: string; botId?: string; phrase?: PhraseKind; done: () => void }[] = [];
  const sends: { text: string; extra?: Record<string, unknown> }[] = [];
  const marks: string[] = [];
  const h = { now: 0, log, pending, sends, marks, loop: null as unknown as VoiceLoop };
  const members = o.members ?? [{ id: "nova", name: "Nova" }];
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t, _d, extra) => { log.push(`send:${t}`); sends.push({ text: t, ...(extra ? { extra: extra as Record<string, unknown> } : {}) }); },
    speak: (t, s) => {
      log.push(`speak:${s?.phrase ? `(${s.phrase}) ` : ""}${t}`);
      return new Promise<void>((r) => pending.push({ text: t, botId: s?.botId, phrase: s?.phrase, done: r }));
    },
    cancelSpeech: () => log.push("cancel"),
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    phrase: (kind, botId) => `${kind} line from ${botId}`,
    members: () => members,
    mark: (what) => marks.push(what),
  });
  return h;
}
type H = ReturnType<typeof harness>;
const spoken = (h: H) => h.log.filter((l) => l.startsWith("speak:"));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const finishAll = async (h: H) => { while (h.pending.length) { h.pending.shift()!.done(); await flush(); } };
const tickFor = (h: H, ms: number) => { for (let t = 0; t < ms; t += 100) { h.now += 100; h.loop.tick(); } };

describe("plan item 5: a wordless onset the helper dropped no longer counts as the user talking", () => {
  it("speech-start then speech-drop while thinking: the filler still comes at fillerAfterMs", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's on my calendar tomorrow");
    h.now += 300;
    h.loop.onSpeechStart(); // a cough
    h.now += 400;
    h.loop.onSpeechDrop(); // the helper: no words, dropped
    tickFor(h, CALL_FEEL.fillerAfterMs - 600);
    expect(spoken(h)).toEqual(["speak:(filler) filler line from nova"]);
  });

  it("without the drop the same cough would have silenced the filler (the event is what clears it)", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's on my calendar tomorrow");
    h.now += 300;
    h.loop.onSpeechStart();
    tickFor(h, CALL_FEEL.fillerAfterMs);
    expect(spoken(h)).toEqual([]);
  });

  it("a drop on an idle call is ignored", () => {
    const h = harness();
    h.loop.onSpeechDrop();
    expect(h.loop.state).toBe("idle");
  });
});

describe("plan item 3: the Bot never starts speaking over an utterance the user has open", () => {
  it("a reply that streams in while the user is talking again waits for their final, then plays", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's the weather");
    h.now += 3_000; // well after the turn: a new thought, not the same one going on
    h.loop.onSpeechStart();
    h.now += 200;
    h.loop.onBotStream("nova", "It's sunny all day. ");
    h.loop.onPartial("and");
    tickFor(h, 1_000);
    h.loop.onPartial("and what about tomorrow");
    tickFor(h, 1_000);
    expect(spoken(h)).toEqual([]);
    expect(h.loop.state).not.toBe("speaking");
    h.loop.onFinal("and what about tomorrow?");
    expect(spoken(h)).toEqual(["speak:It's sunny all day."]);
    expect(h.sends.map((s) => s.text)).toEqual(["what's the weather", "and what about tomorrow?"]);
    await finishAll(h);
  });

  it("the helper dropping the utterance (no words) lets the held reply go at once", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's the weather");
    h.now += 3_000;
    h.loop.onSpeechStart();
    h.loop.onBotStream("nova", "It's sunny all day. ");
    expect(spoken(h)).toEqual([]);
    h.now += 300;
    h.loop.onSpeechDrop();
    expect(spoken(h)).toEqual(["speak:It's sunny all day."]);
  });

  it("a noise onset that never becomes words can't hold a ready answer: it goes 1.5 s after the last sign of speech", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's the weather");
    h.now += 3_000;
    h.loop.onSpeechStart();
    h.loop.onBotStream("nova", "It's sunny all day. ");
    tickFor(h, 1_300);
    expect(spoken(h)).toEqual([]);
    tickFor(h, 300);
    expect(spoken(h)).toEqual(["speak:It's sunny all day."]);
  });

  it("the call's own lines wait too: a greeting never starts over a user who is already talking", () => {
    const h = harness();
    h.loop.begin();
    h.now = 1_000;
    h.loop.onSpeechStart();
    void h.loop.say("nova", "Hey, what's up?", "greeting");
    expect(spoken(h)).toEqual([]);
    h.loop.onFinal("hi Nova");
    expect(spoken(h)[0]).toBe("speak:(greeting) Hey, what's up?");
  });
});

describe("plan item 10: a late continuation is merged instead of answering the fragment", () => {
  it("final, the user goes on at once, final: the fragment's answer is never spoken; the second send continues the turn", async () => {
    const h = harness();
    h.loop.begin();
    h.now = 1_000;
    h.loop.onSpeechStart();
    h.loop.onFinal("Check my email.");
    h.now += 300;
    h.loop.onSpeechStart(); // "Actually, ..."
    h.loop.onBotStream("nova", "Sure, checking your email now. ");
    h.now += 2_000;
    h.loop.onPartial("Actually, look for anything from the bank");
    h.now += 1_000;
    h.loop.onFinal("Actually, look for anything from the bank this week.");
    expect(h.sends).toEqual([{ text: "Check my email." }, { text: "Actually, look for anything from the bank this week.", extra: { continues: true } }]);
    // The rest of the fragment's reply is still streaming in: it is never spoken either.
    h.loop.onBotStream("nova", "Sure, checking your email now. I'll read the newest first. ");
    h.loop.onBotText("Sure, checking your email now. I'll read the newest first.", "nova", "e1");
    expect(spoken(h)).toEqual([]);
    h.loop.onBotStream("nova", "Two emails from the bank this week. ");
    expect(spoken(h)).toEqual(["speak:Two emails from the bank this week."]);
    await finishAll(h);
  });

  it("no merge once the answer has started playing (that is a barge-in), or when the user comes back later than 2.5 s", () => {
    const late = harness();
    late.loop.begin();
    late.loop.onFinal("Check my email.");
    late.now += 2_600;
    late.loop.onSpeechStart();
    late.loop.onFinal("and my calendar");
    expect(late.sends[1]).toEqual({ text: "and my calendar" });
    const played = harness();
    played.loop.begin();
    played.loop.onFinal("Check my email.");
    played.loop.onBotStream("nova", "Sure, checking. ");
    played.now += 300;
    played.loop.onSpeechStart();
    played.loop.onFinal("and the bank");
    expect(played.sends[1]).toEqual({ text: "and the bank" });
  });

  it("a bare 'um' or 'yeah' after the final is not a continuation: the held answer plays", () => {
    const h = harness();
    h.loop.begin();
    h.now = 1_000;
    h.loop.onFinal("Check my email.");
    h.now += 300;
    h.loop.onSpeechStart();
    h.loop.onBotStream("nova", "Sure, checking. ");
    h.loop.onFinal("yeah");
    expect(h.sends.every((s) => !s.extra?.continues)).toBe(true);
    expect(spoken(h)).toEqual(["speak:Sure, checking."]);
  });
});

describe("plan item 27: the voice may say nothing to a plain thanks", () => {
  it("[quiet] from the host: back to listening at once — no filler, no long-task line, no fault", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("thanks");
    h.now += 600;
    h.loop.onQuiet("nova");
    expect(h.loop.state).toBe("listening");
    tickFor(h, 50_000);
    expect(spoken(h)).toEqual([]);
    expect(h.loop.state).toBe("listening");
  });

  it("a reply that is already streaming is not silenced by a stray quiet", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("thanks");
    h.loop.onBotStream("nova", "Any time. ");
    h.loop.onQuiet("nova");
    expect(spoken(h)).toEqual(["speak:Any time."]);
  });
});

describe("plan item 4: \"stop\" / \"shh\" / \"enough\" over the Bot is a silent yield", () => {
  /** The Bot is mid-reply (two lines queued) when the user talks over it. */
  const talking = (last = "Then there's the dentist at four thirty.") => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("what's on tomorrow");
    h.loop.onBotText(`You have standup at nine thirty and the lawyers at two. ${last}`, "nova", "e1");
    h.now += 2_000;
    return h;
  };

  it("\"stop\": the reply is cut on the partial, nothing is sent, no \"sorry, go ahead\", and the call listens", async () => {
    const h = talking();
    const interrupted: string[] = [];
    h.loop.onSpeechStart();
    h.loop.onPartial("stop");
    expect(h.marks).toContain("stop");
    h.now += 400;
    h.loop.onFinal("Stop.");
    await finishAll(h);
    expect(h.sends.map((s) => s.text)).toEqual(["what's on tomorrow"]);
    expect(spoken(h).filter((l) => l.includes("(sorry)"))).toEqual([]);
    expect(h.loop.state).toBe("listening");
    tickFor(h, 10_000); // nothing comes back: the cut reply stays cut (no carrying on after a wordless pause)
    expect(spoken(h).filter((l) => !l.includes("(sorry)"))).toHaveLength(2);
    void interrupted;
  });

  it("\"okay, stop\", \"shh\", \"that's enough\" yield the same way", () => {
    for (const w of ["okay, stop", "Shh.", "That's enough.", "enough"]) {
      const h = talking();
      h.loop.onSpeechStart();
      h.loop.onPartial(w);
      h.loop.onFinal(w);
      expect(h.sends, w).toHaveLength(1);
      expect(spoken(h).filter((l) => l.includes("(sorry)")), w).toEqual([]);
    }
  });

  it("\"stop the timer\" is a request, not a yield: it is still sent", () => {
    const h = talking();
    h.loop.onSpeechStart();
    h.loop.onPartial("stop");
    h.loop.onPartial("stop the timer");
    h.loop.onFinal("Stop the timer.");
    expect(h.sends.map((s) => s.text)).toEqual(["what's on tomorrow", "Stop the timer."]);
  });

  it("over a question the Bot just asked, \"that's fine\" is an answer: it is sent", async () => {
    const h = talking("Shall I move the dentist?");
    h.pending.shift()!.done(); // the first line has played; the question is playing
    await flush();
    h.loop.onSpeechStart();
    h.loop.onPartial("that's fine");
    h.loop.onFinal("That's fine.");
    expect(h.sends.map((s) => s.text)).toEqual(["what's on tomorrow", "That's fine."]);
  });

  it("a likely end on \"stop\" never starts the Bot's reply early", () => {
    const specs: string[] = [];
    const h = harness();
    (h.loop as unknown as { d: { speculate(t: string): void } }).d.speculate = (t) => specs.push(t);
    h.loop.begin();
    h.loop.onLikelyEnd("shh");
    h.loop.onLikelyEnd("stop");
    expect(specs).toEqual([]);
  });

  it("review round 1: \"stop\" over the filler leaves no pending continuation behind (the next turn is its own)", () => {
    const h = harness();
    h.loop.begin();
    h.now = 1_000;
    h.loop.onFinal("what's on tomorrow");
    tickFor(h, CALL_FEEL.fillerAfterMs + 100); // the filler is playing, no answer yet
    h.loop.onSpeechStart();
    h.loop.onPartial("stop");
    h.loop.onFinal("Stop.");
    h.now += 200;
    h.loop.onPartial("and what about Friday"); // (no new speech-start: only the flag the stop left could merge it)
    h.loop.onFinal("and what about Friday");
    expect(h.sends.at(-1)).toEqual({ text: "and what about Friday" });
  });

  it("review round 1: \"cancel that\", \"forget it\", \"never mind\" over \"On it, sending…\" reach the voice (it may cancel a running task)", () => {
    for (const w of ["Cancel that.", "forget it", "never mind"]) {
      const h = harness();
      h.loop.begin();
      h.loop.onFinal("text Sam I'm late");
      h.loop.onBotText("On it, sending that to Sam now. It should land in a second.", "nova", "e1");
      h.now += 1_000;
      h.loop.onSpeechStart();
      h.loop.onPartial(w);
      h.loop.onFinal(w);
      expect(h.sends.map((s) => s.text), w).toEqual(["text Sam I'm late", w]);
      expect(h.marks, w).not.toContain("stop");
    }
  });
});

describe("plan item 16: a reply that ends on a question tells the helper to expect a short answer", () => {
  const withExpect = () => {
    const h = harness();
    const expects: number[] = [];
    (h.loop as unknown as { d: { expectAnswer(): void } }).d.expectAnswer = () => expects.push(h.now);
    return { h, expects };
  };

  it("\"…Shall I send it?\" finishes playing: expect-answer goes to the helper once, as the call listens again", async () => {
    const { h, expects } = withExpect();
    h.loop.begin();
    h.loop.onFinal("draft a note to Sam");
    h.loop.onBotText("Here's the draft. Shall I send it?", "nova", "e1");
    expect(expects).toEqual([]);
    await finishAll(h);
    expect(h.loop.state).toBe("listening");
    expect(expects).toHaveLength(1);
  });

  it("no expect-answer after a statement, or after a question the user talked over", async () => {
    const a = withExpect();
    a.h.loop.begin();
    a.h.loop.onFinal("thanks");
    a.h.loop.onBotText("Any time.", "nova", "e1");
    await finishAll(a.h);
    expect(a.expects).toEqual([]);
    const b = withExpect();
    b.h.loop.begin();
    b.h.loop.onFinal("draft a note");
    b.h.loop.onBotText("Shall I send it? It's short.", "nova", "e2");
    b.h.pending.shift()!.done();
    await flush();
    b.h.loop.onSpeechStart(); // talks over "It's short."
    await finishAll(b.h);
    expect(b.expects).toEqual([]);
  });
});

export { finishAll, harness, spoken, tickFor };
