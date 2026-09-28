import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SseHub } from "../../gateway/sse-hub";
import { DisplayManager } from "../../computer/displays";
import { SudoDisplayControl } from "../../computer/display-control";
import { createComputerTool } from "../../computer/computer-tool";
import { execBuf } from "../../computer/x-exec";
import { loadConfig } from "../../config";

describe.runIf(process.env.RUN_BOX === "1")("Computer on a real display (box)", () => {
  it("drives the display's Chromium (focus, omnibox, type) and the screenshot changes", async () => {
    const cfg = loadConfig({ ...process.env, HOST_PRIVATE: "/tmp/p3-boxtest-host" });
    // Seat 13 is reserved for box tests so a real Bot's screen (from :2 up) is never touched.
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(`${cfg.hostPrivate}/window-assignments.json`, JSON.stringify({ assignments: { boxtest: 13 }, tokens: { boxtest: "boxtest-token-000000" } }));
    const displays = new DisplayManager({ cfg, control: new SudoDisplayControl(execBuf), hub: new SseHub(), maxScreens: 12 });
    const tool = createComputerTool({ botId: "boxtest", displays, hub: new SseHub(), workspace: "/tmp", enforce: () => false, now: Date.now });
    const before = await tool.handler({ action: "screenshot" });
    await tool.handler({ action: "click", x: 640, y: 400, description: "Focus the browser window" });
    await tool.handler({ action: "key", key: "ctrl+l" });
    const after = await tool.handler({ action: "type", text: "data:text/html,<h1 style='font-size:120px'>computer-ok</h1>\n" });
    expect(after.text).toMatch(/Pointer at/);
    expect(after.images?.[0]?.data).not.toBe(before.images?.[0]?.data);
    await displays.release("boxtest");
  }, 90_000);
});
