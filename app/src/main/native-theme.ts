import fs from "node:fs";
import { nativeTheme } from "electron";

type Pref = "system" | "light" | "dark";
const norm = (p: unknown): Pref => (p === "light" || p === "dark" ? p : "system");

export function applyNativeTheme(pref: string, nt: { themeSource: string } = nativeTheme): void {
  nt.themeSource = norm(pref);
}

/**
 * New-user walk, finding 4: the theme lives in the host's settings, which the app only reads after it
 * connects, so every cold start painted in the system theme and then flipped. The last preference the
 * renderer applied is kept on this Mac too, and applied before the window exists.
 */
export function readCachedTheme(file: string): Pref {
  try { return norm((JSON.parse(fs.readFileSync(file, "utf8")) as { theme?: unknown }).theme); } catch { return "system"; }
}

export function cacheTheme(file: string, pref: string): void {
  try { fs.writeFileSync(file, JSON.stringify({ theme: norm(pref) }), { mode: 0o600 }); } catch { /* next launch starts in the system theme */ }
}

/** The window's own colour (tokens.css --bg), shown before the page's first paint. */
export const windowBackground = (dark: boolean): string => (dark ? "#0C0C0C" : "#FFFFFF");
