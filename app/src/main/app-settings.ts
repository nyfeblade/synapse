import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file";
import { defaultBoxDir, type AppRuntime } from "./box-lifecycle";
import type { GatewayRoute } from "./box-provider";

export interface AppSettings { gatewayRoute: GatewayRoute; gatewayHost: string; theme: "system" | "light" | "dark"; updateFeed?: string | null; autoUpdate?: boolean; keepBoxOnQuit?: boolean; /** Bug 105: chosen device UIDs; null = system default. */ audioInput?: string | null; audioOutput?: string | null; /** Bug 106: the voice-call voice (identifier, or "kokoro:<id>" — bug 107); null = automatic. */ ttsVoice?: string | null; /** Bug 107: where Kokoro's Python and model are; unset = auto-detected. */ kokoroPython?: string | null; kokoroModelDir?: string | null; /** Cloned voices (F5): the Python with f5-tts-mlx; unset = auto-detected. */ f5Python?: string | null; /** Settings → Backups (daily on by default, keep 7). */ backupAuto?: boolean; backupKeep?: number; backupDir?: string | null; /** Settings → Updates: the local release folder. */ updateFolder?: string | null; /** Settings → Voice: "Hey <Bot name>" (off by default) and whether it pauses on battery (default yes). */ wakeWord?: boolean; wakePauseOnBattery?: boolean; /** A Bot's call doesn't ring in this window; unset = 22:00–08:00, null = off. */ quietHours?: { start: string; end: string } | null; /** Bug 134: the global call shortcut; unset = ⌥⌘C, null = off. */ callShortcut?: string | null; /** Bug 134: join / leave sounds on a call (default on). */ callSounds?: boolean; /** Bug 134: keep the natural voice (Kokoro) loaded while the app runs (default on; ~800 MB). */ keepVoiceReady?: boolean; /** Bug 164: Settings → Voice, Light or Full. Unset = decided by the Mac's memory (shared/voice-mode defaultVoiceMode); once set it is the user's and sticks. */ voiceMode?: "light" | "full"; /** Bug 164: where Qwen3's Python and model are; unset = auto-detected. */ qwenPython?: string | null; qwenModelDir?: string | null; /** Bug 165: in Full mode, whether whisper also re-transcribes CALL turns (default off — it costs a call its speculative early start; see the bug log). */ whisperInCalls?: boolean; /** Portable install: the settings migration has run (portable-migration.ts); the version it ran. */ portableMigrated?: number; /** Portable install: the first-run setup finished (or an existing box was found set up). */ setupDone?: boolean; /** Portable install: the OrbStack machine this profile uses ("box" on a Mac that already had one, else "synapse-box"). */ boxMachine?: string; /** Portable install: "Not now" to moving Synapse into /Applications (install-location.ts). */ moveDeclined?: boolean }
const DEFAULTS: AppSettings = { gatewayRoute: "localhost", gatewayHost: "127.0.0.1", theme: "system", updateFeed: null, autoUpdate: false, keepBoxOnQuit: true };

/** app-settings.json in the profile, falling back to box/route.env (spike-p0.sh): the bundle's copy when packaged, the repo's in development. */
export function readAppSettings(userData: string, appDir: string, rt?: AppRuntime): AppSettings {
  const out: AppSettings = { ...DEFAULTS };
  const routeEnv = path.join(defaultBoxDir(path.resolve(appDir), rt), "route.env");
  if (fs.existsSync(routeEnv)) {
    const kv = Object.fromEntries(fs.readFileSync(routeEnv, "utf8").split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string]));
    if (kv.GATEWAY_ROUTE) out.gatewayRoute = kv.GATEWAY_ROUTE as GatewayRoute;
    if (kv.GATEWAY_HOST) out.gatewayHost = kv.GATEWAY_HOST;
  }
  try {
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(userData, "app-settings.json"), "utf8")));
  } catch {
    /* no file yet */
  }
  return out;
}

/** Merges `patch` into app-settings.json through the Mac side's one durable-write helper (tmp file,
 * fsync, rename — see ./atomic-file), so a crash right after a settings write can't leave the file
 * missing or truncated. */
export function writeAppSettings(userData: string, patch: Partial<AppSettings>): AppSettings {
  const file = path.join(userData, "app-settings.json");
  let current: Partial<AppSettings> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* no file yet */
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(userData, { recursive: true });
  writeFileAtomic(file, JSON.stringify(next, null, 2), 0o600);
  return { ...DEFAULTS, ...next };
}
