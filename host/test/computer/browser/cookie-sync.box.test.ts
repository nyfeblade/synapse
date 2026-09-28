import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaywrightConnector } from "../../../computer/browser/connector";
import { CookieSync, type Cookie } from "../../../computer/browser/cookie-sync";
import { SudoDisplayControl } from "../../../computer/display-control";
import { DisplayManager } from "../../../computer/displays";
import { execBuf } from "../../../computer/x-exec";
import { loadConfig } from "../../../config";
import { SseHub } from "../../../gateway/sse-hub";

/** T31 deferral (T29): real CDP Storage.getCookies/setCookies/deleteCookies between the primary :1 and a per-screen profile. */
describe.runIf(process.env.RUN_BOX === "1")("CookieSync on real Chromium profiles (box)", () => {
  it("seeds a new screen from :1, copies a login back to :1, and propagates a logout", async () => {
    const cfg = loadConfig({ ...process.env, HOST_PRIVATE: "/tmp/p3-boxtest-cookies" });
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(`${cfg.hostPrivate}/window-assignments.json`, JSON.stringify({ assignments: { boxtest: 13 }, tokens: { boxtest: "boxtest-token-000000" } }));
    const displays = new DisplayManager({ cfg, control: new SudoDisplayControl(execBuf), hub: new SseHub() });
    const connector = new PlaywrightConnector();
    const sync = new CookieSync({ connector, displays });
    const primary = await connector.connect(9223);
    const domain = "p3-cookie-test.example";
    const jar = async (port: number) => ((await (await connector.connect(port)).browserSend<{ cookies: Cookie[] }>("Storage.getCookies")).cookies ?? []).filter((c) => c.domain.endsWith(domain));
    const mk = (name: string, value: string) => ({ name, value, domain, path: "/", expires: Math.floor(Date.now() / 1000) + 3600, secure: false, httpOnly: false });
    try {
      await primary.browserSend("Storage.setCookies", { cookies: [mk("shared_login", "from-primary")] });
      await displays.ensure("boxtest");
      await sync.seed(13);
      expect((await jar(9235)).map((c) => `${c.name}=${c.value}`)).toContain("shared_login=from-primary");
      const screen = await connector.connect(9235);
      await screen.browserSend("Storage.setCookies", { cookies: [mk("screen_login", "from-13")] });
      await sync.sync();
      expect((await jar(9223)).map((c) => `${c.name}=${c.value}`)).toContain("screen_login=from-13");
      await screen.browserSend("Storage.setCookies", { cookies: [{ ...mk("screen_login", ""), expires: 1 }] }); // the user logs out on :13
      await sync.sync();
      expect((await jar(9223)).map((c) => c.name)).not.toContain("screen_login");
    } finally {
      await primary.browserSend("Storage.setCookies", { cookies: [{ ...mk("shared_login", ""), expires: 1 }, { ...mk("screen_login", ""), expires: 1 }] }).catch(() => {});
      await displays.release("boxtest");
    }
  }, 120_000);
});
