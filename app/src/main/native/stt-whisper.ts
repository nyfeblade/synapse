import fs from "node:fs";
import path from "node:path";
import { engineDirs } from "../profile";

// Bug 165: whisper.cpp re-transcribes each finished utterance; Apple keeps the live partials.
//
// This module decides ONE thing: whether the helper is told to load whisper, and from where. It
// holds no model and spawns nothing — the helper owns the engine, because the PCM it would have to
// send is already in the helper's hands.
//
// The setting it obeys is Settings → Voice's mode, which the TTS side owns: LIGHT is Kokoro speech
// and Apple recognition, and whisper is not loaded at all — no file is read, no memory is held, and
// the helper is launched without a single whisper argument. FULL is the mode whisper belongs to.
// There is deliberately no second "extra-accurate transcription" toggle: two switches for one
// behaviour is how a setting gets left in a state nobody meant.

/** Where whisper lives: the profile's own folder if it has one, else the shared one install.sh builds (bug 167). */
export function whisperRoot(userData: string): string {
  const dirs = engineDirs(userData, "whisper");
  return dirs.find((d) => fs.existsSync(d)) ?? dirs[dirs.length - 1];
}

/** The voice mode Settings → Voice is in. Anything that is not "full" is treated as light. */
export type VoiceMode = "light" | "full";

export interface WhisperStatus {
  /** "ready" | "light" (the mode does not use it) | "no-model" | "no-build" */
  state: "ready" | "light" | "no-model" | "no-build";
  /** The model file the helper would load, when there is one. */
  model: string | null;
  /** Which weights are installed, e.g. "large-v3-turbo-q5_0". */
  name: string | null;
  /** Bytes on disk, for the factual line in Settings. */
  bytes: number;
}

/** The name of the installed weights, as install.sh recorded it (falling back to what is on disk). */
function installedName(root: string): string | null {
  try {
    const recorded = fs.readFileSync(path.join(root, "model"), "utf8").trim();
    if (recorded && fs.statSync(path.join(root, "models", `ggml-${recorded}.bin`)).size > 0) return recorded;
  } catch { /* fall through to the directory */ }
  try {
    // Largest first: if both the turbo model and the small.en fallback are there, the better one wins.
    const files = fs.readdirSync(path.join(root, "models"))
      .filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
      .map((f) => ({ f, size: (() => { try { return fs.statSync(path.join(root, "models", f)).size; } catch { return 0; } })() }))
      .filter(({ size }) => size > 0)
      .sort((a, b) => b.size - a.size);
    return files.length ? files[0].f.slice("ggml-".length, -".bin".length) : null;
  } catch {
    return null;
  }
}

/**
 * What Settings → Voice should say, and what `helperWhisperArgs` will do.
 *
 * `builtIn` is whether the helper itself was compiled with whisper — the build links it only when
 * the libraries are present, so a helper built on a machine that never ran install.sh has no
 * whisper in it and must say "no-build" rather than silently doing nothing.
 */
export function whisperStatus(o: { userData: string; mode: VoiceMode; builtIn: boolean }): WhisperStatus {
  if (o.mode !== "full") return { state: "light", model: null, name: null, bytes: 0 };
  const root = whisperRoot(o.userData);
  if (!o.builtIn) return { state: "no-build", model: null, name: null, bytes: 0 };
  const name = installedName(root);
  if (!name) return { state: "no-model", model: null, name: null, bytes: 0 };
  const model = path.join(root, "models", `ggml-${name}.bin`);
  let bytes = 0;
  try { bytes = fs.statSync(model).size; } catch { return { state: "no-model", model: null, name: null, bytes: 0 }; }
  return { state: "ready", model, name, bytes };
}

/** Whether this helper binary has whisper linked into it (`build.sh` only links it when it is there). */
export function helperHasWhisper(binary: string): boolean {
  try {
    // The symbol is in the binary's string table when the static library was linked in. Reading the
    // file is cheap next to spawning it, and this is called on a settings screen, not per utterance.
    return fs.readFileSync(binary).includes("whisper_init_from_file_with_params");
  } catch {
    return false;
  }
}

/**
 * How long whisper may take on one utterance before the turn keeps Apple's text (measured: bug 165).
 * Bug 185: this is the BASE, for anything up to 5 s of audio — the helper grows it with the audio
 * (`whisperBudgetMs`), because a flat 900 ms aborted every turn longer than ~22 s and the user got
 * Apple's worse text for exactly the speeches that most needed whisper.
 */
export const WHISPER_BUDGET_MS = 900;

// Bug 185: mirrors of the helper's `WhisperLimit` (a test reads Dictation.swift so they cannot drift).
/** Seconds of audio the base budget covers. */
export const WHISPER_BUDGET_FREE_SECONDS = 5;
/** Budget added per second of audio past that: whisper measured 29 ms/s here (4 s 462 ms → 28 s 1132 ms), so twice that. */
export const WHISPER_BUDGET_PER_SECOND_MS = 60;
/** No single pass may take longer than this, however long the audio. */
export const WHISPER_MAX_BUDGET_MS = 6_000;
/** A long turn reaches whisper in chunks of at most this many seconds (one 30 s window, with room). */
export const WHISPER_CHUNK_SECONDS = 28;
/** A chunk transcribed while the user is still talking gets this many times the budget. */
export const WHISPER_BACKGROUND_BUDGET_FACTOR = 2;
/** Apple's final after `stop` — the helper's own deadline for it (`finishUtterance`). */
const APPLE_FINAL_WAIT_MS = 2_000;

/** The budget the helper gives one whisper pass over `seconds` of audio. */
export function whisperBudgetMs(seconds: number, baseMs = WHISPER_BUDGET_MS): number {
  const extra = Math.max(0, seconds - WHISPER_BUDGET_FREE_SECONDS) * WHISPER_BUDGET_PER_SECOND_MS;
  return Math.min(WHISPER_MAX_BUDGET_MS, Math.max(baseMs, baseMs + extra));
}

/**
 * How much longer than usual a stop may take when whisper is on (bug 185): Apple's last final, then
 * at worst a chunk already running (background budget) and the tail after it (plain budget), each
 * twice if whisper looped and the pass was run again over the full window (see the helper). The app used
 * to SIGTERM every helper 2 s after "stop", which is shorter than that — a long dictation's last
 * sentence would have been killed on its way out. ASSUMES at most one chunk is in flight when the
 * user stops: chunks are handed over every ~28 s and take ~1.1 s (measured), so the queue is empty
 * again long before the next one; a Mac too slow for that would wait past this and lose the final.
 */
export const WHISPER_STOP_WAIT_MS = APPLE_FINAL_WAIT_MS
  + 2 * WHISPER_BACKGROUND_BUDGET_FACTOR * whisperBudgetMs(WHISPER_CHUNK_SECONDS) // the chunk in flight
  + 2 * whisperBudgetMs(WHISPER_CHUNK_SECONDS); // the tail

/**
 * The helper arguments for a session. An empty array is the whole of "whisper off": the helper
 * loads nothing, keeps not one sample of PCM, and behaves exactly as it did before bug 165.
 *
 * `dictationOnly` is the one finer choice Full mode has — whisper on the composer mic but not in a
 * live call, where the added latency lands between a person finishing a sentence and a Bot starting
 * to answer rather than between typing and seeing the words.
 */
export function helperWhisperArgs(o: {
  status: WhisperStatus;
  mode: "dictation" | "call";
  dictationOnly: boolean;
  budgetMs?: number;
}): string[] {
  if (o.status.state !== "ready" || !o.status.model) return [];
  if (o.dictationOnly && o.mode === "call") return [];
  return ["--whisper-model", o.status.model, "--whisper-budget-ms", String(o.budgetMs ?? WHISPER_BUDGET_MS)];
}

/** The weights, best first. The fallback is a tenth of the size and noticeably worse; it exists so
 *  a Mac that cannot fetch 574 MB still gets something, not because anyone would choose it. */
export const WHISPER_MODELS = [
  { name: "large-v3-turbo-q5_0", bytes: 574_041_195 },
  { name: "small.en", bytes: 487_601_967 },
] as const;

export function modelUrl(name: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
}

export type DownloadProgress = { state: "downloading"; received: number; total: number } | { state: "ready"; name: string } | { state: "failed"; message: string };

/**
 * Fetch the weights into Synapse's own directory, reporting bytes as they land so the button can
 * show a real bar rather than a spinner. Written to `.part` and renamed only when complete, so an
 * interrupted download can never be mistaken for a model.
 *
 * The better model is tried first and the smaller one is the fallback — but a fallback is REPORTED,
 * never silent: the caller passes it to the same `onProgress` and Settings says which one is there.
 */
export async function downloadModel(o: {
  userData: string;
  onProgress: (p: DownloadProgress) => void;
  fetchFn?: typeof fetch;
  models?: readonly { name: string; bytes: number }[];
}): Promise<string | null> {
  const dir = path.join(whisperRoot(o.userData), "models");
  const doFetch = o.fetchFn ?? fetch;
  let lastError = "";
  for (const m of o.models ?? WHISPER_MODELS) {
    const dest = path.join(dir, `ggml-${m.name}.bin`);
    const part = `${dest}.part`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const res = await doFetch(modelUrl(m.name));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? m.bytes) || m.bytes;
      const out = fs.createWriteStream(part);
      let received = 0;
      let announced = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        // Every 2 MB, not every chunk: a 574 MB download is ~35 000 chunks and the renderer does
        // not need 35 000 repaints to show a bar moving.
        if (received - announced >= 2_000_000) { announced = received; o.onProgress({ state: "downloading", received, total }); }
      }
      await new Promise<void>((r, j) => out.end((e: unknown) => (e ? j(e) : r())));
      if (fs.statSync(part).size < total * 0.9) throw new Error("the download ended early");
      fs.renameSync(part, dest);
      fs.writeFileSync(path.join(whisperRoot(o.userData), "model"), m.name, "utf8");
      o.onProgress({ state: "ready", name: m.name });
      return m.name;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      try { fs.unlinkSync(part); } catch { /* never written */ }
    }
  }
  o.onProgress({ state: "failed", message: lastError || "the download failed" });
  return null;
}

/** "574 MB" — the factual line in Settings, not a rounded-up marketing number. */
export function humanBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
