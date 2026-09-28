import { describe, expect, it } from "vitest";
import { VoiceLoop, type PhraseKind } from "../../src/renderer/voice/voice-loop";

// Bug 142 (voice fast path), the voice loop's side: an opening clause is spoken early only when its
// sentence has proved long (an ordinary reply goes whole, for its intonation); a speculative start on a
// likely end of turn (at most one a user turn, cancelled when the user keeps talking); spoken approvals
// answered by an unambiguous yes / no never become a turn.

function harness(o: { approval?: () => { yes(): void; no(): void } | null } = {}) {
  const log: string[] = [];
  const pending: { text: string; phrase?: PhraseKind; done: () => void }[] = [];
  const h = { now: 0, log, pending, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t, _ms, x) => { log.push(`send:${t}${x?.speculated ? " (speculated)" : ""}`); },
    speak: (t, s) => { log.push(`speak:${t}`); return new Promise<void>((r) => pending.push({ text: t, phrase: s?.phrase, done: r })); },
    cancelSpeech: () => log.push("cancel"),
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    members: () => [{ id: "nova", name: "Nova" }],
    speculate: (t) => log.push(`speculate:${t}`),
    cancelSpeculation: () => log.push("unspeculate"),
  });
  return h;
}
type H = ReturnType<typeof harness>;
const spoken = (h: H) => h.log.filter((l) => l.startsWith("speak:"));

describe("clause-level speech (bug 142)", () => {
  it("an ordinary reply is not cut at its comma: the sentence goes whole, so it keeps its shape", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("text Sam that I'm late");
    h.loop.onBotStream("nova", "Sure, I'll text Sam right now for you, just");
    expect(spoken(h)).toEqual([]);
    h.loop.onBotText("Sure, I'll text Sam right now for you, just a second.", "nova", "e1");
    expect(spoken(h)).toEqual(["speak:Sure, I'll text Sam right now for you, just a second."]);
  });

  it("a sentence that has run past ~18 words without ending is started at its own comma, and the rest follows whole", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("is the afternoon one with the lawyers");
    const long = "I don't have tomorrow's schedule back yet, so I can't confirm which one that is — give me a sec and I'll have the full rundown for you.";
    h.loop.onBotStream("nova", long.slice(0, 120));
    expect(spoken(h)).toEqual(["speak:I don't have tomorrow's schedule back yet, so I can't confirm which one that is —"]);
    h.loop.onBotText(long, "nova", "e1");
    expect(spoken(h).at(-1)).toBe("speak:give me a sec and I'll have the full rundown for you.");
  });
});

describe("speculative start on a likely end of turn (bug 142)", () => {
  it("a likely end starts the reply early; the matching final commits it (sent as speculated)", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onPartial("what's on my calendar tomorrow");
    h.loop.onLikelyEnd("What's on my calendar tomorrow?");
    expect(h.log).toContain("speculate:What's on my calendar tomorrow?");
    h.loop.onFinal("What's on my calendar tomorrow?");
    expect(h.log).toContain("send:What's on my calendar tomorrow? (speculated)");
    expect(h.log).not.toContain("unspeculate");
  });

  it("the user keeps talking: the speculation is cancelled, and the real final is sent as a normal turn", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onPartial("text Sam");
    h.loop.onLikelyEnd("Text Sam.");
    h.now += 1_000; // well after the start: the user went on (not Apple's trailing partial, bug 217)
    h.loop.onPartial("text Sam that I'm running late");
    expect(h.log).toContain("unspeculate");
    h.loop.onFinal("Text Sam that I'm running late.");
    expect(h.log.filter((l) => l.startsWith("send:"))).toEqual(["send:Text Sam that I'm running late."]);
  });

  it("bug 217: words trailing in just after the start get ONE more start on the settled text, which the final keeps", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onLikelyEnd("Text Sam.");
    h.now += 200;
    h.loop.onPartial("text Sam that I'm running late");
    h.loop.onFinal("Text Sam that I'm running late.");
    expect(h.log.filter((l) => /^(speculate|unspeculate|send)/.test(l))).toEqual(["speculate:Text Sam.", "unspeculate", "speculate:text Sam that I'm running late", "send:Text Sam that I'm running late. (speculated)"]);
  });

  it("at most two speculative starts a user turn (bug 217; it was one)", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onLikelyEnd("Text Sam.");
    h.loop.onPartial("text Sam that");
    h.loop.onLikelyEnd("Text Sam that.");
    h.loop.onPartial("text Sam that I'm");
    h.loop.onLikelyEnd("Text Sam that I'm.");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toEqual(["speculate:Text Sam.", "speculate:text Sam that"]);
    h.loop.onFinal("Text Sam that I'm late.");
    // The reply is spoken; the loop listens again, and the next user turn has its own one.
    h.loop.onBotText("Okay.", "nova", "e1");
    while (h.pending.length) { h.pending.shift()!.done(); for (let i = 0; i < 10; i++) await Promise.resolve(); }
    expect(h.loop.state).toBe("listening");
    h.loop.onLikelyEnd("Next turn.");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toEqual(["speculate:Text Sam.", "speculate:text Sam that", "speculate:Next turn."]);
  });

  it("never while the Bot is speaking, and never for a bare 'wait'", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onLikelyEnd("Wait.");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toEqual([]);
    h.loop.onFinal("hello");
    h.loop.onBotStream("nova", "Hi there. How are");
    expect(h.loop.state).toBe("speaking");
    h.loop.onLikelyEnd("Tell me more.");
    expect(h.log.filter((l) => l.startsWith("speculate:"))).toEqual([]);
  });
});
