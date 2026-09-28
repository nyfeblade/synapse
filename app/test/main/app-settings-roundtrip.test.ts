import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAppSettings, writeAppSettings, type AppSettings } from "../../src/main/app-settings";

/**
 * settings-persist: every Settings control this Mac keeps in app-settings.json, set to its NON-default value,
 * survives a relaunch (a fresh read of the profile) — and survives every other control being saved after it,
 * so no save re-applies another control's default. The per-Bot ability switches are kept by the coordinator
 * instead (app/test/coordinator/ability-persist.test.ts); host-kept controls: host/test/store/settings-roundtrip.test.ts.
 */
const ROWS: { control: string; patch: Partial<AppSettings> }[] = [
  { control: "Keep Bots running when the app quits", patch: { keepBoxOnQuit: false } },
  { control: "Automatic updates", patch: { autoUpdate: true } },
  { control: "Microphone", patch: { audioInput: "USB-MIC-UID" } },
  { control: "Speaker", patch: { audioOutput: "HEADSET-UID" } },
  { control: "Call voice", patch: { ttsVoice: "qwen3:vivian" } },
  { control: "Voice mode", patch: { voiceMode: "light" } },
  { control: "Hey <Bot name>", patch: { wakeWord: true } },
  { control: "Pause on battery", patch: { wakePauseOnBattery: false } },
  { control: "Quiet hours (off)", patch: { quietHours: null } },
  { control: "Quiet hours (window)", patch: { quietHours: { start: "23:00", end: "07:00" } } },
  { control: "Call shortcut", patch: { callShortcut: "Alt+CommandOrControl+K" } },
  { control: "Call sounds", patch: { callSounds: false } },
  { control: "Keep voice ready", patch: { keepVoiceReady: false } },
  { control: "Whisper in calls", patch: { whisperInCalls: true } },
  { control: "Daily backups", patch: { backupAuto: false } },
  { control: "Backups to keep", patch: { backupKeep: 14 } },
];

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-settings-rt-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("every Mac-kept Settings control round-trips through save → relaunch", () => {
  it.each(ROWS)("$control", ({ patch }) => {
    writeAppSettings(dir, patch);
    const [k, v] = Object.entries(patch)[0]!;
    expect((readAppSettings(dir, dir) as unknown as Record<string, unknown>)[k]).toEqual(v);
    // Saving every OTHER control afterwards (each at its own non-default) leaves this one alone.
    for (const other of ROWS.filter((r) => Object.keys(r.patch)[0] !== k)) writeAppSettings(dir, other.patch);
    expect((readAppSettings(dir, dir) as unknown as Record<string, unknown>)[k]).toEqual(v);
  });
});
