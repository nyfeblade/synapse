import { describe, expect, it } from "vitest";
import { eventFor, planAction, validateComputer } from "../../computer/computer-actions";

describe("planAction (BRW-03, xdotool names)", () => {
  it("click with modifiers presses, clicks and releases in order", () => {
    expect(planAction({ action: "click", x: 10, y: 20, button: "right", count: 2, modifiers: ["ctrl", "cmd"] })).toEqual([
      { xdotool: ["keydown", "ctrl"] }, { xdotool: ["keydown", "super"] },
      { xdotool: ["mousemove", "--sync", "10", "20"] }, { xdotool: ["click", "--repeat", "2", "--delay", "80", "3"] },
      { xdotool: ["keyup", "super"] }, { xdotool: ["keyup", "ctrl"] },
    ]);
  });
  it("drag follows the path when given, else goes straight to (x2, y2)", () => {
    expect(planAction({ action: "drag", x: 1, y: 2, x2: 30, y2: 40 })).toEqual([
      { xdotool: ["mousemove", "--sync", "1", "2"] }, { xdotool: ["mousedown", "1"] },
      { xdotool: ["mousemove", "--sync", "30", "40"] }, { xdotool: ["mouseup", "1"] },
    ]);
    expect(planAction({ action: "drag", x: 1, y: 2, path: [{ x: 5, y: 5 }, { x: 9, y: 9 }] }).map((s) => ("xdotool" in s ? s.xdotool.join(" ") : ""))).toEqual([
      "mousemove --sync 1 2", "mousedown 1", "mousemove --sync 5 5", "mousemove --sync 9 9", "mouseup 1",
    ]);
  });
  it("type, key, scroll, wait and screenshot", () => {
    expect(planAction({ action: "type", text: "--help me" })).toEqual([{ xdotool: ["type", "--delay", "12", "--", "--help me"] }]);
    expect(planAction({ action: "key", key: "ctrl+a" })).toEqual([{ xdotool: ["key", "--clearmodifiers", "--", "ctrl+a"] }]);
    expect(planAction({ action: "scroll", x: 5, y: 6, direction: "down", amount: 4 })).toEqual([
      { xdotool: ["mousemove", "--sync", "5", "6"] }, { xdotool: ["click", "--repeat", "4", "--delay", "40", "5"] },
    ]);
    expect(planAction({ action: "wait", durationMs: 60_000 })).toEqual([{ sleepMs: 10_000 }]);
    expect(planAction({ action: "screenshot" })).toEqual([]);
  });
  it("events for the preview cursor (CMP-07)", () => {
    expect(eventFor({ action: "click", x: 3, y: 4 })).toEqual({ kind: "click", x: 3, y: 4 });
    expect(eventFor({ action: "drag", x: 1, y: 2, x2: 7, y2: 8 })).toEqual({ kind: "drag", x: 1, y: 2, x2: 7, y2: 8 });
    expect(eventFor({ action: "type", text: "a" })).toEqual({ kind: "type", x: null, y: null });
    expect(eventFor({ action: "screenshot" })).toBeNull();
  });
});

describe("validateComputer", () => {
  it("rejects coordinates outside 0..1279 × 0..799 with the spec wording", () => {
    expect(validateComputer({ action: "click", x: 1280, y: 10, description: "d" }, { enforce: false })).toBe("Coordinates must be inside the 1280×800 screen: x from 0 to 1279, y from 0 to 799.");
    expect(validateComputer({ action: "move", x: 0, y: 799 }, { enforce: false })).toBeNull();
  });
  it("enforces the limits (text 2,000, key 256, path 64, description 500, then 1–9 without screenshot)", () => {
    expect(validateComputer({ action: "type", text: "x".repeat(2001) }, { enforce: false })).toMatch(/2,000/);
    expect(validateComputer({ action: "key", key: "k".repeat(257) }, { enforce: false })).toMatch(/256/);
    expect(validateComputer({ action: "drag", x: 1, y: 1, path: Array.from({ length: 65 }, () => ({ x: 1, y: 1 })) }, { enforce: false })).toMatch(/64/);
    expect(validateComputer({ action: "click", x: 1, y: 1, description: "d".repeat(501) }, { enforce: false })).toMatch(/500/);
    expect(validateComputer({ action: "move", x: 1, y: 1, then: [] }, { enforce: false })).toMatch(/1–9/);
    expect(validateComputer({ action: "move", x: 1, y: 1, then: Array.from({ length: 10 }, () => ({ action: "wait" as const })) }, { enforce: false })).toMatch(/1–9/);
    expect(validateComputer({ action: "move", x: 1, y: 1, then: [{ action: "screenshot" }] }, { enforce: false })).toMatch(/final screenshot/);
  });
  it("in enforce mode, click/drag need a description and then may only hold move, wait or scroll", () => {
    expect(validateComputer({ action: "click", x: 1, y: 1 }, { enforce: true })).toBe("Add a description of what this click or drag is for (Auto-review needs it), then retry.");
    expect(validateComputer({ action: "click", x: 1, y: 1, description: "Open the menu", then: [{ action: "type", text: "a" }] }, { enforce: true })).toBe("With Auto-review on, `then` may only contain move, wait or scroll steps.");
    expect(validateComputer({ action: "click", x: 1, y: 1, description: "Open the menu", then: [{ action: "wait", durationMs: 500 }] }, { enforce: true })).toBeNull();
    expect(validateComputer({ action: "click", x: 1, y: 1 }, { enforce: false })).toBeNull();
  });
});
