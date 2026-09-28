import { describe, expect, it } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { applyEvent, initialState, sortedBotIds, upsertEntry } from "../../src/renderer/reducer";

const bot = (id: string, updatedAt: number, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: id, title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

describe("renderer reducer", () => {
  it("upserts Bots, keeps recent order and handles removal", () => {
    let s = initialState();
    s = applyEvent(s, { channel: "agent-upserted", payload: { agent: bot("a", 1) } });
    s = applyEvent(s, { channel: "agent-upserted", payload: { agent: bot("b", 2) } });
    expect(sortedBotIds(s.bots)).toEqual(["b", "a"]);
    s = { ...s, view: { kind: "chat", botId: "b" } };
    s = applyEvent(s, { channel: "agents", payload: { removedId: "b", activeAgentId: "a" } });
    expect(Object.keys(s.bots)).toEqual(["a"]);
    expect(s.view).toEqual({ kind: "chat", botId: "a" });
  });

  it("appends and updates transcript entries in place and tracks typing", () => {
    let s = initialState();
    const e1 = { kind: "message" as const, id: "t1u", role: "user" as const, content: "hi", createdAt: 1 };
    s = applyEvent(s, { channel: "transcript", payload: { botId: "a", op: "append", entry: e1 } });
    s = applyEvent(s, { channel: "transcript", payload: { botId: "a", op: "append", entry: e1 } });
    expect(s.transcripts.a).toHaveLength(1);
    s = applyEvent(s, { channel: "transcript", payload: { botId: "a", op: "update", entry: { ...e1, content: "hello" } } });
    expect((s.transcripts.a![0] as { content: string }).content).toBe("hello");
    s = applyEvent(s, { channel: "transcript", payload: { botId: "a", op: "typing", typing: true, partialText: "Hel" } });
    expect(s.typing.a).toEqual({ typing: true, partialText: "Hel" });
    expect(upsertEntry([], e1)).toEqual([e1]);
  });

  it("stores trays and host settings (pins)", () => {
    let s = initialState();
    s = applyEvent(s, { channel: "tray", payload: { trays: [{ id: "t", botId: "a", title: "Bot failed to respond", detail: null, requestId: null, buttons: [], dedupeKey: null, count: 1, createdAt: 1 }] } });
    s = applyEvent(s, { channel: "host-settings", payload: { autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "UTC", userTimeZoneOverride: null, pinnedAgentIds: ["a"], themePreference: "system", memoryRecall: true, advancedEnabled: false } });
    expect(s.trays).toHaveLength(1);
    expect(s.pinned).toEqual(["a"]);
  });
});
