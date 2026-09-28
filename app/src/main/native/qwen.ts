/**
 * Qwen3-TTS: the "Qwen3 (natural)" voice engine (bug 164).
 *
 * The sidecar (app/native/qwen/qwen_server.py) speaks the Kokoro wire protocol, so the frame
 * decoding, the idle shutdown, the crash backoff, the cancel path and the prosody chain are all the
 * Kokoro ones, reused — see KokoroSidecar. This module is discovery, the probe, the resource policy
 * and the level table.
 *
 * Resource policy, which is the whole reason this isn't just another entry in a list:
 *   - It is NEVER loaded for a user who hasn't chosen it. No Bot set to a qwen3: voice, or Light
 *     voice mode, and no Python starts, no weights are read and no memory is taken.
 *   - It is never kept hot. 2.1 GB resident is too much to hold for a voice nobody is using, so it
 *     loads on demand and idles out (LIMITS5.kokoroIdleMs) like F5 does.
 *   - `memoryMb()` reports what it is costing right now, so Settings can say so and the call screen
 *     can drop to Light if the Mac runs short.
 *
 * Two qualities go over the wire. A live call line streams the codec (first audio 0.23-0.45 s); a
 * pre-rendered line asks for "full", which renders the whole utterance before emitting (1.8-6.7 s)
 * because nothing is waiting on it and it is the better take.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LIMITS5, VOICE_ENGINE_MEMORY_MB, VOICE_PREFIX } from "@synapse/shared";
import { registerNative } from "../native";
import { KokoroSidecar, type KokoroEngine, type KokoroJob, type NaturalTts } from "./kokoro";
import { engineDirs } from "../profile";
import type { KokoroHandlers } from "./tts-dsp";

export const QWEN_PREFIX = VOICE_PREFIX.qwen;

export interface QwenVoice { id: string; name: string; accent: string; gender: "female" | "male" }

/**
 * The nine voices the CustomVoice build ships with. A voice name is REQUIRED — this model has no
 * default speaker and generate() without one fails — so there is no "automatic" row for Qwen.
 * The accents are how each one reads in English, which is what the picker shows.
 */
export const QWEN_VOICES: readonly QwenVoice[] = [
  { id: "vivian", name: "Vivian", accent: "American", gender: "female" },
  { id: "serena", name: "Serena", accent: "American", gender: "female" },
  { id: "ryan", name: "Ryan", accent: "American", gender: "male" },
  { id: "aiden", name: "Aiden", accent: "American", gender: "male" },
  { id: "eric", name: "Eric", accent: "American", gender: "male" },
  { id: "dylan", name: "Dylan", accent: "British", gender: "male" },
  { id: "uncle_fu", name: "Uncle Fu", accent: "Mandarin", gender: "male" },
  { id: "ono_anna", name: "Anna", accent: "Japanese", gender: "female" },
  { id: "sohee", name: "Sohee", accent: "Korean", gender: "female" },
];

const VOICE_IDS = new Set(QWEN_VOICES.map((v) => v.id));
const VOICE_ID = /^[a-z][a-z_]{2,30}$/;

/** "qwen3:vivian" → "vivian"; anything else (a Kokoro id, a cloned id, an Apple voice) → null. */
export function qwenVoiceId(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith(QWEN_PREFIX)) return null;
  const id = v.slice(QWEN_PREFIX.length);
  return VOICE_ID.test(id) && VOICE_IDS.has(id) ? id : null;
}

/**
 * Each Kokoro voice's measured output level (RMS over voiced samples, averaged over three phrases
 * on the owner's Mac). The hybrid path hands the Qwen half of a reply the level of the SAME Bot's
 * Kokoro voice, so the handover mid-reply has no step in it. They span 4.9 dB, which is why one
 * global target would not have been good enough.
 */
export const KOKORO_LEVELS: Readonly<Record<string, number>> = {
  af_heart: 0.0545,
  am_michael: 0.0492,
  bf_emma: 0.0684,
  bm_george: 0.0586,
  af_bella: 0.0599,
  am_fenrir: 0.0780,
  af_nicole: 0.0654,
  am_puck: 0.0865,
  bm_fable: 0.0570,
};
/** The mean of the nine, for a line with no Kokoro voice to match against. */
export const KOKORO_LEVEL_DEFAULT = 0.064;

/** The level a Qwen line is held to, given the Bot's Kokoro voice (bare id or "kokoro:<id>"). */
export function targetRmsFor(kokoroVoice: string | null | undefined): number {
  if (typeof kokoroVoice !== "string") return KOKORO_LEVEL_DEFAULT;
  const id = kokoroVoice.startsWith(VOICE_PREFIX.kokoro) ? kokoroVoice.slice(VOICE_PREFIX.kokoro.length) : kokoroVoice;
  return KOKORO_LEVELS[id] ?? KOKORO_LEVEL_DEFAULT;
}

// ---------------------------------------------------------------- the engine choice

export interface EngineChoiceInput {
  /** Qwen is ready to speak this line right now: installed, its probe passed, and the voice mode allows it. */
  qwenReady: boolean;
  /** A Kokoro voice for this Bot exists to fall back to. Without one there is nothing else to say it with. */
  fallback: boolean;
}

export interface EngineChoice { engine: "kokoro" | "qwen" }

/**
 * Which engine says a Qwen Bot's reply.
 *
 * Decision 184: there is no more hybrid opener. It used to open a reply in the Bot's Kokoro voice
 * while Qwen loaded and stream the rest from Qwen, but that switch was a +19 semitone pitch-centre
 * jump in the middle of a reply (bug 182) — worse than the ~0.2-0.3 s a cold Qwen line costs on its
 * own. So the WHOLE reply is Qwen's now, warm or cold, and Kokoro only ever says a WHOLE reply — and
 * only when Qwen is genuinely unavailable: not installed, its probe failed, Light voice mode, or the
 * mode dropped Qwen mid-call. Never a mix inside one reply.
 */
export function chooseEngine(o: EngineChoiceInput): EngineChoice {
  if (!o.qwenReady && o.fallback) return { engine: "kokoro" };
  return { engine: "qwen" };
}

// ---------------------------------------------------------------- discovery

/** The model folder the sidecar can load offline: a config naming this architecture, and weights. */
export function modelDirOk(dir: string, exists: (p: string) => boolean, read?: (p: string) => string): boolean {
  const cfg = path.join(dir, "config.json");
  if (!exists(cfg) || !exists(path.join(dir, "model.safetensors"))) return false;
  if (!read) return true;
  try { return /"model_type"\s*:\s*"qwen3_tts"/.test(read(cfg)); } catch { return false; }
}

export interface QwenPaths { python?: string | null; modelDir?: string | null }

/**
 * Where Qwen lives: the paths saved in settings, then Synapse's own env (<userData>/qwen or the shared
 * …/Synapse/qwen: the "natural voices" pack, voice-packs.ts). Nothing is auto-detected elsewhere.
 *
 * A voice path outside Synapse's own data is deliberately NOT probed: its mlx-audio may be too old
 * to know the qwen3_tts model type, and upgrading it underneath whatever else uses it is not ours to do.
 */
export function findQwen(o: {
  home: string; userData: string; exists(p: string): boolean; listDir(p: string): string[];
  read?(p: string): string; settings?: QwenPaths;
}): KokoroEngine | null {
  const s = o.settings;
  if (s?.python && s.modelDir && o.exists(s.python) && modelDirOk(s.modelDir, o.exists, o.read)) {
    return { python: s.python, modelDir: s.modelDir, source: "settings" };
  }
  // Portable install: the "Natural voices" pack (voice-packs.ts) — its own Python and the model, finished (pack.json).
  for (const d of engineDirs(o.userData, "qwen")) {
    const python = path.join(d, "runtime", "python", "bin", "python3.12");
    const model = path.join(d, "model");
    if (o.exists(python) && o.exists(path.join(d, "pack.json")) && modelDirOk(model, o.exists, o.read)) return { python, modelDir: model, source: "pack" };
  }
  const root = engineDirs(o.userData, "qwen").find((d) => o.exists(path.join(d, ".venv", "bin", "python")));
  if (!root) return null;
  const python = path.join(root, ".venv", "bin", "python");
  const own = path.join(root, "model");
  if (modelDirOk(own, o.exists, o.read)) return { python, modelDir: own, source: "synapse" };
  // Portable install: the Hugging Face cache is never probed. The voice pack (voice-packs.ts) downloads
  // the weights into <root>/model; a model elsewhere is reached only through a path set by hand.
  return null;
}

export function qwenCommand(e: KokoroEngine, script: string, o: { cacheDir?: string; voice?: string } = {}): { cmd: string; args: string[] } {
  const extra = [
    ...(o.cacheDir ? ["--cache-dir", o.cacheDir] : []),
    ...(o.voice && VOICE_IDS.has(o.voice) ? ["--voice", o.voice] : []),
  ];
  return { cmd: "/usr/bin/arch", args: ["-arm64", e.python, "-s", "-E", script, "--model-dir", e.modelDir, ...extra] };
}

/**
 * The import test: mlx-audio is installed AND new enough to know this model type. The version check
 * is the point — 0.2.9 imports perfectly well and then fails the load with "Model type qwen3_tts
 * not supported", which is a far worse thing to discover on the first spoken line.
 */
const PROBE = [
  "import importlib.util as u, importlib.metadata as md, mlx.core",
  "missing=[m for m in ('mlx_audio','numpy') if u.find_spec(m) is None]",
  "assert not missing, 'missing: ' + ', '.join(missing)",
  "v=tuple(int(p) for p in md.version('mlx-audio').split('.')[:3])",
  "assert v >= (0,5,5), 'mlx-audio %s is too old for Qwen3 (needs 0.5.5)' % md.version('mlx-audio')",
  "from mlx_audio.tts.utils import get_model_and_args",
  "get_model_and_args('qwen3_tts', {})",
].join("; ");

export function probeQwen(e: KokoroEngine, o: { spawnFn?: typeof spawn; timeoutMs?: number } = {}): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const started = Date.now();
  return new Promise((resolve) => {
    let err = "";
    let done = false;
    const finish = (r: { ok: boolean; reason?: string }) => { if (!done) { done = true; resolve({ ...r, ms: Date.now() - started }); } };
    let c;
    try {
      c = (o.spawnFn ?? spawn)("/usr/bin/arch", ["-arm64", e.python, "-s", "-E", "-c", PROBE], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (x) {
      return finish({ ok: false, reason: (x as Error).message });
    }
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

// ---------------------------------------------------------------- the service

export type QwenState = "ready" | "missing" | "checking";
export interface QwenStatus { state: QwenState; voices: readonly QwenVoice[]; source?: KokoroEngine["source"]; reason?: string; memoryMb: number }

/** A Qwen synth job: the Kokoro job, plus how good it has to be and what level to hold it at. */
/**
 * No `instruct` on purpose (bug 183): every line gets the sidecar's DEFAULT_INSTRUCT, so the phrase
 * cache's key (voice, speed, text) and the sidecar's per-voice level memory stay exact. Adding one
 * here means adding it to PhraseCache.key too.
 */
export interface QwenJob extends Omit<KokoroJob, "extra"> { quality?: "live" | "full"; targetRms?: number }

export interface QwenTts extends NaturalTts {
  status(): Promise<QwenStatus>;
  dispose(): void;
  /** What it is costing right now: 0 when nothing is loaded. */
  memoryMb(): number;
  /** Unload now (the voice mode changed to Light, or the Mac went short). Safe while idle. */
  unload(): void;
  synthQwen(job: QwenJob, h: KokoroHandlers): void;
  /** A voice pack just finished installing: look again (a missing engine is re-found and re-probed). */
  recheck(): void;
}

export function registerQwen(o: {
  script: string; home: string; userData: string; log: (line: string) => void;
  settings?: () => QwenPaths; spawnFn?: typeof spawn;
  exists?: (p: string) => boolean; listDir?: (p: string) => string[]; read?: (p: string) => string;
  idleMs?: number;
  /** False while the user is on Light voice mode: nothing loads, whatever a Bot is set to. */
  allowed?: () => boolean;
}): QwenTts {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const listDir = o.listDir ?? ((p: string) => { try { return fs.readdirSync(p); } catch { return []; } });
  const read = o.read ?? ((p: string) => fs.readFileSync(p, "utf8"));
  let checked: Promise<QwenStatus> | null = null;
  let current: QwenStatus = { state: "checking", voices: QWEN_VOICES, memoryMb: 0 };
  let sidecar: KokoroSidecar | null = null;

  const allowed = () => o.allowed?.() !== false;
  const memoryMb = () => (sidecar?.isRunning() ? VOICE_ENGINE_MEMORY_MB.qwen : 0);

  const check = (): Promise<QwenStatus> => {
    if (checked) return checked;
    checked = (async () => {
      if (!exists(o.script)) {
        current = { state: "missing", voices: QWEN_VOICES, reason: "The Qwen3 sidecar isn't in this build.", memoryMb: 0 };
        return current;
      }
      const engine = findQwen({ home: o.home, userData: o.userData, exists, listDir, read, settings: o.settings?.() });
      if (!engine) {
        current = { state: "missing", voices: QWEN_VOICES, reason: "No Python with mlx-audio 0.5.5 or newer, and no Qwen3 model, were found.", memoryMb: 0 };
        o.log(`qwen: not found (${current.reason})`);
        return current;
      }
      const p = await probeQwen(engine, { spawnFn: o.spawnFn });
      o.log(`qwen: probe ${p.ok ? "ok" : "failed"} in ${p.ms} ms (${engine.source}: ${engine.python})${p.reason ? `: ${p.reason}` : ""}`);
      if (!p.ok) { current = { state: "missing", voices: QWEN_VOICES, source: engine.source, reason: p.reason, memoryMb: 0 }; return current; }
      sidecar = new KokoroSidecar({
        engine, script: o.script, spawnFn: o.spawnFn, log: o.log, tag: "qwen", idleMs: o.idleMs,
        command: (voice) => qwenCommand(engine, o.script, { cacheDir: path.join(o.userData, "qwen-cache"), voice }),
        voiceOk: (v) => VOICE_IDS.has(v),
        // Never kept hot: 2.1 GB resident is too much to hold for a voice nobody is using.
        keepAlive: () => false,
      });
      current = { state: "ready", voices: QWEN_VOICES, source: engine.source, memoryMb: 0 };
      return current;
    })();
    return checked;
  };

  registerNative("qwen.status", async (a: { refresh?: unknown } | undefined) => {
    if (a?.refresh === true && current.state === "missing") checked = null;
    const s = await check();
    return { ...s, memoryMb: memoryMb() };
  });

  const ids = (voices: unknown[]): string[] =>
    voices.map((v) => (typeof v === "string" ? qwenVoiceId(v) ?? (VOICE_IDS.has(v) ? v : null) : null)).filter((v): v is string => v !== null);

  /** Only a Bot that actually uses a Qwen voice starts it — and only when the mode allows it. */
  const warm = (voices: unknown[] = []): void => {
    const v = ids(voices);
    if (!v.length || !allowed()) return;
    void check().then(() => { if (sidecar) sidecar.start(v[0]); });
  };

  const synthQwen = (job: QwenJob, h: KokoroHandlers): void => {
    const id = qwenVoiceId(job.voice) ?? (VOICE_IDS.has(job.voice) ? job.voice : null);
    if (!id) return h.error("That Qwen3 voice isn't available.");
    if (!allowed()) return h.error("Qwen3 voices need Full voice quality.");
    if (!sidecar) return h.error("The Qwen3 voice isn't available.");
    sidecar.start(id);
    // Quality and level ride along on the same synth command, through KokoroJob's `extra`.
    const extra: Record<string, string | number> = { quality: job.quality ?? "live" };
    if (typeof job.targetRms === "number" && Number.isFinite(job.targetRms)) extra.targetRms = job.targetRms;
    sidecar.synth({ id: job.id, text: job.text, voice: id, speed: job.speed, extra }, h);
  };

  return {
    status: async () => ({ ...(await check()), memoryMb: memoryMb() }),
    isReady: () => current.state === "ready" && sidecar !== null && allowed(),
    isWarm: () => (allowed() ? sidecar?.isWarm() ?? false : false),
    warm: (voices) => warm(voices ?? []),
    busy: () => sidecar?.busy() ?? false,
    whenWarm: async (ms) => { if (!allowed()) return false; await check(); return sidecar ? sidecar.whenWarm(ms) : false; },
    synth: (job, h) => synthQwen(job, h),
    synthQwen,
    cancel: (id) => { if (sidecar?.isRunning()) sidecar.cancel(id); },
    memoryMb,
    unload: () => { if (sidecar?.isRunning() && !sidecar.busy()) sidecar.dispose(); },
    recheck: () => { if (current.state === "missing") checked = null; },
    dispose: () => sidecar?.dispose(),
  };
}
