import { describe, expect, it } from "vitest";
import { QWEN_CHUNK, QWEN_PAUSE_MS, SentenceChunker, pauseMsFor } from "../../src/renderer/voice/sentences";

// Voice calls: the reply is spoken sentence by sentence while it streams.

describe("sentence chunker", () => {
  it("emits each sentence once it is complete, never a partial one", () => {
    const c = new SentenceChunker();
    expect(c.push("It is nine")).toEqual([]);
    expect(c.push("It is nine in Tokyo.")).toEqual([]); // no space after it yet: "9.30" could follow
    expect(c.push("It is nine in Tokyo. And in Lon")).toEqual(["It is nine in Tokyo."]);
    expect(c.push("It is nine in Tokyo. And in London? Midnight! Anything")).toEqual(["And in London?", "Midnight!"]);
  });

  it("the final message speaks only what is left — nothing twice", () => {
    const c = new SentenceChunker();
    c.push("First one. Second");
    expect(c.finish("First one. Second one.")).toEqual(["Second one."]);
    expect(c.finish("First one. Second one.")).toEqual([]);
  });

  it("a final message that differs from the stream skips sentences already spoken", () => {
    const c = new SentenceChunker();
    c.push("Sure, on it. Checking the ");
    expect(c.finish("Sure, on it.\n\nThe build **passed**.")).toEqual(["The build passed."]);
  });

  it("does not split on decimals, abbreviations or initials", () => {
    const c = new SentenceChunker();
    expect(c.push("It costs 3.50 dollars, e.g. at Mr. Smith's shop. Ok ")).toEqual(["It costs 3.50 dollars, e.g. at Mr. Smith's shop."]);
  });

  it("skips code blocks and strips markdown for speech", () => {
    const c = new SentenceChunker();
    expect(c.push("Run **this**:\n```sh\nnpm test. ok\n```\nThen [check](http://x) it. Done")).toEqual(["Run this:\n", "Then check it."]);
    expect(c.finish("Run **this**:\n```sh\nnpm test. ok\n```\nThen [check](http://x) it. Done")).toEqual(["Done."]);
  });

  it("a paragraph or list break ends a sentence", () => {
    const c = new SentenceChunker();
    expect(c.push("Two options\n- red\n- blue\n\nPick")).toEqual(["Two options.", "red.", "blue.\n"]);
  });

  it("a very long sentence breaks at a comma so speech can start", () => {
    const c = new SentenceChunker();
    const long = `${"word ".repeat(30)}and then, ${"more ".repeat(20)}`;
    const out = c.push(long);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("and then,")).toBe(true);
  });

  it("spoken() is the text already handed to speech, for cutting an interrupted reply", () => {
    const c = new SentenceChunker();
    c.push("One. Two. Thr");
    expect(c.spoken()).toEqual(["One.", "Two."]);
  });
});

// Bug 142's clause start, narrowed (prosody): chunking is sentence-level, because a fragment read on its
// own lands flat and the rest of its sentence then starts cold. Only a sentence that has run past ~18
// words without ending is started early, at a comma it already has, and never a question.
const LONG_OPENER = "I don't have tomorrow's schedule back yet, so I can't confirm which one that is — give me a sec and I'll have the full rundown for you.";
describe("first-clause chunking", () => {
  it("an ordinary opening sentence is never cut: it goes whole, with its full stop", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.push("Sure, I can text Sam for you")).toEqual([]);
    expect(c.push("Sure, I can text Sam for you, just give me")).toEqual([]);
    expect(c.push("Sure, I can text Sam for you, just give me a second. Then, after that, I will")).toEqual(["Sure, I can text Sam for you, just give me a second."]);
  });

  it("a sentence that has run past ~18 words is started at its own comma, and the rest of it goes as one chunk", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.push(LONG_OPENER.slice(0, 90))).toEqual([]);
    expect(c.push(LONG_OPENER.slice(0, 120))).toEqual(["I don't have tomorrow's schedule back yet, so I can't confirm which one that is —"]);
    expect(c.finish(LONG_OPENER)).toEqual(["give me a sec and I'll have the full rundown for you."]);
  });

  it("never a question, however long it runs: its rise has to carry from the first word", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.push("Do you want me to move the afternoon one, the one with the lawyers, or leave it where it is and tell them ")).toEqual([]);
    expect(c.finish("Do you want me to move the afternoon one, the one with the lawyers, or leave it where it is?"))
      .toEqual(["Do you want me to move the afternoon one, the one with the lawyers, or leave it where it is?"]);
  });

  it("never before 8 words, and a short opener still goes as one", () => {
    const c = new SentenceChunker({ firstClause: true });
    expect(c.push("Okay, on it. Next")).toEqual(["Okay, on it."]);
    const d = new SentenceChunker({ firstClause: true });
    expect(d.push("One two, three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen ")).toEqual([]);
  });

  it("the default chunker is unchanged (sentences only)", () => {
    const c = new SentenceChunker();
    expect(c.push(LONG_OPENER.slice(0, 120))).toEqual([]);
  });

  it("the final message never repeats the clause that was already spoken", () => {
    const c = new SentenceChunker({ firstClause: true });
    c.push(LONG_OPENER.slice(0, 120));
    expect(c.finish(LONG_OPENER)).toEqual(["give me a sec and I'll have the full rundown for you."]);
  });
});

/**
 * Bug 166: a voice that renders its own phrasing (Qwen3) is given two or three sentences at a time,
 * so its line carries ACROSS the sentence end instead of starting cold at every one of them. The
 * opening chunk still goes alone — it is the one the user is waiting for.
 */
describe("grouping sentences for a voice that phrases across them (bug 166)", () => {
  const REPLY = "I pulled the numbers for last quarter, and they look better than we expected. "
    + "Revenue was up nine percent, and churn finally came down for the first time since March. "
    + "The renewals team thinks the pricing change did most of it. "
    + "Do you want me to put the whole thing in a note for Thursday? "
    + "I can have it ready tonight.";

  it("splits a reply into fewer, bigger pieces, with the opening one alone", () => {
    const plain = new SentenceChunker().finish(REPLY);
    const grouped = new SentenceChunker({ group: QWEN_CHUNK }).finish(REPLY);
    expect(plain).toHaveLength(5);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toBe(plain[0]); // the opening chunk is untouched: first audio is unchanged
    expect(grouped.join(" ")).toBe(plain.join(" ")); // and not one word is lost or reordered
    for (const g of grouped) expect(g.length).toBeLessThanOrEqual(QWEN_CHUNK.maxChars);
  });

  it("holds a short sentence for its group while the reply is still streaming", () => {
    const c = new SentenceChunker({ group: QWEN_CHUNK });
    expect(c.push("Sure. ")).toEqual(["Sure."]); // the opening one goes straight out
    expect(c.push("Sure. Give me a second. ")).toEqual([]); // held, waiting for the rest of its group
    expect(c.hasPending("Sure. Give me a second. ")).toBe(true);
    expect(c.push("Sure. Give me a second. I'll check the log. ")).toEqual([]);
    expect(c.push("Sure. Give me a second. I'll check the log. It should be quick. ")).toEqual(
      ["Give me a second. I'll check the log. It should be quick."]);
  });

  it("a stalled stream never strands a held sentence", () => {
    const c = new SentenceChunker({ group: QWEN_CHUNK });
    c.push("Sure. ");
    expect(c.push("Sure. Give me a second. ")).toEqual([]);
    expect(c.flush("Sure. Give me a second. ")).toEqual(["Give me a second."]);
    expect(c.hasPending("Sure. Give me a second. ")).toBe(false);
  });

  it("a paragraph break closes the group, and keeps its long pause", () => {
    const c = new SentenceChunker({ group: QWEN_CHUNK });
    const out = c.finish("Right.\n\nOne thing. Two things.\n\nThat's all.");
    expect(out[0]).toBe("Right.\n");
    expect(out[1]).toBe("One thing. Two things.\n");
    expect(pauseMsFor(out[1]!, QWEN_PAUSE_MS)).toBe(QWEN_PAUSE_MS.paragraph);
    expect(pauseMsFor("Two things.", QWEN_PAUSE_MS)).toBe(0);
  });

  it("everything spoken is still recorded, so an interrupted reply cuts where it was cut", () => {
    const c = new SentenceChunker({ group: QWEN_CHUNK });
    c.finish(REPLY);
    expect(c.spoken().join(" ")).toBe(new SentenceChunker().finish(REPLY).join(" "));
  });
});

/** Bug 166: what a real reply throws at the splitter, where a wrong cut breaks a thought in half. */
describe("the splitter never cuts inside a thought (bug 166)", () => {
  const split = (t: string) => new SentenceChunker().finish(t);
  it("an ellipsis into a lower-case word is a hesitation, not an end", () => {
    expect(split("Well... maybe we should wait.")).toEqual(["Well... maybe we should wait."]);
    expect(split("I thought about it... and then I stopped.")).toEqual(["I thought about it... and then I stopped."]);
  });
  it("…but an ellipsis into a new sentence still ends one", () => {
    expect(split("Well... Maybe we should wait. Or not.")).toEqual(["Well...", "Maybe we should wait.", "Or not."]);
  });
  it("a clock time is not the end of a sentence", () => {
    expect(split("Dr. Smith called at 4 p.m. about the release.")).toEqual(["Dr. Smith called at 4 p.m. about the release."]);
  });
  it("decimals, abbreviations and quotes are all unchanged", () => {
    expect(split("It costs 3.50 today, so we can. Fine.")).toEqual(["It costs 3.50 today, so we can.", "Fine."]);
    expect(split("The plan, i.e. the new one, is ready.")).toEqual(["The plan, i.e. the new one, is ready."]);
    expect(split('He said "go." Then he left.')).toEqual(['He said "go."', "Then he left."]);
  });
});
