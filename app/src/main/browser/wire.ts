/**
 * mac-browser, main-process wiring: the controller that the coordinator's local-exec daemon calls (over the parent
 * port) once this Mac's own gate passed, plus the renderer's "Show window". Chrome starts lazily, on a Bot's first
 * Browser action, with a dedicated profile in the app's data (the user's own Chrome profile is never touched).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitNative, registerNative } from "../native";
import { ChromeDriver, findChrome } from "./cdp";
import { BrowserController, type BrowserDriver, type ControllerRequest } from "./controller";
import { BrowserSignin } from "./signin";

export function registerMacBrowser(o: { userData: string; log(line: string): void; post(m: unknown): void; downloads?: string }): { onMessage(m: { type: string; id?: number; req?: unknown; botId?: string }): boolean; close(): Promise<void> } {
  const downloads = o.downloads ?? path.join(os.homedir(), "Downloads");
  const profileDir = path.join(o.userData, "browser-profile");
  const launch = async (): Promise<BrowserDriver> => {
    const chrome = findChrome();
    if (chrome) {
      try {
        return await ChromeDriver.launch({ chrome, profileDir, downloads });
      } catch (e) {
        o.log(`browser: Chrome did not start (${(e as Error).message}); using the built-in window`);
      }
    }
    fs.mkdirSync(downloads, { recursive: true });
    const { ElectronBrowserDriver } = await import("./electron-driver");
    return new ElectronBrowserDriver(downloads);
  };
  const controller = new BrowserController({ launch, now: Date.now, log: o.log });
  registerNative("browser.show", async (a: { botId?: string }) => ({ shown: typeof a?.botId === "string" ? await controller.show(a.botId) : false }));
  // "Sign in to sites" (bug-log 150): the same profile in plain Chrome, so Google treats it as a normal browser.
  const signin = new BrowserSignin({ controller, chrome: findChrome(), profileDir, log: o.log, onChange: (active) => emitNative("browser.signin", { active }) });
  registerNative("browser.signin", async (a: { action?: string }) => {
    if (a?.action === "start") await signin.start();
    else if (a?.action === "done") await signin.done();
    return { active: signin.active() };
  });
  return {
    onMessage(m) {
      if (m.type === "browser" && typeof m.id === "number") {
        const id = m.id;
        void controller.handle(m.req as ControllerRequest)
          .catch((e: unknown) => ({ ok: false as const, error: `The browser failed: ${(e as Error).message}` }))
          .then((result) => o.post({ type: "browser-result", id, result }));
        return true;
      }
      if (m.type === "browser-origin" && typeof m.id === "number") {
        o.post({ type: "browser-result", id: m.id, result: typeof m.botId === "string" ? controller.lastRefusalOrigin(m.botId) : null });
        return true;
      }
      return false;
    },
    close: async () => { await Promise.all([controller.close(), signin.done()]); },
  };
}
