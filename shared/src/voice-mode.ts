/**
 * Voice mode: one segmented control in Settings → Voice that decides how much of the machine the
 * voice stack is allowed to use (bug 164).
 *
 *   LIGHT  Kokoro for speech, Apple's recognizer for listening. Nothing else loads.
 *   FULL   Qwen3-TTS for speech (with Kokoro speaking the first sentence), Whisper re-transcribing
 *          on top of Apple's live recognition, and cloned voices available.
 *
 * It exists because the alternative was a row of independent toggles — keep Kokoro hot, use Qwen,
 * use Whisper, allow clones — each of which is a memory decision the user would have to price for
 * themselves. One control, two honest numbers under it.
 *
 * The mode decides what may LOAD. A Bot's own voice choice is untouched by it: a Bot set to a Qwen
 * or cloned voice under Light keeps that setting, says so plainly in its settings, and speaks in
 * Kokoro until Full is chosen (`voiceBlockedByMode`).
 *
 * This module is deliberately dependency-free arithmetic and naming, because both the TTS side and
 * the speech-recognition side read it.
 */

export type VoiceMode = "light" | "full";
export const VOICE_MODES: readonly VoiceMode[] = ["light", "full"];

export function isVoiceMode(v: unknown): v is VoiceMode {
  return v === "light" || v === "full";
}

const GiB = 1024 ** 3;

/**
 * What each engine costs while it is loaded, in MB. Measured resident set on the owner's Mac, not
 * estimated from the weight files — an 8-bit 0.6B model whose weights are 1.8 GB on disk sits at
 * about 2.1 GB resident once MLX has its buffers.
 */
export const VOICE_ENGINE_MEMORY_MB = {
  /** A warm Kokoro sidecar (bug 134). */
  kokoro: 800,
  /** A loaded Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit sidecar (bug 164). */
  qwen: 2100,
  /** F5, cloned voices (bug 163). Loaded only when a Bot actually uses a cloned voice. */
  f5: 1400,
  /** Whisper re-transcription. Owned by the speech-recognition side; it sets this number. */
  whisper: 1100,
} as const;

/**
 * What the control says, in memory and in time to the first word. Both numbers are measured, and
 * both are what the user actually experiences: the first-word figure is the wall-clock gap between
 * the reply's first text and its first audio, which under Full is Kokoro's, because Kokoro speaks
 * the opening sentence while Qwen renders the rest.
 */
export const VOICE_MODE_FACTS = {
  light: {
    memoryMb: VOICE_ENGINE_MEMORY_MB.kokoro,
    firstWordMs: 160,
  },
  full: {
    // Kokoro stays loaded under Full: it speaks every reply's first sentence.
    memoryMb: VOICE_ENGINE_MEMORY_MB.kokoro + VOICE_ENGINE_MEMORY_MB.qwen + VOICE_ENGINE_MEMORY_MB.whisper,
    firstWordMs: 160,
  },
} as const;

/** A Mac with this much memory or less gets Light by default. */
export const VOICE_MODE_FULL_MIN_TOTAL_BYTES = 16 * GiB;
/** …and even on a bigger Mac, Full is not the default if this little is free when first asked. */
export const VOICE_MODE_FULL_MIN_FREE_BYTES = 6 * GiB;
/** Free memory this low during a call drops it to Light for the rest of the call. */
export const VOICE_MODE_LOW_FREE_BYTES = 1.5 * GiB;

/**
 * The mode a machine starts on, before the user has ever chosen. Light on 16 GB or less, Light when
 * memory is already tight, Full otherwise. The user can always override, and their choice sticks —
 * this is only consulted when nothing has been saved.
 */
export function defaultVoiceMode(o: { totalBytes: number; freeBytes: number }): VoiceMode {
  if (!Number.isFinite(o.totalBytes) || o.totalBytes <= 0) return "light"; // unreadable: assume small
  if (o.totalBytes <= VOICE_MODE_FULL_MIN_TOTAL_BYTES) return "light";
  if (Number.isFinite(o.freeBytes) && o.freeBytes < VOICE_MODE_FULL_MIN_FREE_BYTES) return "light";
  return "full";
}

/** The saved choice if there is one, otherwise the machine's default. */
export function resolveVoiceMode(saved: unknown, machine: { totalBytes: number; freeBytes: number }): VoiceMode {
  return isVoiceMode(saved) ? saved : defaultVoiceMode(machine);
}

/**
 * Memory macOS can hand out right now, from `vm_stat` output: free + inactive + speculative +
 * purgeable pages. Node's os.freemem() is only the "free" line, which macOS keeps low on purpose
 * (spare memory becomes cache), so it read ~1 GB on a 32 GB Mac with 9 GB reclaimable and dropped
 * every call to Light. Null when the output can't be read; the caller falls back to os.freemem().
 */
export function availableFromVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text)?.[1] ?? 0);
  const free = /^Pages free:/m.test(text);
  if (!free) return null;
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * Number(size[1]);
}

/** Mid-call: memory has gone tight enough that Full must give way for the rest of this call. */
export function shouldDropToLight(mode: VoiceMode, freeBytes: number): boolean {
  return mode === "full" && Number.isFinite(freeBytes) && freeBytes < VOICE_MODE_LOW_FREE_BYTES;
}

// ---------------------------------------------------------------- voices and modes

export type VoiceEngine = "kokoro" | "qwen" | "f5" | "apple";

/**
 * What a saved voice value is prefixed with, per engine. The one definition: main/native/kokoro.ts,
 * f5.ts and qwen.ts each re-export their own from here rather than spelling the string again.
 */
export const VOICE_PREFIX = { kokoro: "kokoro:", qwen: "qwen3:", f5: "f5:" } as const;

/** Which engine a saved voice value names. An unprefixed value is an Apple voice identifier. */
export function engineOfVoice(voice: unknown): VoiceEngine | null {
  if (typeof voice !== "string" || !voice) return null;
  if (voice.startsWith(VOICE_PREFIX.qwen)) return "qwen";
  if (voice.startsWith(VOICE_PREFIX.kokoro)) return "kokoro";
  if (voice.startsWith(VOICE_PREFIX.f5)) return "f5";
  return "apple";
}

/** The engines a mode is allowed to load. Apple's voice is always available (it costs nothing). */
export function enginesInMode(mode: VoiceMode): readonly VoiceEngine[] {
  return mode === "full" ? ["kokoro", "qwen", "f5", "apple"] : ["kokoro", "apple"];
}

/**
 * True when this Bot's saved voice cannot be used in this mode — the setting is kept and the Bot's
 * settings say so, but the reply speaks in Kokoro until Full is chosen.
 */
export function voiceBlockedByMode(voice: unknown, mode: VoiceMode): boolean {
  const e = engineOfVoice(voice);
  return e !== null && !enginesInMode(mode).includes(e);
}
