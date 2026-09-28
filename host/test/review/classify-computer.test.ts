import { describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";

const o = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
const C = (toolName: string, input: Record<string, unknown>, enforce = true) => classifyTool({ toolName, input, toolUseId: "t" }, { ...o, enforce });

describe("classifyTool — Phase 3 surfaces (APR-02)", () => {
  it("Shell is box_shell with the same guards as Bash; Bash in the background points to Shell", () => {
    expect(C("mcp__bot__Shell", { command: "npm run build", block_until_ms: 0 })).toMatchObject({ surface: "box_shell", sideEffect: true, target: { arguments: { background: true } } });
    expect(C("mcp__bot__Shell", { command: "xdotool click 1" }).hardDeny).toMatch(/Shell can't drive the desktop's UI/);
    expect(C("mcp__bot__Shell", { command: "cat /home/box/.host/vault.key" }).hardDeny).toMatch(/private to the app/);
    expect(C("Bash", { command: "sleep 100", run_in_background: true }).hardDeny).toBe("Run long or background commands with the Shell tool (block_until_ms: 0 starts it in the background), not Bash.");
  });

  it("Task launch is the subagent surface; steering, stopping and checking are not reviewed", () => {
    expect(C("mcp__bot__Task", { description: "Hold the Denver fare", prompt: "Go to northwind…", subagent_type: "browserUse" })).toMatchObject({
      surface: "subagent", summary: "Run a task on Bots' computer: “Hold the Denver fare”", target: { action: "subagent", arguments: { type: "browserUse" } },
    });
    expect(C("mcp__bot__MessageSubagent", { subagent_id: "s", message: "m" })).toMatchObject({ surface: null, sideEffect: true });
    expect(C("mcp__bot__CheckSubagent", { subagent_id: "s" })).toMatchObject({ surface: null, sideEffect: false });
    expect(C("mcp__bot__Screenshot", {})).toMatchObject({ surface: null, sideEffect: false });
    expect(C("mcp__bot__request_box_help", { instruction: "x", reason: "auth" })).toMatchObject({ surface: null, sideEffect: false });
  });

  it("Computer: click/drag/type/key are reviewed with spec summaries; screenshot/move/wait/scroll are not", () => {
    expect(C("mcp__computer__Computer", { action: "click", x: 100, y: 200, description: "Open Sign in" })).toMatchObject({
      surface: "computer", summary: "Click at (100, 200) on Bots' computer to open Sign in",
      target: { action: "computer", arguments: { action_kind: "click", coordinates: [100, 200], declared_purpose: "Open Sign in" } },
    });
    expect(C("mcp__computer__Computer", { action: "type", text: "ada@example.com" }).summary).toBe("Type “ada@example.com” on Bots' computer");
    expect(C("mcp__computer__Computer", { action: "key", key: "ctrl+Return" }).summary).toBe("Press ctrl+Return on Bots' computer");
    for (const action of ["screenshot", "move", "wait", "scroll"]) expect(C("mcp__computer__Computer", { action, x: 1, y: 1 }).surface).toBeNull();
    expect(C("mcp__computer__Computer", { action: "click", x: 1, y: 1 }).hardDeny).toMatch(/Add a description/);
    expect(C("mcp__computer__Computer", { action: "click", x: 1, y: 1 }, false).hardDeny).toBeNull();
  });

  it("browser: navigation and input are reviewed; snapshot/screenshot/bbox/highlight/scroll are not; tabs only new/close", () => {
    expect(C("mcp__computer__browser_navigate", { url: "https://northwind-air.example" })).toMatchObject({ surface: "computer", summary: "Open https://northwind-air.example in the browser on Bots' computer" });
    expect(C("mcp__computer__browser_click", { ref: "e4", element: "Hold fare" }).summary).toBe("Click “Hold fare” in the browser on Bots' computer");
    for (const t of ["browser_snapshot", "browser_take_screenshot", "browser_get_bounding_box", "browser_highlight", "browser_scroll"]) expect(C(`mcp__computer__${t}`, {}).surface).toBeNull();
    expect(C("mcp__computer__browser_tabs", { action: "list" }).surface).toBeNull();
    expect(C("mcp__computer__browser_tabs", { action: "close", index: 1 }).summary).toBe("Close browser tab 1 on Bots' computer");
  });
});
