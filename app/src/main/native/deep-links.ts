import type { App, BrowserWindow } from "electron";
import { APP_SCHEMES } from "@synapse/shared";
import { emitNative } from "../native";

export { APP_SCHEMES };

/** Links closer together than this are one click (and one bring-forward). */
const FLOOD_MS = 1000;

/** Bot sharing: whether an import sheet is on screen (the renderer says so); a link then never steals focus again. */
let importSheetOpen = false;
export function setImportSheetOpen(open: boolean): void { importSheetOpen = open === true; }

/**
 * Bug 286: synapse://, and bots:// (the old name) as an alias for one release.
 *
 * Bot sharing: a link brings the window forward (restored, shown and focused, stealing focus from the browser the
 * link was clicked in). Before the window is ready only ONE link waits (the newest). Security review: a link that
 * arrives within 1 s of the last one taken is dropped, so a flood (a page firing links, twenty fast clicks) is one
 * link and one bring-forward; the renderer also keeps one preview in flight.
 */
export function registerDeepLinks(app: App, ready: () => boolean, win: () => BrowserWindow | null = () => null): void {
  for (const scheme of APP_SCHEMES) app.setAsDefaultProtocolClient(scheme);
  let pending: string | null = null;
  const emit = (url: string) => emitNative("deep-link", { url });
  const bringForward = () => {
    try {
      const w = win();
      if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); }
      app.focus?.({ steal: true });
    } catch { /* a window mid-close: the link is still delivered */ }
  };
  let flush: ReturnType<typeof setInterval> | null = null;
  const waitForWindow = () => {
    if (flush) return;
    flush = setInterval(() => {
      if (!ready()) return;
      if (pending) { const u = pending; pending = null; emit(u); }
      clearInterval(flush!);
      flush = null;
    }, 250);
  };
  let lastAt = -Infinity;
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (!APP_SCHEMES.some((s) => url.startsWith(`${s}://`))) return;
    // Every attempt restarts the window (re-review): a steady stream a little under 1 s apart is one link, not many.
    const now = Date.now();
    const flood = now - lastAt < FLOOD_MS;
    lastAt = now;
    if (flood) return;
    if (!importSheetOpen) bringForward();
    if (ready()) emit(url);
    else { pending = url; waitForWindow(); }
  });
}
