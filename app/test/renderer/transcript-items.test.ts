import { describe, expect, it } from "vitest";
import type { ToolCallEntry, TranscriptEntry } from "@synapse/shared";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";

const tc = (id: string, seg: string, verb: string, noun: string, count: number, over: Partial<ToolCallEntry> = {}): ToolCallEntry => ({
  kind: "tool-call", id, requestId: "r1", segmentId: seg, hidden: false, name: "x", step: `${verb} step`, icon: "mail",
  metric: { verb, noun, nounPlural: `${noun}s`, count }, status: "done", startedAt: 1000, endedAt: 1100, ...over,
});

describe("buildTranscriptItems (CHAT-15, CHAT-22)", () => {
  it("merges a segment's calls into '<Verb> <count> <noun>' rows, max 3 + more", () => {
    const entries: TranscriptEntry[] = [
      { kind: "message", id: "t1u", role: "user", content: "clear my inbox", createdAt: 1000 },
      tc("a1", "r1:0", "Read", "email", 20), tc("a2", "r1:0", "Read", "email", 28),
      { kind: "send-message", id: "t1s1", requestId: "r1", createdAt: 1200, message: { type: "text", content: "Done sorting." } },
      tc("a3", "r1:1", "Archived", "email", 41), tc("a4", "r1:1", "Ran", "command", 1, { icon: "terminal" }), tc("a5", "r1:1", "Browsed", "page", 2),
      tc("a6", "r1:1", "Edited", "file", 1), tc("a7", "r1:1", "Edited", "file", 1),
    ];
    const items = buildTranscriptItems(entries, 2000);
    expect(items.map((i) => i.kind)).toEqual(["separator", "user", "activity", "bot", "activity"]);
    const [, , first, , second] = items as never[] as { rows: { verb: string; count: number; noun: string }[]; more: number }[];
    expect(first!.rows).toEqual([{ verb: "Read", noun: "emails", count: 48, icon: "mail" }]);
    expect(second!.rows.map((r) => `${r.verb} ${r.count} ${r.noun}`)).toEqual(["Archived 41 emails", "Ran 1 command", "Browsed 2 pages"]);
    expect(second!.more).toBe(2);
  });

  it("dedupes item ids across calls and hides hidden segments without visible output (EVT-04)", () => {
    const entries: TranscriptEntry[] = [
      tc("a1", "r2:0", "Browsed", "page", 1, { requestId: "r2", metric: { verb: "Browsed", noun: "page", nounPlural: "pages", count: 1, itemIds: ["https://a"] } }),
      tc("a2", "r2:0", "Browsed", "page", 1, { requestId: "r2", metric: { verb: "Browsed", noun: "page", nounPlural: "pages", count: 1, itemIds: ["https://a"] } }),
      tc("h1", "r3:0", "Ran", "command", 1, { requestId: "r3", hidden: true }),
    ];
    const items = buildTranscriptItems(entries, 2000).filter((i) => i.kind === "activity") as { rows: { count: number; noun: string }[] }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.rows[0]).toMatchObject({ count: 1, noun: "page" });
  });

  it("renders a notice entry instead of silently dropping it", () => {
    const entries: TranscriptEntry[] = [
      { kind: "notice", id: "n1", text: "The model service is busy", createdAt: 1000 },
    ];
    const items = buildTranscriptItems(entries, 2000);
    expect(items).toContainEqual({ kind: "notice", key: "n1", text: "The model service is busy" });
  });

  // A DAY DIVIDER, not a gap marker. The 15-minute rule is gone: it put "Today 9:00 AM" and "Today
  // 9:20 AM" twenty minutes apart in one conversation — the same day announced twice, over turns
  // that each print their own time in their own head. One separator per calendar day, and it says
  // the day. These three entries are all on one day, so there is exactly one.
  it("opens each calendar day with one day divider, and marks running segments live", () => {
    const t0 = new Date(2026, 8, 18, 7, 2).getTime();
    const entries: TranscriptEntry[] = [
      { kind: "message", id: "t1u", role: "user", content: "a", createdAt: t0 },
      { kind: "message", id: "t2u", role: "user", content: "b", createdAt: t0 + 16 * 60_000 },
      tc("a1", "r4:0", "Ran", "command", 0, { requestId: "r4", status: "running", metric: null, step: "Ran npm test", startedAt: t0 + 17 * 60_000 }),
    ];
    const items = buildTranscriptItems(entries, t0 + 20 * 60_000);
    const seps = items.filter((i) => i.kind === "separator") as { label: string }[];
    expect(seps, "one day, one divider — a 16-minute gap is not a new day").toHaveLength(1);
    expect(seps[0]!.label, "the divider names the day and never a clock time").toBe("Today");
    const act = items.at(-1) as { running: boolean; rows: { verb: string }[] };
    expect(act.running).toBe(true);
    expect(act.rows[0]!.verb).toBe("Ran npm test");
  });
});
