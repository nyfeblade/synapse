import { describe, expect, it } from "vitest";
import { docHeads, isBotSide, typingNeedsHead } from "../../src/renderer/doc-heads";
import type { TranscriptItem } from "../../src/renderer/transcript-items";

// The Carbon look's document transcript: one head per Bot TURN, not per message (decisions.md).

const sep = (key: string): TranscriptItem => ({ kind: "separator", key, label: "Today" });
const user = (key: string): TranscriptItem => ({ kind: "user", key, text: "hi", entry: { kind: "message", id: key, role: "user", content: "hi", createdAt: 1 } as never, attachments: [], replyCount: 0 });
const bot = (key: string, at = 1_700_000_000_000, author?: { id: string; name: string }): TranscriptItem =>
  ({ kind: "bot", key, text: "ok", entry: { createdAt: at } as never, replyCount: 0, ...(author ? { author } : {}) }) as TranscriptItem;
const activity = (key: string, at = 1_700_000_000_000): TranscriptItem => ({ kind: "activity", key, rows: [], more: 0, steps: [{ startedAt: at } as never], running: false });
const notice = (key: string): TranscriptItem => ({ kind: "notice", key, text: "Voice call · 4m" });

describe("doc-heads: one head per Bot turn", () => {
  it("heads the first item of a turn, and nothing else in it", () => {
    const items = [sep("d"), user("u1"), activity("a1"), bot("b1"), bot("b2")];
    expect([...docHeads(items).keys()]).toEqual(["a1"]);
  });

  it("the head carries the time the turn began", () => {
    const items = [user("u1"), activity("a1", 1234), bot("b1", 9999)];
    expect(docHeads(items).get("a1")).toBe(1234);
    expect(docHeads([user("u1"), bot("b1", 4242)]).get("b1")).toBe(4242);
  });

  it("your message, a day separator or a notice between two replies starts a new turn", () => {
    expect([...docHeads([bot("b1"), user("u1"), bot("b2")]).keys()]).toEqual(["b1", "b2"]);
    expect([...docHeads([bot("b1"), notice("n"), bot("b2")]).keys()]).toEqual(["b1", "b2"]);
    expect([...docHeads([bot("b1"), sep("d"), bot("b2")]).keys()]).toEqual(["b1", "b2"]);
  });

  it("a group member's own post carries its own face, so it is never part of the Bot's turn", () => {
    const items = [bot("b1"), bot("m1", 1, { id: "x", name: "Otto" }), bot("b2")];
    expect(isBotSide(items[1]!)).toBe(false);
    expect([...docHeads(items).keys()]).toEqual(["b1", "b2"]);
  });

  // WHO IS TYPING is the only thing a typing indicator is for, so the bubble almost always carries
  // the face and the name. The rule used to be "only when the last item is not the Bot's", which
  // reads right and fails the case that matters: after six tool steps, a saved file and an approval
  // card the Bot is still inside its own run, so the dots appeared as a bare grey pill under a card,
  // hundreds of pixels below the last thing that said whose they were. The ONE case with no head is
  // the dots directly under the Bot's own words — the next sentence of a paragraph attributed an
  // inch above, and the case the dots-to-text morph runs in, where a head would be a flicker.
  it("the typing bubble carries the Bot's head unless it is continuing the Bot's own words", () => {
    expect(typingNeedsHead([])).toBe(true);
    expect(typingNeedsHead([user("u1")])).toBe(true);
    expect(typingNeedsHead([user("u1"), activity("a1")]), "steps are not words — the dots open a new utterance").toBe(true);
    expect(typingNeedsHead([user("u1"), bot("b1")]), "the dots continue this very paragraph").toBe(false);
    expect(typingNeedsHead([bot("m1", 1, { id: "x", name: "Otto" })]), "a member's post is somebody else's").toBe(true);
  });
});
