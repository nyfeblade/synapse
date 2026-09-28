import { describe, expect, it } from "vitest";
import { activityDetail, PresenceTracker, toolPersona } from "../../presence/presence";

describe("presence (BOT-19, BOT-20)", () => {
  it("maps tools to personas", () => {
    expect(toolPersona("Bash")).toBe("working");
    expect(toolPersona("WebSearch")).toBe("searching");
    expect(toolPersona("mcp__bot__CreateAgent")).toBe("sending");
    expect(toolPersona("mcp__bot__SendMessage")).toBe("thinking");
  });
  it("derives activity detail ≤80 chars", () => {
    expect(activityDetail("Bash", { command: "echo hi > /workspace/out.txt" })).toBe("out.txt");
    expect(activityDetail("Bash", { command: "x".repeat(100) })).toHaveLength(80);
    // cost-diet-2 lever 2: an everyday Bot shells through the host Shell, so its status reads the same.
    expect(activityDetail("mcp__bot__Shell", { command: "echo hi > /workspace/out.txt" })).toBe("out.txt");
    expect(activityDetail("mcp__bot__Shell", { command: "ls -la" })).toBe("ls -la");
    expect(activityDetail("WebFetch", { url: "https://example.com/a" })).toBe("example.com");
  });
  it("holds a named activity for 2.5 s through thinking, then shows thinking, then idle", () => {
    let t = 0;
    const changes: string[] = [];
    const p = new PresenceTracker((id) => changes.push(id), () => t);
    p.turnStarted("b");
    expect(p.view("b")).toMatchObject({ presence: "working", running: true });
    p.toolStart("b", "WebSearch", { query: "desks" });
    expect(p.view("b")).toMatchObject({ presence: "searching", activity: { tool: "WebSearch", detail: "desks" } });
    p.toolEnd("b", "WebSearch");
    p.thinking("b", true);
    t = 2000;
    expect(p.view("b").presence).toBe("searching");
    t = 3000;
    expect(p.view("b")).toMatchObject({ presence: "thinking", activity: { thinking: true } });
    p.turnEnded("b");
    expect(p.view("b")).toEqual({ presence: "idle", activity: null, running: false });
    expect(changes.length).toBeGreaterThan(3);
  });
});
