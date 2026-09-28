import { describe, expect, it } from "vitest";
import { speechText } from "../../src/renderer/voice/speech-text";

// Bug 107: what a Bot's reply sounds like, for Kokoro and Apple alike — no markdown read aloud, no
// emoji names, no URLs spelled out, numbers, times and units said the way a person says them.
// Bug 152: code is never read — a block, a command, a diff, a trace or a blob gets one short, varied
// spoken mention — and the punctuation Kokoro takes its inflection from survives the clean-up.

describe("speechText", () => {
  it("strips markdown: emphasis, headings, quotes, lists, links, images and inline code", () => {
    // Bug 152: `npm test` is a command, so it is mentioned, not read out (it used to be read verbatim).
    expect(speechText("## Plan\n**Bold** and _soft_ and `npm test`.")).toBe("Plan. Bold and soft and the command in the chat.");
    expect(speechText("> quoted line")).toBe("quoted line");
    expect(speechText("- one\n- two\n1. three")).toBe("one. two. three");
    expect(speechText("See [the docs](https://example.com/docs) and ![logo](x.png).")).toBe("See the docs and.");
    expect(speechText("A | table | row")).toBe("A, table, row");
  });

  it("drops code blocks and says there was code", () => {
    // Bug 152: the canned "(code omitted)" is gone; the fence's language names what is in the chat.
    expect(speechText("Run this:\n```bash\nnpm install\nnpm test\n```\nThen reload.")).toBe("Run this: the shell command's in the chat. Then reload.");
    expect(speechText("Here:\n```python\nprint(1)\n```")).toBe("Here: the Python's in the chat.");
    expect(speechText("```ts path/to/foo.ts\nexport {}\n```")).toBe("the TypeScript's in the chat.");
    expect(speechText("```json\n{}\n```")).toBe("the JSON's in the chat.");
    expect(speechText("```\nplain\n```")).toBe("the code's in the chat.");
    expect(speechText("```wat\nplain\n```")).toBe("the code's in the chat."); // unknown language, generic line
    expect(speechText("Look:\n```python\na = 1\n")).toBe("Look: the Python's in the chat."); // unclosed (still streaming)
  });

  it("varies the spoken line, deterministically, and never repeats it back to back", () => {
    expect(speechText("```python\na\n```\n```python\nb\n```")).toBe("the Python's in the chat. I put the Python in the chat.");
    const three = speechText("```python\na\n```\nthen\n```python\nb\n```\nthen\n```python\nc\n```");
    const mentions = three.split(". ").filter((s) => s.includes("in the chat"));
    expect(mentions).toHaveLength(3);
    expect(new Set(mentions).size).toBe(3);
    // Deterministic: the same reply always sounds the same.
    expect(speechText("```python\na\n```\nthen\n```python\nb\n```\nthen\n```python\nc\n```")).toBe(three);
  });

  it("reads a short, speakable inline code word and rephrases the rest", () => {
    expect(speechText("Open `main` and `README`, see `src/app/main.ts`, call `foo_bar(x, y)`.")).toBe("Open main and README, see main, call the function in the chat.");
    expect(speechText("Check `https://example.com/a` and `me@example.com`.")).toBe("Check a link and an email address.");
    expect(speechText("Set it to `42`.")).toBe("Set it to 42.");
    expect(speechText("Try `npm run build` first.")).toBe("Try the command in the chat first.");
    expect(speechText("It's `{ retries: 3 }` now.")).toBe("It's the code in the chat now.");
  });

  it("never reads commands, diffs, traces, blobs or hashes, and collapses a run into one mention", () => {
    expect(speechText("Run:\n$ npm install\n$ npm run build\nThen done.")).toBe("Run: the command's in the chat. Then done.");
    expect(speechText("$ npm install\nok\n$ npm test")).toBe("the command's in the chat. ok. I put the command in the chat.");
    expect(speechText("Patch:\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n-const a = 1;\n+const a = 2;\nThat fixes it."))
      .toBe("Patch: the diff's in the chat. That fixes it.");
    expect(speechText("It blew up:\nTraceback (most recent call last):\n  File \"app.py\", line 3, in <module>\n    at Foo (bar.js:12:3)\nTypeError: bad thing\nSo I patched it."))
      .toBe("It blew up: the stack trace's in the chat. So I patched it.");
    expect(speechText("Config:\n{\n  \"name\": \"synapse\",\n  \"version\": 2\n}\nThat's all.")).toBe("Config: the data's in the chat. That's all.");
    expect(speechText("<root>\n  <item id=\"1\" />\n</root>")).toBe("the data's in the chat.");
    expect(speechText("c3RyaW5nMTIzNDU2Nzg5MDEyMzQ1Njc4OTA=")).toBe("it's in the chat.");
    expect(speechText("const reallyLongThing = someFunction(withArgs, andMore, andEvenMore) + otherThing.map(x => x * 2);")).toBe("it's in the chat.");
    expect(speechText("Hash 9f2c1a4b8e7d6c5f0a1b and id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ok")).toBe("Hash a hash and id an ID ok");
    // Long prose is still prose, and a rule is silent rather than a diff.
    expect(speechText("I looked at the whole pipeline this morning and it turns out that the cache was never being invalidated at all."))
      .toBe("I looked at the whole pipeline this morning and it turns out that the cache was never being invalidated at all.");
    expect(speechText("one\n\n---\n\ntwo")).toBe("one. two");
  });

  it("reads at most three items of a long list or a table", () => {
    expect(speechText("- one\n- two\n- three\n- four\n- five\nDone.")).toBe("one. two. three. and a few more in the chat. Done.");
    expect(speechText("| a | b | c | d |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 | 7 | 8 |\n| 9 | 10 | 11 | 12 |\n| 13 | 14 | 15 | 16 |"))
      .toBe("a, b, c. 1, 2, 3. 5, 6, 7. and a few more in the chat");
    expect(speechText("- npm install --save-dev vitest\n- npm run test\nAll set.")).toBe("the command's in the chat. All set.");
  });

  it("keeps the punctuation Kokoro takes its inflection from", () => {
    expect(speechText("Does it work?\nYes!\nShip it.")).toBe("Does it work? Yes! Ship it.");
    expect(speechText("Ready? Yes! Wait - really?")).toBe("Ready? Yes! Wait - really?");
    expect(speechText("It's done — really! Are you sure? Yes, 100%.")).toBe("It's done — really! Are you sure? Yes, 100 percent.");
    expect(speechText("## Shipped!\nWant me to push?\n```ts\nx\n```")).toBe("Shipped! Want me to push? the TypeScript's in the chat.");
  });

  it("says compact money, dates, ordinals and abbreviations the way a person does", () => {
    expect(speechText("It raised $4.82M last year.")).toBe("It raised 4 point 8 2 million dollars last year.");
    expect(speechText("$1.5B, $250K, $3 million, $4.5")).toBe("1 point 5 billion dollars, 250 thousand dollars, 3 million dollars, 4 point 5 dollars");
    expect(speechText("On 2026-09-21 and Sept 21, 2026")).toBe("On September twenty-first, 2026 and September twenty-first, 2026");
    expect(speechText("the 1st, 2nd, 3rd and 22nd")).toBe("the first, second, third and twenty-second");
    expect(speechText("Dr. Smith says approx. 5 items, etc. Then we ship.")).toBe("Doctor Smith says approximately 5 items, et cetera. Then we ship.");
    expect(speechText("Meeting at 3pm, 9 a.m., file is 4.5 GB, 16px wide.")).toBe("Meeting at 3 PM, 9 AM, file is 4.5 gigabytes, 16 pixels wide.");
  });

  it("sounds like speech on a real reply that mixes prose, a code block and inline code", () => {
    const said = speechText(
      "Fixed it! The bug was in `parseReply()` — see `src/renderer/voice/speech-text.ts`.\n\n" +
      "```ts\nexport const x = 1;\n```\n\n" +
      "Run `npm test` and it should pass. Want me to push it?",
    );
    expect(said).toBe(
      "Fixed it! The bug was in the function in the chat — see speech text. the TypeScript's in the chat. " +
      "Run the command in the chat and it should pass. Want me to push it?",
    );
    expect(said.length).toBeGreaterThan(0);
    expect(said).not.toMatch(/[`{};]/); // no leftover backticks, braces or semicolons
    expect(said).not.toMatch(/undefined/);
    expect(said).not.toMatch(/ {2,}/); // no doubled spaces
    expect(said).not.toMatch(/(?:^|\s)[.,!?;:]/); // no bare punctuation
    expect(said.endsWith("?")).toBe(true);
    const canned = said.split(/(?<=[.!?])\s+/).filter((s) => s.includes("in the chat"));
    expect(new Set(canned).size).toBe(canned.length); // no robotic repetition
  });


  it("drops emoji and other pictographs, keeping the words around them", () => {
    expect(speechText("Done! 🎉 Shipping now 🚀✨")).toBe("Done! Shipping now");
    expect(speechText("👍")).toBe("");
    expect(speechText("I ❤️ it")).toBe("I it");
  });

  it("turns a URL or an email into words", () => {
    expect(speechText("Go to https://github.com/example/synapse-releases/pull/12 for details.")).toBe("Go to a link for details.");
    expect(speechText("www.example.com has it")).toBe("a link has it");
    expect(speechText("Mail alex@example.com today")).toBe("Mail an email address today");
  });

  it("says times, money, percentages, units and big numbers naturally", () => {
    expect(speechText("Meet at 3:30pm or 10:05 AM, not 14:00.")).toBe("Meet at 3 30 PM or 10 oh 5 AM, not 14 hundred.");
    expect(speechText("It's 9:00 am")).toBe("It's 9 AM");
    expect(speechText("It costs $4.99, or $1,200 total.")).toBe("It costs 4 dollars 99, or 1200 dollars total.");
    expect(speechText("Up 25% and down 3.5%.")).toBe("Up 25 percent and down 3.5 percent.");
    expect(speechText("It's 5km away, 12 kg, 72°F, 20°C, 500 MB, 3 ms.")).toBe("It's 5 kilometers away, 12 kilograms, 72 degrees Fahrenheit, 20 degrees Celsius, 500 megabytes, 3 milliseconds.");
    expect(speechText("1 km")).toBe("1 kilometer");
    expect(speechText("the 1990s, 2 min, 5 minutes")).toBe("the 1990s, 2 minutes, 5 minutes"); // no bare s / m / g units
    expect(speechText("pages 10-20, e.g. these & those, vs. that")).toBe("pages 10 to 20, for example these and those, versus that");
    expect(speechText("On 2026-09-21")).toBe("On September twenty-first, 2026"); // bug 152: dates are spoken out
  });

  it("keeps plain sentences exactly, and collapses whitespace", () => {
    expect(speechText("Sure, I can help with that.")).toBe("Sure, I can help with that.");
    expect(speechText("  one   two \n\n three ")).toBe("one two. three");
  });
});
