import type { AppSettings } from "../app-settings";
import { DEFAULT_QUIET_HOURS, type QuietHours } from "./bot-calls";

type Reg = (name: string, fn: (a: any) => unknown) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * settings-persist: the Settings switches this Mac keeps in app-settings.json, as one table of native handler
 * name → app-settings key → default. They used to be written inline in main/index.ts, where nothing could check
 * that the name the renderer calls and the key the next launch reads are the same pair; the round trip through
 * these handlers is pinned in app/test/main/settings-natives.test.ts.
 */
export const APP_SETTING_SWITCHES = [
  { get: "keepBoxOnQuit.get", set: "keepBoxOnQuit.set", key: "keepBoxOnQuit", dflt: true },
  { get: "kokoro.keepReady.get", set: "kokoro.keepReady.set", key: "keepVoiceReady", dflt: true },
  { get: "calls.sounds.get", set: "calls.sounds.set", key: "callSounds", dflt: true },
  { get: "whisper.inCalls.get", set: "whisper.inCalls.set", key: "whisperInCalls", dflt: false },
] as const satisfies readonly { get: string; set: string; key: keyof AppSettings; dflt: boolean }[];

export type SwitchKey = (typeof APP_SETTING_SWITCHES)[number]["key"];

export interface SettingsStore { read(): AppSettings; write(patch: Partial<AppSettings>): AppSettings }

/** The saved value of one switch, or its default when it was never set. */
export function switchValue(s: AppSettings, key: SwitchKey): boolean {
  const row = APP_SETTING_SWITCHES.find((r) => r.key === key)!;
  const v = s[key];
  return typeof v === "boolean" ? v : row.dflt;
}

export function registerSettingsNatives(reg: Reg, store: SettingsStore, hooks: { changed?(key: SwitchKey): void } = {}): void {
  for (const row of APP_SETTING_SWITCHES) {
    reg(row.get, () => ({ on: switchValue(store.read(), row.key) }));
    reg(row.set, (a: { on?: unknown }) => {
      if (typeof a?.on !== "boolean") throw new Error("Bad setting.");
      const on = switchValue(store.write({ [row.key]: a.on }), row.key);
      hooks.changed?.(row.key);
      return { on };
    });
  }
}

/** Quiet hours (Settings → Voice → Calls from Bots): unset = 22:00–08:00, null = off. */
export function quietHoursStore(store: SettingsStore): { readQuiet(): QuietHours | null; writeQuiet(q: QuietHours | null): QuietHours | null } {
  const of = (s: AppSettings) => (s.quietHours === undefined ? DEFAULT_QUIET_HOURS : s.quietHours);
  return { readQuiet: () => of(store.read()), writeQuiet: (q) => of(store.write({ quietHours: q })) };
}

/** "Hey <Bot name>" (off by default) and pause on battery (on by default). */
export function wakeSettingsStore(store: SettingsStore): { settings(): { enabled: boolean; pauseOnBattery: boolean }; saveSettings(p: { enabled?: boolean; pauseOnBattery?: boolean }): { enabled: boolean; pauseOnBattery: boolean } } {
  const of = (s: AppSettings) => ({ enabled: s.wakeWord === true, pauseOnBattery: s.wakePauseOnBattery !== false });
  return {
    settings: () => of(store.read()),
    saveSettings: (p) => of(store.write({ ...(p.enabled !== undefined ? { wakeWord: p.enabled } : {}), ...(p.pauseOnBattery !== undefined ? { wakePauseOnBattery: p.pauseOnBattery } : {}) })),
  };
}
