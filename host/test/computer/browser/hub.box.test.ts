import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserHub } from "../../../computer/browser/hub";
import { PlaywrightConnector } from "../../../computer/browser/connector";
import { takeSnapshot } from "../../../computer/browser/snapshot";
import { DisplayManager } from "../../../computer/displays";
import { SudoDisplayControl } from "../../../computer/display-control";
import { execBuf } from "../../../computer/x-exec";
import { SseHub } from "../../../gateway/sse-hub";
import { loadConfig } from "../../../config";

describe.runIf(process.env.RUN_BOX === "1")("BrowserHub on a real Chromium (box)", () => {
  it("opens a tab, snapshots with refs and redacts the password", async () => {
    const cfg = loadConfig({ ...process.env, HOST_PRIVATE: "/tmp/p3-boxtest-host" });
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(`${cfg.hostPrivate}/window-assignments.json`, JSON.stringify({ assignments: { boxtest: 13 }, tokens: { boxtest: "boxtest-token-000000" } }));
    const displays = new DisplayManager({ cfg, control: new SudoDisplayControl(execBuf), hub: new SseHub() });
    const hub = new BrowserHub({ displays, connector: new PlaywrightConnector(), stateDir: "/tmp/p3-boxtest-views" });
    const tab = await hub.tab("boxtest", "view-1");
    await tab.page.goto("data:text/html,<h1>Box</h1><label>Email <input type=email></label><label>Pass <input type=password value=hunter2></label><button>Go</button>", { timeoutMs: 25_000 });
    const snap = await takeSnapshot(tab.page);
    expect(snap.text).toMatch(/button "Go" \[ref=e\d+\]/);
    expect(snap.text).not.toContain("hunter2");
    await hub.close();
    await displays.release("boxtest");
  }, 120_000);
});
