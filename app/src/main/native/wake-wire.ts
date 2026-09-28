import { app, powerMonitor, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { emitNative, registerNative } from "../native";
import type { AudioDevice, AudioPrefs } from "./audio-devices";
import { createWakeTray } from "./wake-tray";
import { WakeWord, type WakeSettings } from "./wake-word";

/** After dictation or a call lets the microphone go, listening resumes this much later (a call's helper can restart in between). */
export const BUSY_RELEASE_MS = 2_000;

/** Wake word: the controller, the Mac's signals (lock, sleep, battery), the menu-bar item and the renderer's calls. */
export function registerWakeWord(o: {
  binary: string;
  log(line: string): void;
  win(): BrowserWindow | null;
  settings(): WakeSettings;
  saveSettings(p: Partial<WakeSettings>): WakeSettings;
  devices(): AudioPrefs;
  listDevices(): Promise<AudioDevice[] | null>;
  tray: boolean;
  /** Bug 134: the menu-bar item's "Call…" submenu. */
  callItems?(): MenuItemConstructorOptions[];
}): { setActive(active: boolean): void; devicesChanged(): void; refreshMenu(): void; dispose(): void } {
  const tray = o.tray ? createWakeTray({
    pause: (on) => wake.pause("user", on),
    turnOff: () => wake.set({ enabled: false }),
    openSettings: () => { focus(); emitNative("open-settings", { section: "voice" }); },
    callItems: o.callItems,
  }) : null;
  const focus = () => {
    const w = o.win();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    app.focus({ steal: true });
  };
  const wake: WakeWord = new WakeWord({
    binary: o.binary, log: o.log, settings: o.settings, saveSettings: o.saveSettings, devices: o.devices, listDevices: o.listDevices,
    onWake: (e) => { focus(); emitNative("wake", { type: "wake", name: e.name, confidence: e.confidence, ...(e.also?.length ? { also: e.also } : {}) }); },
    onState: (s) => { tray?.update(s); emitNative("wake", { type: "state", state: s }); },
  });

  registerNative("wake.get", () => wake.state());
  registerNative("wake.set", (a: { enabled?: unknown; pauseOnBattery?: unknown }) => {
    const p: Partial<WakeSettings> = {};
    if (a?.enabled !== undefined) { if (typeof a.enabled !== "boolean") throw new Error("Bad wake setting."); p.enabled = a.enabled; }
    if (a?.pauseOnBattery !== undefined) { if (typeof a.pauseOnBattery !== "boolean") throw new Error("Bad wake setting."); p.pauseOnBattery = a.pauseOnBattery; }
    return wake.set(p);
  });
  registerNative("wake.names", (a: { names?: unknown }) => { wake.setNames(a?.names); return {}; });
  registerNative("wake.pause", (a: { paused?: unknown }) => { wake.pause("user", a?.paused === true); return wake.state(); });

  powerMonitor.on("lock-screen", () => wake.pause("locked", true));
  powerMonitor.on("unlock-screen", () => wake.pause("locked", false));
  powerMonitor.on("suspend", () => wake.pause("asleep", true));
  powerMonitor.on("resume", () => wake.pause("asleep", false));
  powerMonitor.on("on-battery", () => wake.setOnBattery(true));
  powerMonitor.on("on-ac", () => wake.setOnBattery(false));
  wake.setOnBattery(powerMonitor.isOnBatteryPower());

  let release: NodeJS.Timeout | null = null;
  return {
    setActive(active) {
      if (release) { clearTimeout(release); release = null; }
      if (active) { wake.pause("busy", true); wake.pause("waking", false); return; }
      release = setTimeout(() => { release = null; wake.pause("busy", false); }, BUSY_RELEASE_MS);
      release.unref?.();
    },
    devicesChanged: () => wake.devicesChanged(),
    refreshMenu: () => tray?.refresh(),
    dispose() { wake.dispose(); tray?.dispose(); },
  };
}
