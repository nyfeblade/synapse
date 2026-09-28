import { describe, expect, it } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { leadBot, livingAct, REMEMBER_MS, REST_AFTER_MS, restAt, STUCK_MS, toolAct } from "../../src/renderer/avatar/living-pose";

// Living Bots (bug 226), step 2: every tool the host reports maps to one readable pose, with a
// sensible fallback, and the pose follows the same presence stream as the header's live chip.

const NOW = 1_800_000_000_000;
const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: NOW - 1000, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

describe("toolAct: each tool name → one pose", () => {
  it.each([
    ["Read", "read"], ["Grep", "read"], ["Glob", "read"], ["WebFetch", "read"], ["WebSearch", "read"], ["mcp__bot__ExternalRead", "read"],
    ["Write", "write"], ["Edit", "write"], ["MultiEdit", "write"], ["mcp__bot__SendMessage", "write"],
    ["Bash", "run"], ["mcp__bot__Shell", "run"], ["mcp__bot__ExternalShell", "run"], ["mcp__bot__AwaitShell", "run"],
    ["mcp__bot__Browser", "browse"], ["mcp__bot__MacApp", "browse"], ["mcp__computer__Computer", "browse"], ["mcp__computer__browser_navigate", "browse"], ["mcp__browser__click", "browse"],
    ["Task", "think"], ["mcp__bot__Task", "think"], ["mcp__bot__SendToAgent", "think"],
    ["mcp__bot__update_state", "remember"], ["mcp__memory__save", "remember"],
  ] as const)("%s → %s", (name, act) => { expect(toolAct(name)).toBe(act); });

  it("an MCP tool is read by the verb in its name", () => {
    expect(toolAct("mcp__google__gmail_read")).toBe("read");
    expect(toolAct("mcp__google__drive_search")).toBe("read");
    expect(toolAct("mcp__linear__create_issue")).toBe("write");
    expect(toolAct("mcp__google__gmail_send")).toBe("write");
    expect(toolAct("mcp__ci__run_tests")).toBe("run");
  });

  it("anything unknown falls back to the generic working pose", () => {
    expect(toolAct("SomethingNew")).toBe("work");
    expect(toolAct("mcp__sketchy__get_everything")).toBe("read"); // still a verb it knows
    expect(toolAct("mcp__plugin__anything")).toBe("work");
    expect(toolAct("")).toBe("work");
    expect(toolAct(undefined)).toBe("work");
  });
});

describe("livingAct: the pose, in priority order", () => {
  it("a Bot that waits on the user faces out, over everything else", () => {
    expect(livingAct(bot({ running: true, activity: { tool: "Bash" }, awaiting: { tabId: "auto-review", reason: "x", since: NOW } }), NOW, { stuckAt: NOW })).toBe("needs-you");
  });
  it("a failed tool shows as stuck for a moment, then the tool stream again", () => {
    const b = bot({ running: true, activity: { tool: "Read" } });
    expect(livingAct(b, NOW, { stuckAt: NOW - 100 })).toBe("stuck");
    expect(livingAct(b, NOW, { stuckAt: NOW - STUCK_MS - 1 })).toBe("read");
  });
  it("a memory save shows as remembering for a moment", () => {
    expect(livingAct(bot(), NOW, { rememberAt: NOW - 10 })).toBe("remember");
    expect(livingAct(bot(), NOW, { rememberAt: NOW - REMEMBER_MS - 1 })).toBe("idle");
  });
  it("running: the tool's pose, else thinking, else the presence", () => {
    expect(livingAct(bot({ running: true, presence: "working", activity: { tool: "Edit", detail: "a.ts" } }), NOW)).toBe("write");
    expect(livingAct(bot({ running: true, presence: "thinking", activity: { thinking: true } }), NOW)).toBe("think");
    expect(livingAct(bot({ running: true, presence: "searching", activity: null }), NOW)).toBe("read");
    expect(livingAct(bot({ running: true, presence: "orbit", activity: null }), NOW)).toBe("think");
    expect(livingAct(bot({ running: true, presence: "working", activity: null }), NOW)).toBe("work");
  });
  it("idle, then resting after a long quiet (from its newest sign of life)", () => {
    const b = bot({ updatedAt: NOW - 1000, lastBotMessageAt: NOW - 5000 });
    expect(restAt(b)).toBe(NOW - 1000 + REST_AFTER_MS);
    expect(livingAct(b, NOW)).toBe("idle");
    expect(livingAct(b, NOW + REST_AFTER_MS)).toBe("rest");
    expect(livingAct({ ...b, running: true, activity: { tool: "Bash" } }, NOW + REST_AFTER_MS)).toBe("run"); // work wakes it
  });
});

describe("leadBot: one lead at a time", () => {
  const bots = (xs: BotSummary[]) => Object.fromEntries(xs.map((b) => [b.id, b]));
  it("nobody working: no lead (everyone plays at full size)", () => {
    expect(leadBot(bots([bot({ id: "a" }), bot({ id: "b" })]), "a")).toBeNull();
  });
  it("waiting on the user leads, the longest wait first", () => {
    const xs = [bot({ id: "a", running: true }), bot({ id: "b", awaiting: { tabId: "widget", reason: "", since: NOW - 10 } }), bot({ id: "c", awaiting: { tabId: "widget", reason: "", since: NOW - 99 } })];
    expect(leadBot(bots(xs), "a")).toBe("c");
  });
  it("then the open Bot while it works, then the most recent worker", () => {
    const xs = [bot({ id: "a", running: true, updatedAt: NOW - 50 }), bot({ id: "b", running: true, updatedAt: NOW - 5 })];
    expect(leadBot(bots(xs), "a")).toBe("a");
    expect(leadBot(bots(xs), "z")).toBe("b");
  });
});
