import { type ThemePreference } from "@synapse/shared";
import { call } from "./bridge";
import { acceptSettings, useUi } from "./store";

/** SET-02's order, shared by the Appearance picker and the palette's cycle. */
export const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"];
export const nextTheme = (p: ThemePreference): ThemePreference => THEME_ORDER[(THEME_ORDER.indexOf(p) + 1) % THEME_ORDER.length]!;

export function applyTheme(pref: ThemePreference): void {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  window.synapse.setNativeTheme(pref);
}

/** SET-02: the Appearance picker and the palette's cycle row both save through here, so a refused
 * save reaches the user the same way whichever control they used. Returns the preference that is
 * actually saved — the old one when the host would not take the new one. */
export async function setTheme(pref: ThemePreference): Promise<ThemePreference> {
  const cur = useUi.getState().settings?.themePreference ?? "system";
  try {
    const settings = await call("setHostSettings", { themePreference: pref });
    acceptSettings(settings);
    return settings.themePreference;
  } catch (e) {
    // A save the host refused must not read as a click that did nothing: show it where every other
    // action failure shows (Sidebar's role="alert" banner) and leave the applied theme on the value
    // that is actually saved.
    useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });
    return cur;
  }
}


/** PAL-04: the palette's accelerator — Follow System → Light → Dark. The picker in
 * Settings → General → Appearance is the primary control. */
export const cycleTheme = (): Promise<ThemePreference> => setTheme(nextTheme(useUi.getState().settings?.themePreference ?? "system"));

/** Applies the saved theme now and whenever settings change (including host-settings SSE). */
export function startThemeSync(): () => void {
  let last: ThemePreference | null = null;
  const apply = (p: ThemePreference | undefined) => {
    if (!p || p === last) return;
    last = p;
    applyTheme(p);
  };
  apply(useUi.getState().settings?.themePreference);
  return useUi.subscribe((s) => apply(s.settings?.themePreference));
}
