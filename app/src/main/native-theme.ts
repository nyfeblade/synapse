import { nativeTheme } from "electron";

export function applyNativeTheme(pref: string, nt: { themeSource: string } = nativeTheme): void {
  nt.themeSource = pref === "light" || pref === "dark" ? pref : "system";
}
