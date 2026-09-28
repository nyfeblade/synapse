import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@synapse/shared";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";

const T = 1_700_000_000_000;
describe("buildTranscriptItems Phase 2 kinds", () => {
  it("groups attachments under their message, counts replies, and emits widget, card and file items", () => {
    const entries: TranscriptEntry[] = [
      { kind: "message", id: "t1u", role: "user", content: "see file", createdAt: T, attachmentEntryIds: ["t1ua1"] },
      { kind: "user-attachment", id: "t1ua1", batchId: "t1u", attachmentId: "x.pdf", name: "a.pdf", size: 3, mime: "application/pdf", storePath: "/s", boxPath: "/workspace/uploads/a.pdf", createdAt: T },
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: T + 1, message: { type: "text", content: "got it" } },
      { kind: "send-message", id: "t1s2", requestId: "r", createdAt: T + 2, message: { type: "widget", widget: { question: "Q?", options: [{ label: "A", value: "a" }] } }, status: "pending" },
      { kind: "send-message", id: "t1s3", requestId: "r", createdAt: T + 3, message: { type: "card", card: { kind: "link", url: "https://x.dev", title: "X", description: null } } },
      { kind: "send-message", id: "t1s4", requestId: "r", createdAt: T + 4, message: { type: "attachment", url: "file:///workspace/r.csv", name: "r.csv", size: 9, mime: "text/csv", pages: null, caption: null } },
      { kind: "message", id: "t2u", role: "user", content: "and?", createdAt: T + 5, replyToId: "t1s1", branched: true },
      { kind: "event", id: "t2a1", createdAt: T + 6, event: { type: "skill-saved", skillId: "weekly-report", name: "Weekly report" } },
    ];
    const items = buildTranscriptItems(entries, T + 10);
    const kinds = items.filter((i) => i.kind !== "separator").map((i) => i.kind);
    expect(kinds).toEqual(["user", "bot", "widget", "card", "file", "user", "event"]);
    const user = items.find((i) => i.kind === "user" && i.key === "t1u") as Extract<(typeof items)[number], { kind: "user" }>;
    expect(user.attachments.map((a) => a.id)).toEqual(["t1ua1"]);
    const bot = items.find((i) => i.kind === "bot") as Extract<(typeof items)[number], { kind: "bot" }>;
    expect(bot.replyCount).toBe(1);
  });

  it("routes a Phase 2 form card to the card item and a Phase 3 page-fill form to the form item (merge seam)", () => {
    const entries: TranscriptEntry[] = [
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: T, status: "pending", message: { type: "card", card: { kind: "form", title: "Trip", fields: [{ name: "city", label: "City", kind: "text" }] } } },
      { kind: "send-message", id: "t1s2", requestId: "r", createdAt: T + 1, message: { type: "card", card: { kind: "form", title: "Login", url: "https://x.example", fields: [], status: "pending", answeredFields: [] } } },
    ];
    const kinds = buildTranscriptItems(entries, T + 10).filter((i) => i.kind !== "separator").map((i) => i.kind);
    expect(kinds).toEqual(["card", "form"]);
  });
});
