import { app, Notification, type BrowserWindow } from "electron";
import { registerNative } from "../native";
import { sendToRenderer } from "../to-renderer";
import { focusActive, ringPolicy, validQuietHours, type QuietHours } from "./bot-calls";

/** A Bot's call on the Mac: may it ring (quiet hours, Focus), the quiet-hours setting, and the system notification. */
export function registerBotCalls(o: { win(): BrowserWindow | null; home: string; readQuiet(): QuietHours | null; writeQuiet(q: QuietHours | null): QuietHours | null; onRing?(botId: string, title: string, body: string): void }): void {
  registerNative("calls.policy", () => ringPolicy({ quiet: o.readQuiet(), focus: focusActive(o.home), now: new Date() }));
  registerNative("calls.quiet.get", () => ({ quietHours: o.readQuiet() }));
  registerNative("calls.quiet.set", (a: { quietHours?: unknown }) => {
    if (a?.quietHours !== null && !validQuietHours(a?.quietHours)) throw new Error("Quiet hours must be two times like 22:00.");
    return { quietHours: o.writeQuiet(a.quietHours as QuietHours | null) };
  });
  // The in-app ring shows whatever the window's state; outside the app, a notification and a Dock bounce.
  registerNative("calls.ring", (a: { botId?: unknown; title?: unknown; body?: unknown }) => {
    const win = o.win();
    if (typeof a?.botId !== "string" || typeof a.title !== "string" || typeof a.body !== "string") throw new Error("Bad ring.");
    if (win && !win.isDestroyed() && win.isFocused()) return { shown: false };
    // Bug 198: away from the Mac, a paired phone rings too (Web Push; Phone access only).
    o.onRing?.(a.botId, a.title, a.body);
    const id = app.dock?.bounce("critical");
    if (Notification.isSupported()) {
      const n = new Notification({ title: a.title.slice(0, 80), body: a.body.slice(0, 200), silent: true });
      n.on("click", () => {
        if (id !== undefined) app.dock?.cancelBounce(id);
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        sendToRenderer(win, "open-bot", a.botId);
      });
      n.show();
    }
    return { shown: true };
  });
}
