import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaywrightConnector } from "../../computer/browser/connector";
import { BrowserHub } from "../../computer/browser/hub";
import { takeSnapshot } from "../../computer/browser/snapshot";
import { SudoDisplayControl } from "../../computer/display-control";
import { DisplayManager } from "../../computer/displays";
import { execBuf } from "../../computer/x-exec";
import { loadConfig } from "../../config";
import { SseHub } from "../../gateway/sse-hub";
import { fillIntoPage } from "../../secrets/secret-requests";

/** T17 deferral (T29): the secret goes straight into the page field over CDP on a real Chromium; the snapshot never shows it. */
describe.runIf(process.env.RUN_BOX === "1")("fillIntoPage on a real Chromium (box)", () => {
  it("fills a password field by ref and by selector, refuses another page, and the snapshot stays redacted", async () => {
    const cfg = loadConfig({ ...process.env, HOST_PRIVATE: "/tmp/p3-boxtest-fill" });
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(`${cfg.hostPrivate}/window-assignments.json`, JSON.stringify({ assignments: { boxtest: 13 }, tokens: { boxtest: "boxtest-token-000000" } }));
    const displays = new DisplayManager({ cfg, control: new SudoDisplayControl(execBuf), hub: new SseHub() });
    const hub = new BrowserHub({ displays, connector: new PlaywrightConnector(), stateDir: "/tmp/p3-boxtest-fill-views" });
    try {
      const tab = await hub.tab("boxtest", "v");
      const url = "data:text/html,<label>User <input id=u></label><label>Password <input id=p type=password></label>";
      await tab.page.goto(url, { timeoutMs: 25_000 });
      const snap = await takeSnapshot(tab.page);
      hub.setRefs("v", snap.refs);
      const ref = /textbox "Password" \[ref=(e\d+)\]/.exec(snap.text)?.[1];
      const byRef = ref ? await fillIntoPage({ hub, botId: "boxtest", viewId: "v", target: { ref }, url, value: "s3cret-by-ref" }) : false;
      const bySel = await fillIntoPage({ hub, botId: "boxtest", viewId: "v", target: { selector: "#u" }, url, value: "user-by-selector" });
      const other = await fillIntoPage({ hub, botId: "boxtest", viewId: "v", target: { selector: "#u" }, url: "https://elsewhere.example/", value: "nope" });
      const values = await tab.page.evaluate<string>("document.querySelector('#p').value + '|' + document.querySelector('#u').value");
      expect(bySel).toBe(true);
      expect(other).toBe(false);
      expect(values.split("|")[1]).toBe("user-by-selector");
      expect(ref).toBeTruthy();
      expect(byRef).toBe(true);
      expect(values.split("|")[0]).toBe("s3cret-by-ref");
      expect((await takeSnapshot(tab.page)).text).not.toContain("s3cret-by-ref");
    } finally {
      await hub.close();
      await displays.release("boxtest");
    }
  }, 120_000);
});
