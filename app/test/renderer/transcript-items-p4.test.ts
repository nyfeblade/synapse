import { describe, expect, it } from "vitest";
import type { AgentMessageEntry, SendMessageEntry, TranscriptEntry } from "@synapse/shared";
import { buildTranscriptItems, isFanOut } from "../../src/renderer/transcript-items";

const out = (id: string, to: string, name: string, content = "req"): AgentMessageEntry => ({ kind: "message", id, role: "assistant", content, toAgent: { id: to, name, kind: "request" }, chainId: "c_1", createdAt: 10 });
const inb = (id: string, from: string, name: string, content = "res", inbox = false): AgentMessageEntry => ({ kind: "message", id, role: "user", content, fromAgent: { id: from, name, kind: "result" }, ...(inbox ? { inbox } : {}), chainId: "c_1", createdAt: 11 });

describe("buildTranscriptItems — Phase 4 entries", () => {
  it("collapses Bot-to-Bot entries between visible messages into one exchange (CHAT-04)", () => {
    const entries: TranscriptEntry[] = [
      { kind: "message", id: "t1u", role: "user", content: "get me leads", createdAt: 1 },
      out("t2a1", "s", "Scout"), inb("t3a1", "s", "Scout"), inb("t4a1", "l", "Ledger", "fyi", true),
      { kind: "send-message", id: "t5s1", requestId: "r", createdAt: 20, message: { type: "text", content: "Here are the leads." } },
    ];
    const items = buildTranscriptItems(entries, 30);
    expect(items.map((i) => i.kind)).toEqual(["separator", "user", "exchange", "bot"]);
    const ex = items[2] as { peers: { id: string }[]; count: number; entries: unknown[] };
    expect(ex.count).toBe(3);
    expect(ex.peers.map((p) => p.id)).toEqual(["s", "l"]);
  });

  it("does not treat Bot messages as user bubbles", () => {
    const items = buildTranscriptItems([inb("t1a1", "s", "Scout")], 30);
    expect(items.some((i) => i.kind === "user")).toBe(false);
  });

  it("recognizes a fan-out", () => {
    expect(isFanOut([out("a", "s", "Scout"), out("b", "l", "Ledger"), out("c", "p", "Planner")])).toBe(true);
    expect(isFanOut([out("a", "s", "Scout"), inb("b", "s", "Scout")])).toBe(false);
    expect(isFanOut([out("a", "s", "Scout")])).toBe(false);
    expect(isFanOut([out("a", "s", "Scout"), out("b", "s", "Scout")])).toBe(false);
  });

  it("maps Phase 4 events to event-row items and keeps Phase 1 events as event items", () => {
    const ev = (id: string, event: object): TranscriptEntry => ({ kind: "event", id, createdAt: 1, event } as TranscriptEntry);
    const items = buildTranscriptItems([
      ev("tba1", { type: "bot-created", botId: "a", name: "A" }),
      ev("t1a1", { type: "routine-created", routineId: "r", name: "Morning", nextRunAt: 100 }),
      ev("t2a1", { type: "member-pass", botIds: ["l"], roomTurnId: "rt" }),
      ev("t3a1", { type: "wake-origin", source: "agent", botIds: ["s"] }),
    ], 5);
    expect(items.filter((i) => i.kind !== "separator").map((i) => i.kind)).toEqual(["event", "event-row", "event-row", "event-row"]);
  });

  // Adapted from task-23-brief.md's verbatim sample: the "bot" item's real shape (Task 2's brief and
  // Phase 2 work) also carries `entry`/`replyCount` for Reactions/MessageActions/ThreadPanel, which the
  // brief's own simplified `{ kind: "bot"; key; text }` sample predates — same reconciliation pattern as
  // the Task 6 widget-shape ruling in implementer-rules.md. Only the added fields differ from the brief.
  it("carries the author of group member posts and renders routine seed notices", () => {
    const botEntry: SendMessageEntry = { kind: "send-message", id: "t2s1", requestId: "r", createdAt: 2, message: { type: "text", content: "3 meetings" }, author: { id: "p", name: "Planner" } };
    const items = buildTranscriptItems([
      { kind: "notice", id: "t1a1", text: "Triggered by: Morning sync\nSummarize.", createdAt: 1 },
      botEntry,
    ], 5);
    expect(items.filter((i) => i.kind !== "separator")).toEqual([
      { kind: "notice", key: "t1a1", text: "Triggered by: Morning sync\nSummarize." },
      { kind: "bot", key: "t2s1", text: "3 meetings", author: { id: "p", name: "Planner" }, entry: botEntry, replyCount: 0 },
    ]);
  });
});
