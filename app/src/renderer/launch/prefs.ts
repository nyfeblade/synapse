/**
 * The launch snap's two switches (Settings → General → Appearance) and its once-per-launch latch.
 * They are this Mac's display preferences, so they live in the renderer's own storage; storage that
 * can't be read (a locked-down profile) falls back to the defaults, both on.
 */
const KEY = { animation: "synapse.launchAnimation", sound: "synapse.launchSound" } as const;
const PLAYED = "synapse.launchPlayed";

export type LaunchPref = keyof typeof KEY;

export function launchPrefs(): Record<LaunchPref, boolean> {
  const read = (k: LaunchPref) => { try { return localStorage.getItem(KEY[k]) !== "off"; } catch { return true; } };
  return { animation: read("animation"), sound: read("sound") };
}

export function setLaunchPref(k: LaunchPref, on: boolean): void {
  try { localStorage.setItem(KEY[k], on ? "on" : "off"); } catch { /* a preference that can't be kept stays at its default */ }
}

/**
 * True once per launch, and only when the animation is on. sessionStorage lives as long as this
 * window, so a renderer reload doesn't replay the snap but the next launch of the app does.
 */
export function claimLaunch(): boolean {
  if (!launchPrefs().animation) return false;
  try {
    if (sessionStorage.getItem(PLAYED)) return false;
    sessionStorage.setItem(PLAYED, "1");
  } catch { /* no session storage: play it, at worst once per reload */ }
  return true;
}
