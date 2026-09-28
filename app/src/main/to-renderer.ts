import type { BrowserWindow, MessagePortMain } from "electron";

/**
 * The one way the main process talks to the renderer.
 *
 * `win.isDestroyed()` is a PROXY for "this can receive a message", not the property. A BrowserWindow
 * stays alive while its render frame is gone — during a reload, a navigation, or a renderer crash —
 * and in all three `isDestroyed()` is false. `webContents.send` only warns when it posts into that
 * gap; `postMessage` with transferables THROWS:
 *
 *   Error: Render frame was disposed before WebFrameMain could be accessed
 *
 * which is what the user saw as an Electron fatal dialog at 06:57. The coordinator died, supervision
 * re-forked it 500ms later, and `onRespawn` wired a MessagePort into a frame that no longer existed.
 * It threw inside a timer callback in the main process, where nothing was catching it, so it took
 * the whole app to the uncaught-exception dialog rather than dropping one message.
 *
 * Reaching for `mainFrame` is what throws, so the check has to be made inside the try — asking the
 * question IS the dangerous operation. `to-renderer.test.ts` refuses any raw `webContents.send` or
 * `postMessage` elsewhere in `src/main`, so the safe path is the one you get by forgetting.
 */
type Reachable = Pick<BrowserWindow, "isDestroyed" | "webContents"> | null | undefined;

export function canReachRenderer(win: Reachable): boolean {
  // Total by construction: this predicate must never throw, or the guard becomes the crash it
  // exists to prevent. Optional calls rather than direct ones — a partial window (a test double, a
  // future Electron shape) answers "not destroyed" instead of raising a TypeError from inside the
  // check itself, which is exactly how the first draft took down seven suites.
  if (!win || win.isDestroyed?.()) return false;
  const wc = win.webContents as BrowserWindow["webContents"] | undefined;
  if (!wc || wc.isDestroyed?.()) return false;
  try {
    // Reaching for `mainFrame` IS the dangerous operation — on a disposed frame the getter throws
    // rather than returning null. So a THROW is the signal, and an absent value is not: treating
    // `undefined` as unreachable was this guard's first draft and it silently dropped seven suites'
    // worth of real messages whose windows simply had no frame object to expose. Be strict about
    // the failure that actually happens and permissive about everything else.
    void wc.mainFrame;
    return true;
  } catch {
    return false;
  }
}

/** `webContents.send`, dropped silently when the frame cannot receive it. */
export function sendToRenderer(win: Reachable, channel: string, ...args: unknown[]): void {
  if (!canReachRenderer(win)) return;
  win!.webContents.send(channel, ...args);
}

/**
 * `webContents.postMessage`, dropped silently when the frame cannot receive it.
 *
 * Dropping is correct here rather than retrying: every caller re-posts on the next
 * `did-finish-load`, so a message aimed at a frame that is being replaced is already going to be
 * sent again to the frame that replaces it.
 */
export function postToRenderer(win: Reachable, channel: string, message: unknown, transfer: MessagePortMain[] = []): void {
  if (!canReachRenderer(win)) return;
  win!.webContents.postMessage(channel, message, transfer);
}
