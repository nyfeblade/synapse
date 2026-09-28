import { describe, expect, it } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { NotificationPolicy } from "../../src/coordinator/notification-policy";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "b1", profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, presence: "idle", activity: null, marker: null, statusLine: "",
  running: false, awaiting: null, createdAt: 0, updatedAt: 0, lastBotMessageAt: 0, ...over,
});

function setup() {
  let t = 1_000_000;
  const sent: { title: string; body: string; kind: string }[] = [];
  const badges: number[] = [];
  const p = new NotificationPolicy({ now: () => t, notify: (n) => sent.push(n), badge: (c) => badges.push(c) });
  return { p, sent, badges, tick: (ms: number) => { t += ms; } };
}

describe("NotificationPolicy (NTF-01, BOT-23)", () => {
  it("baselines at startup without notifying, then notifies needs-you and finished while unfocused", () => {
    const { p, sent, badges, tick } = setup();
    p.baseline([bot({ awaiting: { tabId: "widget", reason: "old", since: 1 }, marker: "blocked" })]);
    expect(sent).toEqual([]);
    expect(badges).toEqual([1]);
    p.setFocused(false);
    p.update(bot({ awaiting: { tabId: "auto-review", reason: "Approval needed: send 5 emails", since: 2 }, marker: "blocked" }));
    expect(sent.at(-1)).toEqual({ botId: "b1", title: "Courier needs you", body: "Approval needed: send 5 emails", kind: "needs-you" });
    p.update(bot({ running: true }));
    tick(6000);
    p.update(bot({ running: false, lastBotMessageAt: 5, statusLine: "Sent all 5.", marker: "unread" }));
    expect(sent.at(-1)).toEqual({ botId: "b1", title: "Courier", body: "Sent all 5.", kind: "finished" });
    expect(badges.at(-1)).toBe(1);
  });

  it("stays quiet when focused, notifications off, hidden, throttled, or no new message", () => {
    const { p, sent, tick } = setup();
    p.baseline([bot()]);
    p.update(bot({ running: true }));
    p.update(bot({ running: false, lastBotMessageAt: 5 })); // focused (default)
    p.setFocused(false);
    p.update(bot({ running: true, lastBotMessageAt: 5 }));
    p.update(bot({ running: false, lastBotMessageAt: 5 })); // no new message
    p.update(bot({ settings: { notifyOnAgentUpdates: false, hiddenFromSidebar: false }, awaiting: { tabId: "widget", reason: "Q", since: 3 } }));
    p.update(bot({ settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true }, awaiting: { tabId: "widget", reason: "Q2", since: 4 } }));
    expect(sent).toEqual([]);
    p.update(bot({ awaiting: { tabId: "widget", reason: "Q3", since: 5 } }));
    p.update(bot({ awaiting: { tabId: "widget", reason: "Q4", since: 6 } }));
    expect(sent).toHaveLength(1); // 5 s throttle per Bot and kind
    tick(5001);
    p.update(bot({ awaiting: { tabId: "widget", reason: "Q5", since: 7 } }));
    expect(sent).toHaveLength(2);
  });

  it("uses the fallback bodies and caps at 140 chars", () => {
    const { p, sent } = setup();
    p.baseline([bot()]);
    p.setFocused(false);
    p.update(bot({ awaiting: { tabId: "box", reason: "", since: 2 } }));
    expect(sent.at(-1)!.body).toBe("Waiting for your input.");
    p.update(bot({ id: "b2", running: true }));
    p.update(bot({ id: "b2", running: false, lastBotMessageAt: 9, statusLine: "" }));
    expect(sent.at(-1)!.body).toBe("Open Synapse to see what it did.");
    p.update(bot({ id: "b3", running: true }));
    p.update(bot({ id: "b3", running: false, lastBotMessageAt: 9, statusLine: "x".repeat(200) }));
    expect(sent.at(-1)!.body).toHaveLength(140);
  });
});
