/**
 * Every tunable number behind the app's two call sounds. Plain data, nothing else — so the render
 * script (app/scripts/render-call-sounds.ts) can produce the exact same samples the app plays,
 * without pulling in Web Audio or Electron.
 *
 * Both are original tones written for this app's own taste (smooth, calm, warm) — soft rounded
 * notes, gentle attack and release, never a hard edge. Neither is modeled on, or copies, any other
 * product's ringtone or call sound.
 */

/** A soft "chirp": each note in `notes`, in order, `noteMs` long with `noteGapMs` of silence between. */
export interface ChirpSpec {
  /** Hz, in the order they play. */
  readonly notes: readonly number[];
  readonly noteMs: number;
  readonly noteGapMs: number;
  /** Well below a Bot's speech (1.0 = full scale). */
  readonly peakGain: number;
  readonly attackMs: number;
  readonly releaseMs: number;
}

export interface RingSpec extends ChirpSpec {
  /** One "ring" burst (the chirp padded with silence up to this length). */
  readonly patternMs: number;
  /** Silence between one ring and the next — the phone-like cadence. */
  readonly pauseMs: number;
  /** The very first ring fades in rather than starting sharp. */
  readonly firstFadeInMs: number;
  /** Answered, declined, timed out, or withdrawn: how fast the ring fades out (never a hard cut). */
  readonly stopFadeMs: number;
}

/** A soft rounded fifth-ish rise (C5 → E5, a major third), repeating in a phone-like cadence. */
export const RING_TONE: RingSpec = {
  notes: [523.25, 659.25],
  noteMs: 150,
  noteGapMs: 90,
  peakGain: 0.05,
  attackMs: 18,
  releaseMs: 160,
  patternMs: 1200,
  pauseMs: 2500,
  firstFadeInMs: 220,
  stopFadeMs: 60,
} as const;

/** A short descending pair (C5 → F4) — the opposite motion of the ring's rise. */
export const HANGUP_TONE: ChirpSpec = {
  notes: [523.25, 349.23],
  noteMs: 120,
  noteGapMs: 20,
  peakGain: 0.05,
  attackMs: 6,
  releaseMs: 110,
} as const;
