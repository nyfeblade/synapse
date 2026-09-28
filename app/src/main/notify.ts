import { app, Notification, type BrowserWindow } from "electron";
import { sendToRenderer } from "./to-renderer";

/** NTF-02: a click focuses the app and opens the Bot. NTF-04: no sounds. */
export function showBotNotification(win: BrowserWindow, n: { botId: string; title: string; body: string }): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: true });
  note.on("click", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendToRenderer(win, "open-bot", n.botId);
  });
  note.show();
}

/** An app-level notice (bug-log 128: the Mac is almost out of space). A click brings the window forward. No sound. */
export function showAppNotification(win: BrowserWindow, n: { title: string; body: string }): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: true });
  note.on("click", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  note.show();
}

export function setDockBadge(count: number, dock: { setBadge(s: string): void } | undefined = app.dock): void {
  dock?.setBadge(count > 0 ? String(count) : "");
}
