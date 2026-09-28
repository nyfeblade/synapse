import { describe, expect, it } from "vitest";
import { CALL_FEEL } from "@synapse/shared";
import { RESUME_SILENT_MS, VoiceLoop, type PhraseKind } from "../../src/renderer/voice/voice-loop";
import { SentenceChunker } from "../../src/renderer/voice/sentences";

// Bugs 186, 187, 191 (test-reports/voice-call-feel): a call should feel like a phone call. Measured on the user's
// own calls: a filler that plays once the answer's text is already streaming only stands in front of it; and a
// listener's "yeah" / "mm-hm" over the Bot is not a request to stop, nor a turn for the model.

function harness() {
  const log: string[] = [];
  const pending: { text: string; phrase?: PhraseKind; done: () => void }[] = [];
  const interrupted: { who: string; said: string }[] = [];
  const marks: string[] = [];
  const captions: string[] = [];
  const h = { now: 0, mark: 0, log, pending, interrupted, marks, captions, loop: null as unknown as VoiceLoop };
  h.loop = new VoiceLoop({
    start: () => log.push("start"), stop: () => log.push("stop"),
    send: (t) => { log.push(`send:${t}`); },
    speak: (t, s) => {
      log.push(`speak:${s?.phrase ? `(${s.phrase}) ` : ""}${t}`);
      return new Promise<void>((r) => pending.push({ text: t, phrase: s?.phrase, done: r }));
    },
    cancelSpeech: () => { log.push("cancel"); pending.length = 0; },
    now: () => h.now, silenceMs: 700, helperEndpoints: true,
    phrase: (kind, botId) => `${kind} line from ${botId}`,
    members: () => [{ id: "nova", name: "Nova" }],
    onInterrupted: (who, _e, said) => interrupted.push({ who, said }),
    mark: (w) => marks.push(w),
    onLine: (_who, text, phrase) => { if (!phrase) captions.push(text); },
    speculate: (t) => log.push(`speculate:${t}`),
    cancelSpeculation: () => log.push("speculate-cancel"),
  });
  return h;
}
type H = ReturnType<typeof harness>;
const spoken = (h: H) => h.log.filter((l) => l.startsWith("speak:")).map((l) => l.slice(6));
const sent = (h: H) => h.log.filter((l) => l.startsWith("send:"));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const finishOne = async (h: H) => { h.pending.shift()!.done(); await flush(); };
const tickFor = (h: H, ms: number) => { for (let t = 0; t < ms; t += 100) { h.now += 100; h.loop.tick(); } };

const REPLY = "The launch is on Friday. We still need the press kit. Priya is on the copy. The site goes live at nine.";

/** The Bot is mid-reply: its first line is playing, three more are queued or waiting. */
async function midReply(h: H, final = true) {
  h.loop.begin();
  h.loop.onFinal("tell me about the launch");
  if (final) h.loop.onBotText(REPLY, "nova", "e1");
  else h.loop.onBotStream("nova", "The launch is on Friday. We still need the press kit. ");
  await finishOne(h); // "The launch is on Friday." has been said
  expect(h.loop.state).toBe("speaking");
  h.loop.onBargeIn();
  expect(h.log).toContain("cancel");
  h.mark = spoken(h).length;
}
/** What was handed to speech after the barge-in. */
const after = (h: H) => spoken(h).slice(h.mark);

describe("bug 186: a filler never stands in front of an answer that is already arriving", () => {
  it("the answer's text is streaming (no whole sentence yet) at the filler's moment: no filler, the answer plays first", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("summarise the doc");
    h.now += 600;
    h.loop.onBotStream("nova", "So the document mostly talks about");
    tickFor(h, CALL_FEEL.fillerAfterMs);
    expect(spoken(h)).toEqual([]);
    h.loop.onBotStream("nova", "So the document mostly talks about pricing. ");
    expect(spoken(h)).toEqual(["So the document mostly talks about pricing."]);
  });

  it("no text at all by then: the filler still plays (the dead-air cover is kept)", () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("summarise the doc");
    tickFor(h, CALL_FEEL.fillerAfterMs + 100);
    expect(spoken(h)).toEqual(["(filler) filler line from nova"]);
  });
});

describe("bug 187: a backchannel over the Bot is listening, not a turn", () => {
  it("'yeah' while the Bot talks: nothing is sent, no 'sorry', the chat isn't marked cut, and it carries on from the line it was cut in", async () => {
    const h = harness();
    await midReply(h);
    h.loop.onPartial("yeah");
    h.loop.onFinal("Yeah.");
    expect(sent(h)).toEqual(["send:tell me about the launch"]);
    expect(spoken(h).some((l) => l.includes("(sorry)"))).toBe(false);
    expect(h.interrupted).toEqual([]);
    expect(after(h)[0]).toBe("We still need the press kit.");
    expect(h.loop.state).toBe("speaking");
    while (h.pending.length) await finishOne(h);
    expect(after(h)).toEqual(["We still need the press kit.", "Priya is on the copy.", "The site goes live at nine."]);
    expect(h.loop.state).toBe("listening");
    expect(h.marks).toContain("backchannel");
  });

  it("'mm-hm' while the reply is still streaming: it resumes, and the text that streamed meanwhile follows", async () => {
    const h = harness();
    await midReply(h, false);
    h.loop.onBotStream("nova", "The launch is on Friday. We still need the press kit. Priya is on the copy. ");
    h.loop.onFinal("Mm-hm.");
    expect(sent(h)).toHaveLength(1);
    h.loop.onBotText("The launch is on Friday. We still need the press kit. Priya is on the copy. Done.", "nova", "e1");
    while (h.pending.length) await finishOne(h);
    expect(after(h)).toEqual(["We still need the press kit.", "Priya is on the copy.", "Done."]);
    expect(h.interrupted).toEqual([]);
  });

  it("anything that isn't a backchannel still cuts the Bot off, is sent, and the chat keeps the reply cut at what was said", async () => {
    const h = harness();
    await midReply(h);
    h.loop.onFinal("wait, is that this Friday or next?");
    expect(sent(h).at(-1)).toBe("send:wait, is that this Friday or next?");
    expect(h.interrupted).toEqual([{ who: "nova", said: "The launch is on Friday." }]);
    expect(after(h).filter((l) => !l.startsWith("("))).toEqual([]);
  });

  it("over a line that asks something, 'okay' is an answer, not a backchannel", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("draft it");
    h.loop.onBotText("It's drafted. Want me to send it now?", "nova", "e1");
    await finishOne(h);
    h.loop.onBargeIn();
    h.loop.onFinal("Okay.");
    expect(sent(h).at(-1)).toBe("send:Okay.");
  });

  it("a barge-in with no words behind it (a cough, the Bot's own echo): the Bot carries on after a moment", async () => {
    const h = harness();
    await midReply(h);
    tickFor(h, RESUME_SILENT_MS - 200);
    expect(after(h)).toEqual([]);
    tickFor(h, 300);
    expect(after(h)[0]).toBe("We still need the press kit.");
    expect(h.interrupted).toEqual([]);
  });

  it("steady noise can't loop it: after one wordless resume, the next wordless barge-in on that reply settles it as cut", async () => {
    const h = harness();
    await midReply(h);
    let resumes = 0;
    for (let i = 0; i < 3; i++) {
      tickFor(h, RESUME_SILENT_MS + 100);
      if (h.loop.state === "speaking") { resumes++; h.loop.onBargeIn(); }
    }
    expect(resumes).toBe(1);
    tickFor(h, RESUME_SILENT_MS + 100);
    expect(h.loop.state).toBe("listening");
    expect(h.interrupted).toHaveLength(1);
  });

  it("a barge-in whose utterance ends with no words at all (an empty final) still carries on after the pause", async () => {
    const h = harness();
    await midReply(h);
    h.loop.onFinal("");
    expect(h.interrupted).toEqual([]);
    tickFor(h, RESUME_SILENT_MS + 100);
    expect(after(h)[0]).toBe("We still need the press kit.");
  });

  it("the Bot had just FINISHED asking something: 'sure' is the answer, sent as a turn", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("draft it");
    h.loop.onBotText("Want me to send it now? It's short.", "nova", "e1");
    await finishOne(h); // the question has been said; the Bot is on the next line
    h.loop.onBargeIn();
    h.loop.onFinal("Sure.");
    expect(sent(h).at(-1)).toBe("send:Sure.");
  });

  it("a resumed line is not captioned (or handed off) a second time", async () => {
    const h = harness();
    await midReply(h);
    const before = h.captions.length;
    h.loop.onFinal("Yeah.");
    expect(after(h)[0]).toBe("We still need the press kit.");
    expect(h.captions.slice(before)).not.toContain("We still need the press kit.");
  });

  it("a line that was only waiting (never handed to speech) at the barge-in is captioned once when it finally plays", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("tell me about the launch");
    h.loop.onBotText(REPLY, "nova", "e1"); // three lines go to speech, the fourth waits (SPEAK_BATCH)
    expect(h.captions).toEqual(["The launch is on Friday.", "We still need the press kit.", "Priya is on the copy."]);
    h.loop.onBargeIn(); // during sentence 1
    h.loop.onFinal("Yeah.");
    while (h.pending.length) await finishOne(h);
    expect(h.captions).toEqual(["The launch is on Friday.", "We still need the press kit.", "Priya is on the copy.", "The site goes live at nine."]);
  });

  it("a reply still streaming that had just asked something: 'okay' is the answer", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onFinal("draft it");
    h.loop.onBotStream("nova", "Want me to send it now? It's short. ");
    await finishOne(h);
    h.loop.onBargeIn();
    h.loop.onFinal("Okay.");
    expect(sent(h).at(-1)).toBe("send:Okay.");
  });

  it.each(["Stop.", "Wait.", "No."])("'%s' over the Bot still stops it (it isn't a backchannel)", async (word) => {
    const h = harness();
    await midReply(h);
    h.loop.onFinal(word);
    expect(after(h).filter((l) => !l.startsWith("("))).toEqual([]);
    expect(h.interrupted).toEqual([{ who: "nova", said: "The launch is on Friday." }]);
    if (word === "No.") expect(sent(h).at(-1)).toBe(`send:${word}`);
    else expect(sent(h)).toHaveLength(1); // a bare hold (bug 134) or stop (plan item 4, bug 248) yields, and is not a turn
  });

  it("a speculative start whose final has different words is dropped and never spoken", async () => {
    const h = harness();
    h.loop.begin();
    h.loop.onLikelyEnd("what's on my calendar");
    expect(h.log).toContain("speculate:what's on my calendar");
    h.loop.onPartial("what's on my calendar for Friday");
    h.loop.onFinal("what's on my calendar for Friday");
    expect(h.log).toContain("speculate-cancel");
    expect(sent(h)).toEqual(["send:what's on my calendar for Friday"]);
    expect(spoken(h)).toEqual([]);
  });

  it("words that are still coming hold it: no resume while the user is talking", async () => {
    const h = harness();
    await midReply(h);
    h.loop.onPartial("so what I actually");
    tickFor(h, RESUME_SILENT_MS + 500);
    expect(after(h)).toEqual([]);
  });
});

describe("bug 191: a numbered list is not read as 'One. Two. Three.'", () => {
  it("the list marker stays with its item", () => {
    const c = new SentenceChunker({ firstClause: true });
    const out = c.finish("Here's what I found:\n\n1. Flight 452 departs at 7:05.\n2. Delta departs at 9:40.\n\nWant me to book one?");
    expect(out.some((l) => /^\d+\.$/.test(l.trim()))).toBe(false);
    expect(out.map((l) => l.trim())).toEqual(["Here's what I found:", "Flight 452 departs at 7:05.", "Delta departs at 9:40.", "Want me to book one?"]);
  });

  it("a number ending a sentence mid-line is still a sentence end", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.finish("How many? 3. Yes, three.").map((l) => l.trim())).toEqual(["How many?", "3.", "Yes, three."]);
    const d = new SentenceChunker();
    expect(d.finish("We need 2. Then we ship.").map((l) => l.trim())).toEqual(["We need 2.", "Then we ship."]);
  });
});
