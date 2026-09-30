import { shell, type WebContents } from "electron";
import { registerNative } from "../native";

export function isAllowedExternal(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The one guarded path to the user's browser: https only; FUZZ/E2E never opens a real browser. */
export async function openExternalGuarded(url: string): Promise<{ opened?: false }> {
  if (!isAllowedExternal(url)) throw new Error("Only https links can be opened.");
  if (process.env.FUZZ === "1") {
    // FUZZ/E2E never opens a real browser. For the fake OAuth page it completes the loopback itself, as a browser would.
    const u = new URL(url);
    if (u.hostname === "example.com" && u.pathname === "/authorize") {
      // The redirect the sign-in asked for: 47823, or the fallback port this app bound when another app holds it.
      const r = u.searchParams.get("redirect_uri") ?? "";
      const base = /^http:\/\/127\.0\.0\.1:\d+\/mcp\/oauth\/callback$/.test(r) ? r : "http://127.0.0.1:47823/mcp/oauth/callback";
      await fetch(`${base}?code=fuzz&state=${encodeURIComponent(u.searchParams.get("state") ?? "")}`).catch(() => {});
    }
    return { opened: false };
  }
  await shell.openExternal(url);
  return {};
}

const samePage = (url: string, appUrl: string): boolean => {
  try {
    const a = new URL(url);
    const b = new URL(appUrl);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
};

/**
 * Added 11:10: no window.open / target=_blank opens a window, and the main window never navigates away from
 * the app's own page. Such links go through the same guarded openExternal path (https only, FUZZ no-op).
 */
export function guardNavigation(wc: Pick<WebContents, "setWindowOpenHandler" | "on">, appUrl: string): void {
  const route = (url: string) => { if (isAllowedExternal(url)) void openExternalGuarded(url).catch(() => {}); };
  wc.setWindowOpenHandler(({ url }) => { route(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => {
    if (samePage(url, appUrl)) return;
    e.preventDefault();
    route(url);
  });
}

export function registerExternal(): void {
  registerNative("openExternal", async (a: { url: string }) => openExternalGuarded(a.url));
}
