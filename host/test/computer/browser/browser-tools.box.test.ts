import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../../../computer/browser/browser-tools";
import { BrowserHub } from "../../../computer/browser/hub";
import { PlaywrightConnector } from "../../../computer/browser/connector";
import { DisplayManager } from "../../../computer/displays";
import { SudoDisplayControl } from "../../../computer/display-control";
import { execBuf } from "../../../computer/x-exec";
import { SseHub } from "../../../gateway/sse-hub";
import { loadConfig } from "../../../config";

describe.runIf(process.env.RUN_BOX === "1")("browser tools on a real Chromium (box)", () => {
  it("navigate → snapshot → fill → click works end to end", async () => {
    const cfg = loadConfig({ ...process.env, HOST_PRIVATE: "/tmp/p3-boxtest-host" });
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(`${cfg.hostPrivate}/window-assignments.json`, JSON.stringify({ assignments: { boxtest: 13 }, tokens: { boxtest: "boxtest-token-000000" } }));
    const displays = new DisplayManager({ cfg, control: new SudoDisplayControl(execBuf), hub: new SseHub() });
    const hub = new BrowserHub({ displays, connector: new PlaywrightConnector(), stateDir: "/tmp/p3-boxtest-views" });
    const tools = createBrowserTools({ botId: "boxtest", viewId: () => "v", hub, bus: new SseHub(), now: Date.now });
    const t = (n: string) => tools.find((x) => x.name === n)!;
    await t("browser_navigate").handler({ url: "data:text/html,<input aria-label=Name><button onclick=\"document.title=document.querySelector('input').value\">Save</button>" });
    const snap = await t("browser_snapshot").handler({});
    const nameRef = /textbox "Name" \[ref=(e\d+)\]/.exec(snap.text)![1];
    const saveRef = /button "Save" \[ref=(e\d+)\]/.exec(snap.text)![1];
    await t("browser_fill").handler({ ref: nameRef, value: "Ada" });
    await t("browser_click").handler({ ref: saveRef });
    const tabs = await t("browser_tabs").handler({ action: "list" });
    expect(tabs.text).toContain("Ada");
    await hub.close();
    await displays.release("boxtest");
  }, 120_000);
});
