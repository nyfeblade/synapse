import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAppSettings, writeAppSettings } from "../../src/main/app-settings";
import { APP_SETTING_SWITCHES, quietHoursStore, registerSettingsNatives, wakeSettingsStore } from "../../src/main/native/settings-natives";

/**
 * settings-persist (review g): the native handler NAME the renderer calls → the key written to app-settings.json →
 * the value a relaunch reads back, through the real handlers, re-registered over the same profile the way the
 * next launch registers them.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, "../../src/renderer");
const rendererSource = ["voice/CallFeelCard.tsx", "voice/WhisperCard.tsx", "components/settings/ComputerSection.tsx"].map((f) => fs.readFileSync(path.join(renderer, f), "utf8")).join("\n");

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-natives-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const store = () => ({ read: () => readAppSettings(dir, dir), write: (p: Parameters<typeof writeAppSettings>[1]) => writeAppSettings(dir, p) });
const launch = () => {
  const handlers = new Map<string, (a: unknown) => unknown>();
  const changed: string[] = [];
  registerSettingsNatives((n, fn) => handlers.set(n, fn), store(), { changed: (k) => changed.push(k) });
  return { call: (n: string, a: unknown = {}) => handlers.get(n)!(a) as { on: boolean }, changed };
};

describe.each(APP_SETTING_SWITCHES)("$set → app-settings.json:$key → $get after a relaunch", ({ get, set, key, dflt }) => {
  it("round-trips the non-default value, and the renderer calls this exact name", () => {
    expect(rendererSource).toContain(`"${set}"`);
    const first = launch();
    expect(first.call(get)).toEqual({ on: dflt });
    expect(first.call(set, { on: !dflt })).toEqual({ on: !dflt });
    expect(first.changed).toEqual([key]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "app-settings.json"), "utf8"))[key]).toBe(!dflt);
    expect(launch().call(get)).toEqual({ on: !dflt });
  });

  it("refuses a non-boolean without writing", () => {
    expect(() => launch().call(set, { on: "yes" })).toThrow();
    expect(fs.existsSync(path.join(dir, "app-settings.json"))).toBe(false);
  });
});

describe("quiet hours and the wake word keep what was saved across a relaunch", () => {
  it("quiet hours: off (null) and a window both come back", () => {
    expect(quietHoursStore(store()).writeQuiet(null)).toBeNull();
    expect(quietHoursStore(store()).readQuiet()).toBeNull();
    quietHoursStore(store()).writeQuiet({ start: "23:00", end: "07:00" });
    expect(quietHoursStore(store()).readQuiet()).toEqual({ start: "23:00", end: "07:00" });
  });

  it("wake word on and pause-on-battery off come back", () => {
    wakeSettingsStore(store()).saveSettings({ enabled: true });
    wakeSettingsStore(store()).saveSettings({ pauseOnBattery: false });
    expect(wakeSettingsStore(store()).settings()).toEqual({ enabled: true, pauseOnBattery: false });
  });
});
