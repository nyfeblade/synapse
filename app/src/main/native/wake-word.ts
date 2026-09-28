import { spawn, type ChildProcess } from "node:child_process";
import { STR5 } from "@synapse/shared";
import { deviceArgs, type AudioDevice, type AudioPrefs } from "./audio-devices";

/**
 * Wake word ("Hey <Bot name>", Settings → Voice; off by default). The helper's `--mode wake` listens
 * on-device and reports only a detection. This controller decides WHEN it may listen: never while
 * the screen is locked or the Mac sleeps, during dictation or a call (they own the microphone), with
 * no Bot names, on a Bluetooth headset microphone (opening it drops the headset to call quality for
 * as long as it stays open), on battery when the user asked for that, or while the user paused it
 * from the menu bar. Every change of state is reported, so the menu-bar item and Settings are honest.
 */
export type WakePause = "off" | "user" | "locked" | "asleep" | "busy" | "waking" | "battery" | "bluetooth" | "no-names" | "error";
export interface WakeSettings { enabled: boolean; pauseOnBattery: boolean }
export interface WakeState {
  enabled: boolean;
  pauseOnBattery: boolean;
  /** The helper is up and listening for the names right now (the microphone is open). */
  listening: boolean;
  /** Why it isn't listening (empty while listening). The first is the one to show. */
  pausedFor: WakePause[];
  error: string | null;
  /** The Privacy & Security pane that fixes `error` (a permission fault), else null. */
  errorPane: WakePane | null;
  names: number;
}
export type WakePane = "microphone" | "speech";
const PERMISSION_TEXT: Record<string, string> = {
  "microphone:denied": STR5.micAccessDenied,
  "microphone:restricted": STR5.micAccessRestricted,
  "speech:denied": STR5.speechAccessDenied,
  "speech:restricted": STR5.speechAccessRestricted,
};

/**
 * A failure that stops the wake word for good, in plain words. The helper reports a permission fault
 * as `permission:<microphone|speech>:<denied|restricted>` (an older one as `not-authorized`): that
 * code is never shown — the user gets what's off and which pane turns it back on.
 */
export function wakeFault(code: string, message: string): { text: string; pane: WakePane | null } {
  const m = /^permission:(microphone|speech):(denied|restricted)$/.exec(message.trim());
  if (m) return { text: PERMISSION_TEXT[`${m[1]}:${m[2]}`]!, pane: m[1] as WakePane };
  if (code === "permission") return { text: STR5.micDenied, pane: /speech|not.authorized/i.test(message) ? "speech" : "microphone" };
  return { text: message, pane: null };
}
/** Bug 213: `also` — "Hey Nova and Scout": the other names heard, for one group call. */
export type WakeEvent = { type: "wake"; name: string; confidence: number; ms: number; also?: string[] } | { type: "wake-rejected"; name: string; confidence: number };

const RESTART_DELAYS_MS = [2_000, 10_000, 30_000];
/** After a wake the microphone is left to the call; listening resumes if no call took it by then. */
export const WAKE_HANDOFF_MS = 10_000;
/** A Bluetooth microphone is re-checked this often while it is the reason for the pause. */
export const BLUETOOTH_RECHECK_MS = 60_000;
const ORDER: WakePause[] = ["off", "error", "user", "locked", "asleep", "busy", "waking", "battery", "bluetooth", "no-names"];

export function parseWakeLine(line: string): WakeEvent | { type: "error"; code: string; message: string } | { type: "ready" } | null {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    const conf = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? Math.round(e.confidence * 100) / 100 : 0;
    if ((e.type === "wake" || e.type === "wake-rejected") && typeof e.name === "string" && e.name.length <= 40) {
      if (e.type === "wake-rejected") return { type: "wake-rejected", name: e.name, confidence: conf };
      const also = Array.isArray(e.also) ? e.also.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40).slice(0, 5) : [];
      return { type: "wake", name: e.name, confidence: conf, ms: typeof e.ms === "number" ? Math.round(e.ms) : 0, ...(also.length ? { also } : {}) };
    }
    if (e.type === "error" && typeof e.message === "string") return { type: "error", code: typeof e.code === "string" ? e.code : "", message: e.message.slice(0, 300) };
    if (e.type === "ready") return { type: "ready" };
  } catch { /* not an event */ }
  return null;
}

/** Bot names worth listening for: trimmed, 1–40 characters, with a letter or digit, unique, at most 50. */
export function cleanWakeNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of raw) {
    if (typeof n !== "string") continue;
    const t = n.replace(/[\u0000-\u001f,]/g, " ").trim();
    const key = t.toLowerCase();
    if (!t || t.length > 40 || !/[\p{L}\p{N}]/u.test(t) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/** The microphone a helper would open: the chosen one if it is connected, else the system default. */
export function activeInput(devices: AudioDevice[], prefs: AudioPrefs): AudioDevice | null {
  return devices.find((d) => d.input && d.uid === prefs.input) ?? devices.find((d) => d.input && d.defaultInput) ?? null;
}
export const isBluetooth = (d: AudioDevice | null): boolean => d?.transport === "bluetooth" || d?.transport === "bluetooth-le";

export class WakeWord {
  private child: ChildProcess | null = null;
  private names: string[] = [];
  private reasons = new Set<WakePause>();
  private error: string | null = null;
  private errorPane: WakePane | null = null;
  private failures: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private handoffTimer: NodeJS.Timeout | null = null;
  private btTimer: NodeJS.Timeout | null = null;
  private onBattery = false;
  private last = "";

  constructor(private o: {
    binary: string;
    spawnFn?: typeof spawn;
    settings(): WakeSettings;
    saveSettings(p: Partial<WakeSettings>): WakeSettings;
    devices(): AudioPrefs;
    /** The current device list (for the Bluetooth check); null when it can't be read. */
    listDevices(): Promise<AudioDevice[] | null>;
    locale?(): string | undefined;
    log(line: string): void;
    onWake(e: { name: string; confidence: number; ms: number; also?: string[] }): void;
    onState(s: WakeState): void;
    now?(): number;
  }) {}

  state(): WakeState {
    const s = this.o.settings();
    const pausedFor = this.pauses(s);
    return { enabled: s.enabled, pauseOnBattery: s.pauseOnBattery, listening: this.child !== null && pausedFor.length === 0, pausedFor, error: this.error, errorPane: this.error ? this.errorPane : null, names: this.names.length };
  }

  private pauses(s: WakeSettings): WakePause[] {
    const r = new Set(this.reasons);
    if (!s.enabled) r.add("off");
    if (this.error) r.add("error");
    if (s.pauseOnBattery && this.onBattery) r.add("battery");
    if (!this.names.length) r.add("no-names");
    return ORDER.filter((p) => r.has(p));
  }

  set(p: Partial<WakeSettings>): WakeState {
    const before = this.o.settings();
    const next = this.o.saveSettings(p);
    // Turning it on (again) is the user's way to retry after an error.
    if (next.enabled && !before.enabled) { this.error = null; this.failures = []; this.reasons.delete("bluetooth"); }
    this.reconcile();
    return this.state();
  }

  setNames(raw: unknown): void {
    const names = cleanWakeNames(raw);
    if (names.join("\n") === this.names.join("\n")) return;
    this.names = names;
    // A running helper takes the new names on stdin (no restart, no gap in listening).
    if (this.child && names.length) this.child.stdin?.write(`names ${JSON.stringify({ names })}\n`);
    this.reconcile();
  }

  /** A pause that belongs to the Mac (lock, sleep, dictation or a call, the menu-bar Pause). */
  pause(why: Exclude<WakePause, "off" | "battery" | "no-names" | "error" | "bluetooth">, on: boolean): void {
    if (on === this.reasons.has(why)) return;
    if (on) this.reasons.add(why); else this.reasons.delete(why);
    // Unlocking or waking is a fresh start for a microphone that went away (and a Bluetooth re-check).
    if (!on && (why === "locked" || why === "asleep")) { this.reasons.delete("bluetooth"); if (this.error && this.failures.length) { this.error = null; this.failures = []; } }
    this.reconcile();
  }

  setOnBattery(on: boolean): void {
    if (on === this.onBattery) return;
    this.onBattery = on;
    this.reconcile();
  }

  /** The device set changed (a headset came or went): re-check before listening again. */
  devicesChanged(): void {
    this.reasons.delete("bluetooth");
    if (this.child) { this.stopChild(); }
    this.reconcile();
  }

  dispose(): void {
    for (const t of [this.restartTimer, this.handoffTimer, this.btTimer]) if (t) clearTimeout(t);
    this.restartTimer = this.handoffTimer = this.btTimer = null;
    this.stopChild();
  }

  private checking = false;
  private reconcile(): void {
    const want = this.pauses(this.o.settings()).length === 0;
    if (!want && this.child) this.stopChild();
    if (want && !this.child && !this.restartTimer && !this.checking) this.startChecked();
    this.report();
  }

  private report(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    this.o.log(`wake: ${s.listening ? "listening" : `paused (${s.pausedFor.join(", ") || "starting"})`}${s.error ? ` error: ${s.error}` : ""}`);
    this.o.onState(s);
  }

  private startChecked(): void {
    this.checking = true;
    void this.o.listDevices().then((devs) => {
      this.checking = false;
      if (devs && isBluetooth(activeInput(devs, this.o.devices()))) {
        this.reasons.add("bluetooth");
        if (this.btTimer) clearTimeout(this.btTimer);
        this.btTimer = setTimeout(() => { this.btTimer = null; if (this.reasons.delete("bluetooth")) this.reconcile(); }, BLUETOOTH_RECHECK_MS);
        this.btTimer.unref?.();
        return this.report();
      }
      if (this.pauses(this.o.settings()).length === 0 && !this.child) this.spawnChild();
      this.report();
    }, () => { this.checking = false; if (this.pauses(this.o.settings()).length === 0 && !this.child) this.spawnChild(); this.report(); });
  }

  private spawnChild(): void {
    const locale = this.o.locale?.();
    const args = ["--mode", "wake", "--names", this.names.join(","), ...(locale ? ["--locale", locale] : []), ...deviceArgs(this.o.devices(), "dictation")];
    const c = (this.o.spawnFn ?? spawn)(this.o.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = c;
    let buf = "";
    let lastErr = "";
    let fault: { code: string; message: string } | null = null;
    c.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const e = parseWakeLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!e || this.child !== c) continue;
        if (e.type === "wake") this.fire(e);
        else if (e.type === "wake-rejected") this.o.log(`wake: rejected ${e.name} (confidence ${e.confidence})`);
        else if (e.type === "error") fault = { code: e.code, message: e.message };
      }
    });
    c.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) if (line.trim()) lastErr = line.replace(/^\[bots-dictation [^\]]*\]\s*/, "").slice(0, 300);
    });
    c.on("error", (err) => { fault = { code: "spawn", message: err.message }; });
    c.on("close", (code: number | null, signal: string | null) => {
      if (this.child !== c) return; // we stopped it
      this.child = null;
      const f = fault as { code: string; message: string } | null;
      this.o.log(`wake: helper exited (${signal ?? `exit ${code}`})${f ? ` ${f.code}: ${f.message}` : lastErr ? `: ${lastErr}` : ""}`);
      // No permission, or no on-device recognizer: retrying can't help. Say so and stop.
      if (f && (f.code === "permission" || f.code === "offline-unavailable" || f.code === "recognizer-unavailable")) {
        const plain = wakeFault(f.code, f.message);
        this.error = plain.text;
        this.errorPane = plain.pane;
        return this.report();
      }
      this.retry(f?.message ?? (lastErr || "The listener stopped."));
    });
    this.report();
  }

  private retry(why: string): void {
    const now = this.o.now?.() ?? Date.now();
    this.failures = this.failures.filter((t) => now - t < 5 * 60_000);
    this.failures.push(now);
    if (this.failures.length > RESTART_DELAYS_MS.length) {
      this.error = `Listening stopped: ${why}`;
      this.errorPane = null;
      return this.report();
    }
    const delay = RESTART_DELAYS_MS[this.failures.length - 1]!;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.reconcile(); }, delay);
    this.restartTimer.unref?.();
    this.report();
  }

  private fire(e: { name: string; confidence: number; ms: number; also?: string[] }): void {
    this.o.log(`wake: heard "Hey ${[e.name, ...(e.also ?? [])].join(" and ")}" (confidence ${e.confidence}, ${e.ms} ms)`);
    // The call takes the microphone next; stop listening now so it can't fire twice.
    this.reasons.add("waking");
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = setTimeout(() => { this.handoffTimer = null; this.pause("waking", false); }, WAKE_HANDOFF_MS);
    this.handoffTimer.unref?.();
    this.reconcile();
    this.o.onWake(e);
  }

  private stopChild(): void {
    const c = this.child;
    if (!c) return;
    this.child = null;
    try { c.stdin?.write("stop\n"); c.stdin?.end(); } catch { /* gone */ }
    // The mic indicator must go off: a helper that ignores stop is killed.
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 1_500);
    t.unref?.();
    c.once("close", () => clearTimeout(t));
    try { c.kill("SIGTERM"); } catch { /* gone */ }
  }
}

/** The menu-bar item's words for a state. */
export function wakeStatusText(s: WakeState): string {
  if (s.listening) return "Listening for “Hey” + a Bot’s name";
  const why = s.pausedFor[0];
  switch (why) {
    case "off": return "Wake word is off";
    case "error": return s.error ?? "Wake word stopped";
    case "user": return "Paused";
    case "locked": return "Paused while the screen is locked";
    case "asleep": return "Paused while the Mac sleeps";
    case "busy": return "Paused during dictation or a call";
    case "waking": return "Starting a call…";
    case "battery": return "Paused on battery power";
    case "bluetooth": return "Paused: a Bluetooth microphone would drop to call quality";
    case "no-names": return "Paused: no Bots to listen for";
    default: return "Starting…";
  }
}
