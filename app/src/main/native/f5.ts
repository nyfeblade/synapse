/**
 * F5: cloned voices, built from a clip of the user's own speech.
 *
 * Off unless the user records a voice. F5 is slower than real time on this Mac — it
 * renders a whole sentence before a word of it can play — so Kokoro stays the default
 * and the call path falls back to a Bot's Kokoro voice for the first chunk. What F5
 * gives that neither Kokoro nor Apple can is the user's own voice.
 *
 * A saved voice is a *profile* folder under <userData>/voices/<id>/:
 *   clip.wav      the reference, 24 kHz mono, recorded in Settings → Voice
 *   profile.json  the exact transcript, the generation parameters and a fixed seed
 *   cond.npy      the reference conditioning, cached by the sidecar on first use
 * F5 is zero-shot, so it re-derives the voice every time it speaks; the fixed seed and
 * the cached conditioning are what stop the voice drifting between sentences and
 * between sessions.
 *
 * The sidecar (app/native/f5/f5_server.py) speaks the Kokoro wire protocol, so the
 * frame decoding, the idle shutdown, the crash backoff and the prosody chain are all
 * the Kokoro ones, reused — see KokoroSidecar.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLIP_SAMPLE_RATE } from "@synapse/shared";
import { registerNative } from "../native";
import { KokoroSidecar, type KokoroEngine, type NaturalTts } from "./kokoro";
import { engineDirs } from "../profile";

/** "f5:<profile id>" → "<profile id>"; anything else (a Kokoro id, an Apple voice) → null. */
export const F5_PREFIX = "f5:";
export function f5VoiceId(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith(F5_PREFIX)) return null;
  const id = v.slice(F5_PREFIX.length);
  return VOICE_ID.test(id) ? id : null;
}
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The parameters a saved voice keeps, so it sounds the same every time it speaks. */
export interface F5Profile {
  version: 1;
  id: string;
  name: string;
  /** What the reference clip says, word for word — the single biggest lever on clone quality. */
  transcript: string;
  /** Which offered script was read, or "own" when the user used their own words. */
  scriptId: string;
  createdAt: string;
  /** Fixed, so the same line renders the same way in a later session. */
  seed: number;
  steps: number;
  cfgStrength: number;
  swaySampling: number;
  speed: number;
  /** The reference's RMS; every rendered sentence is held to it. */
  loudness: number;
  /** What the take measured and whether each rule passed, kept for the management list. */
  checks?: unknown;
}

export const F5_DEFAULTS = { seed: 1234, steps: 8, cfgStrength: 2, swaySampling: -1, speed: 1 } as const;

export interface F5VoiceView { id: string; name: string; createdAt: string; scriptId: string }
export type F5State = "ready" | "no-voices" | "missing" | "checking";
export interface F5Status { state: F5State; voices: F5VoiceView[]; reason?: string }

// ---------------------------------------------------------------- the store

export function voicesDir(userData: string): string { return path.join(userData, "voices"); }

const profilePath = (dir: string, id: string) => path.join(dir, id, "profile.json");

/** Read one saved voice, or null when it is missing or unreadable. */
export function readProfile(dir: string, id: string): F5Profile | null {
  if (!VOICE_ID.test(id)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(dir, id), "utf8")) as F5Profile;
    if (raw?.version !== 1 || typeof raw.transcript !== "string" || !raw.transcript.trim()) return null;
    if (!fs.existsSync(path.join(dir, id, "clip.wav"))) return null;
    return { ...raw, id };
  } catch { return null; }
}

/** Every saved voice, newest first. */
export function listProfiles(dir: string): F5Profile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => readProfile(dir, n))
    .filter((p): p is F5Profile => p !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export const toView = (p: F5Profile): F5VoiceView => ({ id: p.id, name: p.name, createdAt: p.createdAt, scriptId: p.scriptId });

/**
 * Save a take as a voice. `wav` is a complete 24 kHz mono WAV file.
 * Writing a profile drops any cached conditioning, so the next line rebuilds it.
 */
export function saveProfile(dir: string, o: {
  id: string; name: string; transcript: string; scriptId: string; wav: Buffer;
  loudness: number; checks?: unknown; createdAt?: string;
}): F5Profile {
  if (!VOICE_ID.test(o.id)) throw new Error("bad voice id");
  if (!o.transcript.trim()) throw new Error("a cloned voice needs the clip's transcript");
  const base = path.join(dir, o.id);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "clip.wav"), o.wav, { mode: 0o600 });
  try { fs.rmSync(path.join(base, "cond.npy")); } catch { /* none cached yet */ }
  const p: F5Profile = {
    version: 1,
    id: o.id,
    name: o.name.slice(0, 60) || "My voice",
    transcript: o.transcript,
    scriptId: o.scriptId,
    createdAt: o.createdAt ?? new Date().toISOString(),
    loudness: o.loudness,
    checks: o.checks,
    ...F5_DEFAULTS,
  };
  fs.writeFileSync(profilePath(dir, o.id), JSON.stringify(p, null, 2), { mode: 0o600 });
  return p;
}

export function renameProfile(dir: string, id: string, name: string): F5Profile | null {
  const p = readProfile(dir, id);
  if (!p) return null;
  const next = { ...p, name: name.slice(0, 60) || p.name };
  fs.writeFileSync(profilePath(dir, id), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function deleteProfile(dir: string, id: string): boolean {
  if (!VOICE_ID.test(id)) return false;
  try { fs.rmSync(path.join(dir, id), { recursive: true, force: true }); return true; } catch { return false; }
}

/** A voice id from a name, unique against what is already saved. */
export function voiceIdFor(dir: string, name: string): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "voice";
  let id = stem;
  let n = 2;
  while (fs.existsSync(path.join(dir, id))) id = `${stem}-${n++}`;
  return id;
}

// ---------------------------------------------------------------- the engine

/** Where F5's Python lives: a path set by hand, then Synapse's own env (the voice pack). Nothing outside Synapse's own data is auto-detected (portable install). */
export function findF5(o: { home: string; userData: string; exists: (p: string) => boolean; python?: string | null }): KokoroEngine | null {
  if (o.python && o.exists(o.python)) return { python: o.python, modelDir: "", source: "settings" };
  // Portable install: the "Cloned voices" pack (voice-packs.ts): its own Python, and its weights in a Hugging
  // Face layout under <root>/hf, which the sidecar reads through HF_HOME (f5Command).
  for (const d of engineDirs(o.userData, "f5")) {
    const python = path.join(d, "runtime", "python", "bin", "python3.12");
    if (o.exists(python) && o.exists(path.join(d, "pack.json"))) return { python, modelDir: path.join(d, "hf"), source: "pack" };
  }
  for (const d of engineDirs(o.userData, "f5")) {
    const python = path.join(d, ".venv", "bin", "python");
    if (o.exists(python)) return { python, modelDir: "", source: "synapse" };
  }
  return null;
}

/** The import test: f5_tts_mlx is installed and MLX loads, without pulling the weights in. */
const PROBE = "import importlib.util as u, mlx.core; missing=[m for m in ('f5_tts_mlx','vocos_mlx','soundfile','numpy') if u.find_spec(m) is None]; assert not missing, 'missing: ' + ', '.join(missing)";

export function probeF5(e: KokoroEngine, o: { spawnFn?: typeof spawn; timeoutMs?: number } = {}): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let err = "";
    let done = false;
    const finish = (r: { ok: boolean; reason?: string }) => { if (!done) { done = true; resolve(r); } };
    const c = (o.spawnFn ?? spawn)("/usr/bin/arch", ["-arm64", e.python, "-s", "-E", "-c", PROBE], { stdio: ["ignore", "ignore", "pipe"] });
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } finish({ ok: false, reason: "The import test timed out." }); }, o.timeoutMs ?? 20_000);
    t.unref?.();
    c.stderr?.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-2000); });
    c.on("error", (x) => { clearTimeout(t); finish({ ok: false, reason: x.message }); });
    c.on("close", (code: number | null) => {
      clearTimeout(t);
      if (code === 0) return finish({ ok: true });
      finish({ ok: false, reason: (err.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`).slice(0, 300) });
    });
  });
}

export function f5Command(e: KokoroEngine, script: string, o: { profilesDir: string; voice?: string }): { cmd: string; args: string[] } {
  const args = ["-arm64", e.python, "-s", "-E", script, "--profiles-dir", o.profilesDir,
    ...(o.voice && VOICE_ID.test(o.voice) ? ["--voice", o.voice] : [])];
  // The pack's weights live in its own Hugging Face layout; -E doesn't strip HF_HOME (it isn't a PYTHON* variable).
  if (e.source === "pack" && e.modelDir) return { cmd: "/usr/bin/env", args: [`HF_HOME=${e.modelDir}`, "/usr/bin/arch", ...args] };
  return { cmd: "/usr/bin/arch", args };
}

/**
 * The cloned-voice engine, behind the same NaturalTts interface Kokoro implements.
 *
 * It costs nothing until a Bot that uses a cloned voice speaks: no Python is started,
 * no weights are read and no memory is taken. When one does, the sidecar starts, and it
 * shuts down again on the usual idle timeout — cloned voices are never kept hot, because
 * the model is about 1.4 GB resident.
 */
export function registerF5(o: {
  script: string; home: string; userData: string; log: (line: string) => void;
  python?: () => string | null | undefined; spawnFn?: typeof spawn;
  exists?: (p: string) => boolean; idleMs?: number;
}): NaturalTts & { status(): Promise<F5Status>; dispose(): void; recheck(): void } {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const dir = voicesDir(o.userData);
  let checked: Promise<F5Status> | null = null;
  let current: F5Status = { state: "checking", voices: [] };
  let sidecar: KokoroSidecar | null = null;

  const check = (): Promise<F5Status> => {
    if (checked) return checked;
    checked = (async () => {
      const voices = listProfiles(dir).map(toView);
      if (!exists(o.script)) {
        current = { state: "missing", voices, reason: "The cloned-voice sidecar isn't in this build." };
        return current;
      }
      const engine = findF5({ home: o.home, userData: o.userData, exists, python: o.python?.() });
      if (!engine) {
        current = { state: "missing", voices, reason: "No Python with f5-tts-mlx was found." };
        o.log(`f5: not found (${current.reason})`);
        return current;
      }
      const p = await probeF5(engine, { spawnFn: o.spawnFn });
      o.log(`f5: probe ${p.ok ? "ok" : "failed"} (${engine.source}: ${engine.python})${p.reason ? `: ${p.reason}` : ""}`);
      if (!p.ok) { current = { state: "missing", voices, reason: p.reason }; return current; }
      sidecar = new KokoroSidecar({
        engine, script: o.script, spawnFn: o.spawnFn, log: o.log, tag: "f5", idleMs: o.idleMs,
        command: (voice) => f5Command(engine, o.script, { profilesDir: dir, voice }),
        voiceOk: (v) => VOICE_ID.test(v),
        // Never kept hot: 1.4 GB resident is too much to hold for a voice nobody is using.
        keepAlive: () => false,
      });
      current = { state: voices.length ? "ready" : "no-voices", voices };
      return current;
    })();
    return checked;
  };

  /** Saved voices changed: re-read them without re-probing Python. */
  const refresh = (): void => {
    const voices = listProfiles(dir).map(toView);
    if (current.state === "ready" || current.state === "no-voices") current = { state: voices.length ? "ready" : "no-voices", voices };
    else current = { ...current, voices };
  };

  registerNative("f5.status", async (a: { refresh?: unknown } | undefined) => {
    if (a?.refresh === true) { if (current.state === "missing") checked = null; else refresh(); }
    return check();
  });

  const ids = (voices: unknown[]): string[] =>
    voices.map((v) => (typeof v === "string" ? f5VoiceId(v) ?? (VOICE_ID.test(v) ? v : null) : null)).filter((v): v is string => v !== null);

  const warm = (voices: unknown[] = []): void => {
    const v = ids(voices);
    if (!v.length) return; // F5 never loads speculatively: only a Bot using a cloned voice starts it
    void check().then(() => {
      if (!sidecar) return;
      sidecar.start(v[0]);
      sidecar.prime(v);
    });
  };

  return {
    status: check,
    isReady: () => current.state === "ready" && sidecar !== null,
    isWarm: () => sidecar?.isWarm() ?? false,
    warm: (voices) => warm(voices ?? []),
    busy: () => sidecar?.busy() ?? false,
    whenWarm: async (ms) => { await check(); return sidecar ? sidecar.whenWarm(ms) : false; },
    synth: (job, h) => {
      const id = f5VoiceId(job.voice) ?? (VOICE_ID.test(job.voice) ? job.voice : null);
      if (!id) return h.error("That cloned voice isn't available.");
      if (!sidecar) return h.error("The cloned voice isn't available.");
      sidecar.synth({ ...job, voice: id }, h);
    },
    cancel: (id) => { if (sidecar?.isRunning()) sidecar.cancel(id); },
    dispose: () => sidecar?.dispose(),
    /** A voice pack just finished installing: a missing engine is looked for again. */
    recheck: () => { if (current.state === "missing") checked = null; },
  };
}

export { CLIP_SAMPLE_RATE };
