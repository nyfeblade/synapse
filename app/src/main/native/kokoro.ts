import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { LIMITS5 } from "@synapse/shared";
import { registerNative } from "../native";
import { engineDirs } from "../profile";
import type { KokoroDone, KokoroHandlers } from "./tts-dsp";

// Bug 161: the PCM work lives in tts-dsp.ts — no Electron, no sidecar, so the offline harness
// (app/look/tts-glitch.mjs) and the tests drive exactly the code a call plays. Re-exported here
// because dictation.ts, audio-devices.ts and voice-cache.ts have always imported it from "kokoro".
export {
  PROSODY_DEFAULT, PROSODY_OFF, PROSODY_QWEN, endsQuestion, plainProsody, prosodyFrom, qwenProsody, rampQuestionTail, silenceGate, voicedEnd, withProsody,
  type Prosody,
} from "./tts-dsp";

/**
 * Bug 107: Kokoro — a local, free, offline neural TTS — is the "Natural" voice engine for voice calls
 * and Preview. It runs as a long-running Python sidecar (native/kokoro/kokoro_server.py) on the
 * runtime and model bundled in Synapse.app (portable install; a hand-set path or Synapse's own env
 * otherwise, never a voice path outside Synapse's own data): this module finds them, probes them, runs the sidecar
 * (bug 134: kept hot while the app runs when "Keep voice ready" is on — loaded 10 s after launch,
 * restarted with backoff if it crashes; otherwise spawned on first use and killed after 5 idle
 * minutes — and always killed at quit), and decodes its PCM frames. The
 * audio is played by the Swift helper (dictation.ts), so echo cancellation, barge-in, the output
 * device and the level meter all apply; Apple's voice is the fallback for any line Kokoro can't say.
 */

export interface KokoroVoice { id: string; name: string; accent: "American" | "British"; gender: "female" | "male" }
/** The curated English set each Bot's voice is drawn from (deterministic per Bot, distinct in a group). */
export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { id: "af_heart", name: "Heart", accent: "American", gender: "female" },
  { id: "am_michael", name: "Michael", accent: "American", gender: "male" },
  { id: "bf_emma", name: "Emma", accent: "British", gender: "female" },
  { id: "bm_george", name: "George", accent: "British", gender: "male" },
  { id: "af_bella", name: "Bella", accent: "American", gender: "female" },
  { id: "am_fenrir", name: "Fenrir", accent: "American", gender: "male" },
  { id: "af_nicole", name: "Nicole", accent: "American", gender: "female" },
  { id: "am_puck", name: "Puck", accent: "American", gender: "male" },
  { id: "bm_fable", name: "Fable", accent: "British", gender: "male" },
];
export const KOKORO_PREFIX = "kokoro:";
/** What Preview says — the same phrase the helper's Apple speaker test says (its fallback). */
export const PREVIEW_PHRASE = "Hi! This is how I'll sound when we talk.";

/** "kokoro:af_heart" → "af_heart"; anything else (an Apple voice, a path, junk) → null. */
export function kokoroVoiceId(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith(KOKORO_PREFIX)) return null;
  const id = v.slice(KOKORO_PREFIX.length);
  return /^[a-z]{2}_[a-z]{2,20}$/.test(id) ? id : null;
}

/**
 * Where an engine came from. "bundled" is the runtime inside Synapse.app (portable install); the rest
 * are Synapse's own downloads or a path the user set by hand. Nothing is ever auto-detected from
 * a voice path outside Synapse's own data or the Hugging Face cache.
 */
export interface KokoroEngine { python: string; modelDir: string; source: "bundled" | "settings" | "synapse" | "pack" }
export interface KokoroPaths { python?: string | null; modelDir?: string | null }

/** A model folder the sidecar can load offline: config, weights and at least the default voice. */
export function modelDirOk(dir: string, exists: (p: string) => boolean): boolean {
  return ["config.json", "kokoro-v1_0.safetensors", path.join("voices", "af_heart.safetensors")].every((f) => exists(path.join(dir, f)));
}

/** Inside the bundled runtime folder (scripts/kokoro-runtime.mjs writes the same layout). */
// python3.12 itself: the bundle ships no symlinks (electron-packager rewrites them to its staging folder).
export const BUNDLED_PYTHON = path.join("python", "bin", "python3.12");
export const BUNDLED_MODEL = "model";

/**
 * The bundled runtime folder: SYNAPSE_KOKORO_DIR (tests, and a dev run pointed at a staged copy), the
 * packaged app's Contents/Resources/kokoro, or — in development — what `node scripts/kokoro-runtime.mjs
 * stage .build-cache/stage` left at the repo root.
 */
export function bundledKokoroDir(o: { isPackaged: boolean; resourcesPath: string; appPath: string; env?: NodeJS.ProcessEnv }): string {
  const override = o.env?.SYNAPSE_KOKORO_DIR;
  if (override) return override;
  if (o.isPackaged) return path.join(o.resourcesPath, "kokoro");
  return path.join(o.appPath, "..", ".build-cache", "stage", "kokoro");
}

/**
 * Where Kokoro lives, in order (portable install): the runtime bundled in Synapse.app; the paths the
 * user set by hand in settings; a Synapse-owned env (<userData>/kokoro or the shared …/Synapse/kokoro).
 * A voice path outside Synapse's own data and the Hugging Face cache are never probed — only a path typed into settings reaches them.
 * `home` stays in the signature for the callers that pass it; nothing under it is looked at.
 */
export function findKokoro(o: { home?: string; bundled?: string | null; userData: string; exists(p: string): boolean; listDir?(p: string): string[]; settings?: KokoroPaths }): KokoroEngine | null {
  if (o.bundled) {
    const python = path.join(o.bundled, BUNDLED_PYTHON);
    const modelDir = path.join(o.bundled, BUNDLED_MODEL);
    if (o.exists(python) && modelDirOk(modelDir, o.exists)) return { python, modelDir, source: "bundled" };
  }
  const s = o.settings;
  if (s?.python && s.modelDir && o.exists(s.python) && modelDirOk(s.modelDir, o.exists)) return { python: s.python, modelDir: s.modelDir, source: "settings" };
  for (const dir of engineDirs(o.userData, "kokoro")) {
    const own = { python: path.join(dir, ".venv", "bin", "python"), modelDir: path.join(dir, "model") };
    if (o.exists(own.python) && modelDirOk(own.modelDir, o.exists)) return { ...own, source: "synapse" };
  }
  return null;
}

/** `-X pycache_prefix=…`: compiled bytecode goes to Synapse's cache folder from the first import on, never into the signed bundle. */
export function pycacheArgs(cacheDir: string | undefined): string[] {
  return cacheDir ? ["-X", `pycache_prefix=${path.join(cacheDir, "pycache")}`] : ["-B"];
}

/**
 * Apple-silicon Python, isolated from the user's shell (-s: no user site, -E: no PYTHON* variables).
 * Bug 134: `cacheDir` keeps the compiled bytecode in Synapse's own folder (it was recompiled on every
 * start) — from interpreter start-up on, so not one .pyc lands inside Synapse.app and breaks its seal —
 * and `voice` builds that voice's accent first (the other waits for a prime).
 */
export function kokoroCommand(e: KokoroEngine, script: string, o: { cacheDir?: string; voice?: string } = {}): { cmd: string; args: string[] } {
  const extra = [...(o.cacheDir ? ["--cache-dir", o.cacheDir] : []), ...(o.voice && /^[a-z]{2}_[a-z]{2,20}$/.test(o.voice) ? ["--voice", o.voice] : [])];
  const pyc = o.cacheDir ? pycacheArgs(o.cacheDir) : [];
  return { cmd: "/usr/bin/arch", args: ["-arm64", e.python, "-s", "-E", ...pyc, script, "--model-dir", e.modelDir, ...extra] };
}

/** The import test: the packages the sidecar needs are importable (without loading the model). */
const PROBE = "import importlib.util as u, mlx.core; missing=[m for m in ('mlx_audio','misaki','spacy','numpy') if u.find_spec(m) is None]; assert not missing, 'missing: ' + ', '.join(missing)";

export function probeKokoro(e: KokoroEngine, o: { spawnFn?: typeof spawn; timeoutMs?: number; cacheDir?: string } = {}): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const started = Date.now();
  // The bundled runtime's first probe compiles its imports into the (empty) cache: give it room.
  const timeoutMs = o.timeoutMs ?? (e.source === "bundled" ? LIMITS5.kokoroProbeMs * 5 : LIMITS5.kokoroProbeMs);
  return new Promise((resolve) => {
    let c: ChildProcess;
    try {
      c = (o.spawnFn ?? spawn)("/usr/bin/arch", ["-arm64", e.python, "-s", "-E", ...pycacheArgs(o.cacheDir), "-c", PROBE], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, ms: 0, reason: (err as Error).message });
    }
    let err = "";
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { c.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    t.unref?.();
    c.stderr?.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-2000); });
    c.on("error", (x) => { clearTimeout(t); resolve({ ok: false, ms: Date.now() - started, reason: x.message }); });
    c.on("close", (code: number | null) => {
      clearTimeout(t);
      const ms = Date.now() - started;
      if (timedOut) return resolve({ ok: false, ms, reason: `The import test timed out after ${Math.round(timeoutMs / 1000)} s.` });
      if (code === 0) return resolve({ ok: true, ms });
      const last = err.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
      resolve({ ok: false, ms, reason: last.slice(0, 300) });
    });
  });
}

// ---- frames: u32 BE length, then u16 BE header length, JSON header, float32 LE PCM ----
export interface KokoroFrame { header: Record<string, unknown> & { type?: unknown; id?: unknown }; pcm: Buffer }
const MAX_FRAME = 8 * 1024 * 1024;

export function encodeFrame(header: Record<string, unknown>, pcm: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const out = Buffer.alloc(4 + 2 + h.length + pcm.length);
  out.writeUInt32BE(2 + h.length + pcm.length, 0);
  out.writeUInt16BE(h.length, 4);
  h.copy(out, 6);
  pcm.copy(out, 6 + h.length);
  return out;
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): KokoroFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: KokoroFrame[] = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n < 2 || n > MAX_FRAME) { this.buf = Buffer.alloc(0); break; } // out of sync: drop, the next frame starts clean
      if (this.buf.length < 4 + n) break;
      const hl = this.buf.readUInt16BE(4);
      if (2 + hl > n) { this.buf = Buffer.alloc(0); break; }
      let header: KokoroFrame["header"];
      try { header = JSON.parse(this.buf.subarray(6, 6 + hl).toString("utf8")); } catch { header = { type: "bad" }; }
      // A copy at offset 0 (Float32-aligned), not a view into the shared read buffer.
      const pcm = Buffer.alloc(n - 2 - hl);
      this.buf.copy(pcm, 0, 6 + hl, 4 + n);
      out.push({ header, pcm });
      this.buf = this.buf.subarray(4 + n);
    }
    return out;
  }
}

// ---- the sidecar process ----
export interface KokoroJob {
  id: string; text: string; voice: string; speed: number;
  /**
   * Fields this engine understands and Kokoro doesn't, written onto the same synth command
   * (Qwen's `quality` and `targetRms`). A sidecar ignores any key it doesn't know, so an engine
   * that never sets this is unaffected.
   */
  extra?: Record<string, string | number>;
}
export type { KokoroDone, KokoroHandlers };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class KokoroSidecar {
  private child: ChildProcess | null = null;
  private reader = new FrameReader();
  private jobs = new Map<string, KokoroHandlers>();
  private warm = false;
  private spawnedAt = 0;
  private idle: NodeJS.Timeout | null = null;
  private stall: NodeJS.Timeout | null = null;
  private warmWaiters: Array<(ok: boolean) => void> = [];
  /** Bug 134: stopped on purpose (idle or quit): its exit is not a crash to recover from. */
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Crashes in a row without a healthy stretch (resets after 5 minutes up). */
  private crashes = 0;
  private lastVoice: string | undefined;

  /** `keepAlive`: "Keep voice ready" — no idle timeout, and a crash restarts it (1 s, 2 s, 4 s… up to 60 s). */
  constructor(private o: {
    engine: KokoroEngine; script: string; spawnFn?: typeof spawn; log: (line: string) => void;
    idleMs?: number; stallMs?: number; cacheDir?: string; keepAlive?: () => boolean;
    /** How this sidecar builds its command line. Defaults to Kokoro's. */
    command?: (voice: string | undefined) => { cmd: string; args: string[] };
    /** Which voice ids this sidecar will accept for `prime`. Defaults to Kokoro's. */
    voiceOk?: (v: string) => boolean;
    /** What it calls itself in voice.log. */
    tag?: string;
  }) {}

  private get tag(): string { return this.o.tag ?? "kokoro"; }

  isRunning(): boolean { return this.child !== null; }
  isWarm(): boolean { return this.child !== null && this.warm; }
  /** A line (live or pre-rendered) is being synthesized. */
  busy(): boolean { return this.jobs.size > 0; }

  /** "Keep voice ready" was turned off: from now on it idles out like before (5 minutes without work). */
  relax(): void {
    this.touch();
  }

  /** Bug 134: build these voices' accents and packs now, so none of the call's first lines is the slow one. */
  prime(voices: string[]): void {
    const ok = this.o.voiceOk ?? ((x: string) => /^[a-z]{2}_[a-z]{2,20}$/.test(x));
    const v = [...new Set(voices.filter(ok))].slice(0, 8);
    if (!v.length) return;
    this.start(v[0]);
    this.write({ op: "prime", voices: v });
  }

  /** Spawn (once) and warm up. Never blocks: the model loads in the sidecar, in the background. `voice`: whose accent to build first. */
  start(voice?: string): void {
    if (this.child) { this.touch(); return; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.stopping = false;
    if (voice) this.lastVoice = voice;
    const { cmd, args } = this.o.command?.(voice ?? this.lastVoice) ?? kokoroCommand(this.o.engine, this.o.script, { cacheDir: this.o.cacheDir, voice: voice ?? this.lastVoice });
    const c = (this.o.spawnFn ?? spawn)(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = c;
    this.warm = false;
    this.reader = new FrameReader();
    this.spawnedAt = Date.now();
    this.o.log(`${this.tag}: starting (${this.o.engine.source}: ${this.o.engine.python}${this.o.engine.modelDir ? `, model ${this.o.engine.modelDir}` : ""})`);
    let errBuf = "";
    let lastErr = "";
    c.stderr?.on("data", (d: Buffer) => {
      errBuf += d.toString("utf8");
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!line || /NotOpenSSLWarning|warnings\.warn\(/.test(line)) continue;
        lastErr = line.replace(/^\[(?:kokoro|f5) [^\]]*\]\s*/, "").slice(0, 300);
        this.o.log(`${this.tag}: ${line.slice(0, 500)}`);
      }
      if (errBuf.length > 8192) errBuf = errBuf.slice(-4096);
    });
    c.stdout?.on("data", (d: Buffer) => { if (this.child === c) for (const f of this.reader.push(d)) this.onFrame(f); });
    c.on("error", (e) => this.onExit(c, `couldn't start: ${e.message}`));
    c.on("close", (code: number | null, signal: string | null) => this.onExit(c, `${signal ? `signal ${signal}` : `exit ${code}`}${lastErr ? `: ${lastErr}` : ""}`));
    this.touch();
  }

  /** Resolves true once warm, false if the sidecar dies or `timeoutMs` passes first. */
  whenWarm(timeoutMs: number): Promise<boolean> {
    this.start();
    if (this.warm) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.warmWaiters = this.warmWaiters.filter((w) => w !== done); resolve(false); }, timeoutMs);
      t.unref?.();
      const done = (ok: boolean) => { clearTimeout(t); resolve(ok); };
      this.warmWaiters.push(done);
    });
  }

  synth(job: KokoroJob, h: KokoroHandlers): void {
    this.start();
    this.jobs.set(job.id, h);
    this.write({ op: "synth", id: job.id, text: job.text, voice: job.voice, speed: job.speed, ...(job.extra ?? {}) });
    this.touch();
  }

  /** Drop one job (queued or mid-synth), or everything. Its handlers never fire again. */
  cancel(id?: string): void {
    if (id) this.jobs.delete(id); else this.jobs.clear();
    if (this.child) this.write(id ? { op: "cancel", id } : { op: "cancel" });
    this.touch();
  }

  /** Stop the sidecar (idle, or the app quitting): stdin closes, then a kill if it lingers. */
  dispose(): void {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const c = this.child;
    if (!c) return;
    this.failAll("The natural voice was shut down.");
    this.child = null;
    this.warm = false;
    this.clearTimers();
    try { c.stdin?.end(); } catch { /* gone */ }
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
    t.unref?.();
    c.once?.("close", () => clearTimeout(t));
  }

  private write(o: Record<string, unknown>): void {
    try { this.child?.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* the close handler reports it */ }
  }

  private onFrame(f: KokoroFrame): void {
    const h = f.header;
    const id = typeof h.id === "string" ? h.id : null;
    this.touch();
    switch (h.type) {
      case "ready":
        this.o.log(`${this.tag}: model loaded in ${Math.round(num(h.loadMs))} ms`);
        return;
      case "warm":
        if (!this.warm) this.o.log(`${this.tag}: warm in ${Math.round(num(h.ms))} ms (${Date.now() - this.spawnedAt} ms after spawn)`);
        this.warm = true;
        for (const w of this.warmWaiters.splice(0)) w(true);
        return;
      case "audio": {
        const j = id ? this.jobs.get(id) : undefined;
        if (j && f.pcm.length) j.audio(f.pcm, num(h.seq));
        return;
      }
      case "done": {
        const j = id ? this.jobs.get(id) : undefined;
        if (!id || !j) return;
        this.jobs.delete(id);
        const info = { synthMs: num(h.synthMs), audioMs: num(h.audioMs), rtf: num(h.rtf), firstMs: num(h.firstMs) };
        this.o.log(`${this.tag}: synth ${id}: ${info.synthMs} ms for ${info.audioMs} ms of audio (rtf ${info.rtf}), first chunk ${info.firstMs} ms`);
        j.done(info);
        return;
      }
      case "error": {
        const message = typeof h.message === "string" ? h.message : "Kokoro failed.";
        if (!id) { this.o.log(`${this.tag}: error: ${message}`); return; } // a load failure: the close that follows fails the jobs
        const j = this.jobs.get(id);
        this.jobs.delete(id);
        j?.error(message);
        return;
      }
      default:
        return;
    }
  }

  private onExit(c: ChildProcess, why: string): void {
    if (this.child !== c) return;
    this.child = null;
    this.warm = false;
    this.clearTimers();
    this.o.log(`${this.tag}: stopped (${why})`);
    for (const w of this.warmWaiters.splice(0)) w(false);
    this.failAll(`The natural voice stopped (${why}).`);
    // Bug 134: kept hot — a crash is restarted, with backoff so a broken install can't spin.
    if (!this.stopping && this.o.keepAlive?.()) {
      if (Date.now() - this.spawnedAt > 5 * 60_000) this.crashes = 0;
      this.crashes += 1;
      const delay = Math.min(60_000, 1_000 * 2 ** (this.crashes - 1));
      this.o.log(`${this.tag}: restarting in ${Math.round(delay / 1000)} s (crash ${this.crashes})`);
      this.restartTimer = setTimeout(() => { this.restartTimer = null; if (!this.stopping && this.o.keepAlive?.()) this.start(); }, delay);
      this.restartTimer.unref?.();
    }
  }

  private failAll(message: string): void {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const j of jobs) j.error(message);
  }

  private clearTimers(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.stall) clearTimeout(this.stall);
    this.idle = this.stall = null;
  }

  /** Activity: restart the idle clock; while a warm sidecar owes frames, watch for a hang. */
  private touch(): void {
    if (!this.child) return;
    this.clearTimers();
    const c = this.child;
    const idleMs = this.o.idleMs ?? LIMITS5.kokoroIdleMs;
    // Bug 134: "Keep voice ready": no idle timeout at all (the stall watchdog below still runs).
    if (!this.o.keepAlive?.()) this.idle = setTimeout(() => {
      if (this.child !== c) return;
      if (this.jobs.size) return this.touch(); // busy: never idle out mid-reply
      this.o.log(`${this.tag}: idle for ${Math.round((this.o.idleMs ?? LIMITS5.kokoroIdleMs) / 1000)} s; stopping`);
      this.dispose();
    }, idleMs);
    this.idle?.unref?.();
    if (this.warm && this.jobs.size) {
      this.stall = setTimeout(() => {
        if (this.child !== c || !this.jobs.size) return;
        this.o.log(`${this.tag}: no output for ${Math.round((this.o.stallMs ?? LIMITS5.kokoroStallMs) / 1000)} s with work pending; killing it`);
        try { c.kill("SIGKILL"); } catch { /* gone */ }
      }, this.o.stallMs ?? LIMITS5.kokoroStallMs);
      this.stall.unref?.();
    }
  }
}

// ---- the service: discovery, probe, status, the one sidecar ----
export type KokoroState = "ready" | "missing" | "checking";
export interface KokoroStatus { state: KokoroState; voices: readonly KokoroVoice[]; source?: KokoroEngine["source"]; reason?: string }

/** What dictation.ts / audio-devices.ts need from the natural voice. */
export interface NaturalTts {
  isReady(): boolean;
  isWarm(): boolean;
  /** Start loading (never waits). `voices`: the ones about to be used, so their accents are built first. */
  warm(voices?: string[]): void;
  whenWarm?(timeoutMs: number): Promise<boolean>;
  synth(job: KokoroJob, h: KokoroHandlers): void;
  cancel(id?: string): void;
  /** Bug 134: a line is being synthesized (pre-rendering waits for it). */
  busy?(): boolean;
}

export function registerKokoro(o: {
  script: string; home: string; userData: string; log: (line: string) => void;
  /** Portable install: the runtime folder bundled in Synapse.app (bundledKokoroDir), tried first. */
  bundled?: string | null;
  settings?: () => KokoroPaths; spawnFn?: typeof spawn;
  exists?: (p: string) => boolean; listDir?: (p: string) => string[];
  /** Bug 134: "Keep voice ready" (default on): loaded shortly after launch and kept hot while the app runs. */
  keepReady?: () => boolean;
  /** How long after launch it loads (so launch isn't slowed). */
  launchDelayMs?: number;
}): NaturalTts & { status(): Promise<KokoroStatus>; dispose(): void; keepReadyChanged(): void } {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const listDir = o.listDir ?? ((p: string) => { try { return fs.readdirSync(p); } catch { return []; } });
  let checked: Promise<KokoroStatus> | null = null;
  let current: KokoroStatus = { state: "checking", voices: KOKORO_VOICES };
  let sidecar: KokoroSidecar | null = null;

  const check = (): Promise<KokoroStatus> => {
    if (checked) return checked;
    checked = (async () => {
      const engine = exists(o.script) ? findKokoro({ home: o.home, bundled: o.bundled ?? null, userData: o.userData, exists, listDir, settings: o.settings?.() }) : null;
      if (!engine) {
        current = { state: "missing", voices: KOKORO_VOICES, reason: exists(o.script) ? "The bundled voice runtime is missing from this build." : "The Kokoro sidecar isn't in this build." };
        o.log(`kokoro: not found (${current.reason})`);
        return current;
      }
      const p = await probeKokoro(engine, { spawnFn: o.spawnFn, cacheDir: path.join(o.userData, "kokoro-cache") });
      o.log(`kokoro: probe ${p.ok ? "ok" : "failed"} in ${p.ms} ms (${engine.source}: ${engine.python})${p.reason ? `: ${p.reason}` : ""}`);
      if (!p.ok) { current = { state: "missing", voices: KOKORO_VOICES, source: engine.source, reason: p.reason }; return current; }
      sidecar = new KokoroSidecar({ engine, script: o.script, spawnFn: o.spawnFn, log: o.log, cacheDir: path.join(o.userData, "kokoro-cache"), keepAlive: () => o.keepReady?.() === true });
      current = { state: "ready", voices: KOKORO_VOICES, source: engine.source };
      return current;
    })();
    return checked;
  };

  registerNative("kokoro.status", async (a: { refresh?: unknown } | undefined) => {
    if (a?.refresh === true && current.state === "missing") checked = null;
    return check();
  });

  /** Start (and prime) the sidecar; `voices` are kokoro ids ("bm_george") or "kokoro:<id>" values. */
  const warm = (voices: unknown[] = []): void => {
    const ids = voices.map((v) => (typeof v === "string" ? kokoroVoiceId(v) ?? (/^[a-z]{2}_[a-z]{2,20}$/.test(v) ? v : null) : null)).filter((v): v is string => v !== null);
    void check().then(() => {
      if (!sidecar) return;
      sidecar.start(ids[0]);
      if (ids.length) sidecar.prime(ids);
    });
  };
  // Bug 134: "Keep voice ready" — the model is loaded 10 s after launch (only if Kokoro is Ready) and
  // kept hot while the app runs, so every call's replies are in the natural voice from the first line.
  if (o.keepReady) {
    const t = setTimeout(() => { if (o.keepReady?.()) { o.log("kokoro: keeping the natural voice ready (loading after launch)"); warm(); } }, o.launchDelayMs ?? 10_000);
    t.unref?.();
  }

  return {
    status: check,
    isReady: () => current.state === "ready" && sidecar !== null,
    isWarm: () => sidecar?.isWarm() ?? false,
    warm: (voices) => warm(voices ?? []),
    busy: () => sidecar?.busy() ?? false,
    keepReadyChanged: () => { if (o.keepReady?.()) warm(); else sidecar?.relax(); },
    whenWarm: async (ms) => { await check(); return sidecar ? sidecar.whenWarm(ms) : false; },
    synth: (job, h) => { if (sidecar) sidecar.synth(job, h); else h.error("The natural voice isn't available."); },
    cancel: (id) => { if (sidecar?.isRunning()) sidecar.cancel(id); },
    dispose: () => sidecar?.dispose(),
  };
}
