import { clipboard, ShareMenu, type BrowserWindow } from "electron";
import { decodeShare, fragmentOf, SHARE_SITE } from "@synapse/shared";
import { registerNative } from "../native";

/** Only a Bot share link on the Synapse site is handed to the share menu. */
export function isShareLink(url: unknown): url is string {
  return typeof url === "string" && url.length <= 20_000 && url.startsWith(`${SHARE_SITE}/bot#b`) && !/\s/.test(url);
}

/**
 * Bot sharing: the Share sheet's "Share…" is the Mac's own share menu (Messages, Mail, AirDrop…), for the link.
 * FUZZ: never shown; the calls are recorded on globalThis.__shareMenuCalls for the e2e run.
 */
export function registerShareMenu(win: () => BrowserWindow | null, o: { fuzz: boolean }): void {
  registerNative("shareMenu", (a: { url?: unknown; title?: unknown }) => {
    if (!isShareLink(a?.url)) throw new Error("Not a Bot link.");
    if (o.fuzz) {
      const g = globalThis as unknown as { __shareMenuCalls?: { url: string }[] };
      (g.__shareMenuCalls ??= []).push({ url: a.url });
      return {};
    }
    const w = win();
    new ShareMenu({ urls: [a.url] }).popup(w ? { window: w } : {});
    return {};
  });
}

/**
 * Bot sharing: onboarding's "Paste a Bot link". Called only on that click; returns the Bot link's fragment and
 * nothing else, so whatever else is on the clipboard never reaches the window.
 */
export function registerClipboardBotLink(read: () => string | Promise<string> = () => clipboard.readText()): void {
  registerNative("clipboard.botLink", async () => {
    const text = String((await read()) ?? "").trim();
    const fragment = text.length <= 30_000 ? fragmentOf(text) : null;
    // Only a link that decodes to a valid Bot is handed over (security review): nothing else leaves the clipboard.
    return { fragment: fragment && (await decodeShare(fragment)).ok ? fragment : null };
  });
}
