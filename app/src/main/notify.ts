import { app, Notification, type BrowserWindow } from "electron";
import { STR } from "@synapse/shared";
import { sendToRenderer } from "./to-renderer";

/**
 * NTF-02: a click focuses the app and opens the Bot. NTF-04: no sounds. Smarter approvals: a card's notification
 * (approvalId) also has Approve and Deny, answered through `answer` (the coordinator's gateway call, the same path
 * as the in-app card).
 */
export function showBotNotification(
  win: BrowserWindow,
  n: { botId: string; title: string; body: string; approvalId?: string },
  answer?: (a: { botId: string; approvalId: string; choice: "once" | "deny" }) => void,
): void {
  if (!Notification.isSupported()) return;
  const card = n.approvalId && answer ? n.approvalId : null;
  const note = new Notification({
    title: n.title, body: n.body, silent: true,
    ...(card ? { actions: [{ type: "button" as const, text: STR.approve }, { type: "button" as const, text: STR.deny }] } : {}),
  });
  note.on("click", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendToRenderer(win, "open-bot", n.botId);
  });
  if (card) note.on("action", (_e: unknown, index: number) => answer!({ botId: n.botId, approvalId: card, choice: index === 0 ? "once" : "deny" }));
  note.show();
}

/** An app-level notice (bug-log 128: the Mac is almost out of space). A click brings the window forward (and runs
 *  `onClick`, e.g. 4.4's "open Settings → Connections"). No sound. */
export function showAppNotification(win: BrowserWindow, n: { title: string; body: string }, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: true });
  note.on("click", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    onClick?.();
  });
  note.show();
}

export function setDockBadge(count: number, dock: { setBadge(s: string): void } | undefined = app.dock): void {
  dock?.setBadge(count > 0 ? String(count) : "");
}
