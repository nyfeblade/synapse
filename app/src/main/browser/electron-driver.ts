/**
 * mac-browser fallback when Google Chrome isn't installed: an Electron window per Bot, driven over
 * webContents.debugger (the same CDP the Chrome driver speaks, so CdpTab does the work). Its own persistent session
 * partition keeps sign-ins apart from the app's. One tab per window: pages that open a new window load in the same one.
 */
import path from "node:path";
import { BrowserWindow, session as electronSession, type WebContents } from "electron";
import type { BrowserDriver, Tab } from "./controller";
import { CdpTab, type CdpChannel } from "./cdp";

export const FALLBACK_PARTITION = "persist:synapse-browser";

function channel(wc: WebContents): CdpChannel {
  const dbg = wc.debugger;
  return {
    send: (method, params) => dbg.sendCommand(method, params ?? {}) as Promise<never>,
    on: (event, cb) => {
      const h = (_e: unknown, method: string, params: unknown) => { if (method === event) cb(params); };
      dbg.on("message", h);
      return () => dbg.off("message", h);
    },
  };
}

export class ElectronBrowserDriver implements BrowserDriver {
  kind = "electron" as const;
  private wins = new Set<BrowserWindow>();
  private dl: ((p: { path: string } | null) => void) | null = null;

  constructor(private downloads: string) {
    electronSession.fromPartition(FALLBACK_PARTITION).on("will-download", (_e, item) => {
      const dest = path.join(this.downloads, item.getFilename());
      item.setSavePath(dest);
      item.once("done", (_ev, state) => { this.dl?.(state === "completed" ? { path: dest } : null); });
    });
  }

  async newWindow(o: { init: string }): Promise<Tab> {
    const win = new BrowserWindow({ width: 1280, height: 860, title: "Browser", webPreferences: { partition: FALLBACK_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.wins.add(win);
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void wc.loadURL(url); return { action: "deny" }; });
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    const tab = await CdpTab.create(`el${win.id}`, channel(wc), {
      init: o.init,
      close: async () => { if (!win.isDestroyed()) win.close(); },
      front: async () => { if (!win.isDestroyed()) { win.show(); win.focus(); } },
    });
    win.on("closed", () => { this.wins.delete(win); tab.closed(); });
    return tab;
  }

  onPopup(): void { /* single-tab windows: popups load in place (setWindowOpenHandler) */ }

  download(trigger: () => Promise<void>, timeoutMs: number): Promise<{ path: string } | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.dl = null; resolve(null); }, timeoutMs);
      this.dl = (p) => { clearTimeout(t); this.dl = null; resolve(p); };
      trigger().catch(() => { clearTimeout(t); this.dl = null; resolve(null); });
    });
  }

  alive(): boolean { return true; }
  async close(): Promise<void> { for (const w of this.wins) if (!w.isDestroyed()) w.close(); this.wins.clear(); }
}
