import { describe, expect, it } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { NotificationPolicy } from "../../src/coordinator/notification-policy";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1", profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, presence: "idle", activity: null, marker: null, statusLine: "",
  running: false, awaiting: null, createdAt: 0, updatedAt: 0, lastBotMessageAt: 0, ...over,
});

describe("scheduled runs notify only when the Bot says it's worth it", () => {
  it("a quiet message from a scheduled run finishes without a notification; a notify:true one notifies", () => {
    const sent: string[] = [];
    let t = 1_000_000;
    const p = new NotificationPolicy({ now: () => t, notify: (n) => sent.push(n.kind), badge: () => {} });
    p.baseline([bot()]);
    p.setFocused(false);
    p.update(bot({ running: true }));
    p.update(bot({ running: false, lastBotMessageAt: 5, lastBotMessageQuiet: true }));
    expect(sent).toEqual([]);
    t += 60_000;
    p.update(bot({ running: true }));
    p.update(bot({ running: false, lastBotMessageAt: 9, lastBotMessageQuiet: false }));
    expect(sent).toEqual(["finished"]);
  });
});
