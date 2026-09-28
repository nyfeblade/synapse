/**
 * Voice cloning (F5): the reference clip's recording scripts, the quality bar a take
 * must clear, and the pure checks that decide it.
 *
 * A cloned voice is F5-TTS conditioned on ~7-10 s of the user's own speech plus that
 * speech's exact transcript. Both halves matter: a transcript that does not match the
 * audio word for word is the main cause of a bad clone, so the recorder offers a known
 * script and pre-fills the transcript from it.
 *
 * Nothing here touches the filesystem or Electron, so the app, the host and the tests
 * all run the same code.
 */

/** 24 kHz mono is what F5 conditions on and what the Swift helper plays; never resample up to it. */
export const CLIP_SAMPLE_RATE = 24_000;

/** The window a take must land in. Below ~6 s there is too little voice to carry resonance; above ~12 s F5's duration estimator starts to slur. */
export const CLIP_MIN_S = 6;
export const CLIP_MAX_S = 12;
/** The window the recorder marks as "good" while the level meter runs. */
export const CLIP_TARGET_MIN_S = 7;
export const CLIP_TARGET_MAX_S = 10;

/** One take's measured numbers. Every field is linear amplitude or seconds unless named otherwise. */
export interface ClipMeasure {
  seconds: number;
  /** Largest absolute sample. 1.0 means the converter ran out of headroom. */
  peak: number;
  /** Whole-clip RMS. */
  rms: number;
  /** Quietest 200 ms, as RMS — the noise floor estimate. */
  noiseRms: number;
  /** Speech RMS over the noise floor, in dB. */
  snrDb: number;
  /** Mean sample value; a non-zero mean is a DC offset. */
  dcOffset: number;
  /** Samples at or above 0.999, i.e. clipped. */
  clippedSamples: number;
  /** The longest silence strictly inside the clip, in ms. */
  longestGapMs: number;
}

export type ClipCheckId =
  | "length" | "clipping" | "level" | "noise" | "dc" | "gaps" | "transcript";

export interface ClipCheck {
  id: ClipCheckId;
  /** A pass/fail mark, not a paragraph. */
  label: string;
  pass: boolean;
  /** Shown only when it fails: what to do about it. */
  detail?: string;
}

/** The thresholds a take is judged against. Named so a failure can quote the number it missed. */
export const CLIP_BAR = {
  minSeconds: CLIP_MIN_S,
  maxSeconds: CLIP_MAX_S,
  /** Above this the take is clipping. */
  peakMax: 0.99,
  /** A take quieter than this has too little signal to clone from. */
  peakMin: 0.08,
  /** Speech must sit this far above the noise floor. */
  snrDbMin: 25,
  /** A DC offset larger than this pulls the waveform off centre. */
  dcMax: 0.01,
  /** A pause longer than this inside the clip wastes the window. */
  maxGapMs: 700,
  /** Word-count difference the transcript check tolerates before it asks. */
  wordSlack: 0,
} as const;

// ---------------------------------------------------------------- measuring

const BLOCK_MS = 10;

function rmsOf(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  const n = Math.max(1, to - from);
  return Math.sqrt(s / n);
}

/**
 * Measure a take. `x` is mono float32 at `sampleRate`.
 *
 * The noise floor is the quietest 200 ms anywhere in the clip, which is where the room
 * shows through; comparing it with the speech RMS is a better guide to a usable clip
 * than either number alone.
 */
export function measureClip(x: Float32Array, sampleRate = CLIP_SAMPLE_RATE): ClipMeasure {
  const n = x.length;
  const seconds = n / sampleRate;
  let peak = 0;
  let sum = 0;
  let sq = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += v;
    sq += v * v;
  }
  const rms = Math.sqrt(sq / Math.max(1, n));
  const dcOffset = n ? sum / n : 0;

  // quietest 200 ms
  const win = Math.max(1, Math.round((sampleRate * 200) / 1000));
  let noiseRms = rms;
  if (n > win) {
    const step = Math.max(1, Math.round((sampleRate * 20) / 1000));
    noiseRms = Infinity;
    for (let i = 0; i + win <= n; i += step) {
      const r = rmsOf(x, i, i + win);
      if (r < noiseRms) noiseRms = r;
    }
    if (!Number.isFinite(noiseRms)) noiseRms = rms;
  }
  const snrDb = 20 * Math.log10((rms + 1e-9) / (noiseRms + 1e-9));

  // longest interior silence, measured in 10 ms blocks against a gate under the peak
  const block = Math.max(1, Math.round((sampleRate * BLOCK_MS) / 1000));
  const gate = Math.max(peak * 0.04, noiseRms * 2, 0.003);
  const loud: boolean[] = [];
  for (let i = 0; i + block <= n; i += block) loud.push(rmsOf(x, i, i + block) >= gate);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  let longestGapMs = 0;
  if (first >= 0 && last > first) {
    let run = 0;
    for (let i = first; i <= last; i++) {
      if (loud[i]) { run = 0; continue; }
      run++;
      longestGapMs = Math.max(longestGapMs, run * BLOCK_MS);
    }
  }

  return { seconds, peak, rms, noiseRms, snrDb, dcOffset, clippedSamples: clipped, longestGapMs };
}

// ---------------------------------------------------------------- judging

/** Turn a measurement into the pass/fail marks shown beside the take. */
export function checkClip(m: ClipMeasure): ClipCheck[] {
  const out: ClipCheck[] = [];
  const secs = m.seconds.toFixed(1);

  out.push(
    m.seconds < CLIP_BAR.minSeconds
      ? { id: "length", label: "Length", pass: false, detail: `${secs}s is too short — aim for ${CLIP_TARGET_MIN_S}–${CLIP_TARGET_MAX_S}s.` }
      : m.seconds > CLIP_BAR.maxSeconds
        ? { id: "length", label: "Length", pass: false, detail: `${secs}s is too long — aim for ${CLIP_TARGET_MIN_S}–${CLIP_TARGET_MAX_S}s.` }
        : { id: "length", label: "Length", pass: true },
  );

  out.push(
    m.peak > CLIP_BAR.peakMax || m.clippedSamples > 0
      ? { id: "clipping", label: "No clipping", pass: false, detail: "The take is too loud and the peaks are squared off. Move back from the mic or turn the input down." }
      : { id: "clipping", label: "No clipping", pass: true },
  );

  out.push(
    m.peak < CLIP_BAR.peakMin
      ? { id: "level", label: "Level", pass: false, detail: "Too quiet. Sit 6–12 inches from the mic and speak at a normal volume." }
      : { id: "level", label: "Level", pass: true },
  );

  out.push(
    m.snrDb < CLIP_BAR.snrDbMin
      ? { id: "noise", label: "Quiet room", pass: false, detail: `The room is too loud behind your voice (${m.snrDb.toFixed(0)} dB of separation, ${CLIP_BAR.snrDbMin} needed). Try a quieter room.` }
      : { id: "noise", label: "Quiet room", pass: true },
  );

  out.push(
    Math.abs(m.dcOffset) > CLIP_BAR.dcMax
      ? { id: "dc", label: "Centred", pass: false, detail: "The waveform is off centre (a DC offset). Try a different microphone or input." }
      : { id: "dc", label: "Centred", pass: true },
  );

  out.push(
    m.longestGapMs > CLIP_BAR.maxGapMs
      ? { id: "gaps", label: "No long pauses", pass: false, detail: `There is a ${(m.longestGapMs / 1000).toFixed(1)}s pause in the middle. Read it straight through.` }
      : { id: "gaps", label: "No long pauses", pass: true },
  );

  return out;
}

export function clipPasses(checks: readonly ClipCheck[]): boolean {
  return checks.every((c) => c.pass);
}

// ---------------------------------------------------------------- transcript

/** Words as the transcript check compares them: lower case, no punctuation. */
export function clipWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface TranscriptCheck extends ClipCheck {
  id: "transcript";
  /** Words in the script that the take seems to have missed. */
  missing: string[];
  /** Words heard that the script does not contain. */
  extra: string[];
}

/**
 * Compare what the user was asked to read with what our STT heard.
 *
 * A mismatch does not block saving — the user may simply have said it their own way —
 * but it is the single best predictor of a poor clone, so it is always shown.
 */
export function checkTranscript(script: string, heard: string): TranscriptCheck {
  const want = clipWords(script);
  const got = clipWords(heard);
  const pool = [...got];
  const missing: string[] = [];
  for (const w of want) {
    const i = pool.indexOf(w);
    if (i >= 0) pool.splice(i, 1);
    else missing.push(w);
  }
  const back = [...want];
  const extra: string[] = [];
  for (const w of got) {
    const i = back.indexOf(w);
    if (i >= 0) back.splice(i, 1);
    else extra.push(w);
  }
  const off = missing.length + extra.length;
  const pass = off <= CLIP_BAR.wordSlack;
  return {
    id: "transcript",
    label: "Matches the script",
    pass,
    missing,
    extra,
    detail: pass
      ? undefined
      : `What you said differs from the script by ${off} word${off === 1 ? "" : "s"}. Retake it, or choose “I said it differently” and correct the text.`,
  };
}

// ---------------------------------------------------------------- scripts

export interface CloneScript {
  id: string;
  /** The tone this script is for, shown as the choice. */
  tone: string;
  /** Read verbatim; this exact text becomes the reference transcript. */
  text: string;
  /** Roughly how long it takes at a normal pace. */
  about: string;
}

/**
 * The sentences offered in the recorder, option 1 preselected.
 *
 * Each runs 7-10 s at a normal pace and spreads the sounds a clone needs — hard
 * consonants, sibilants, liquids and open vowels — with natural punctuation and no
 * proper nouns people stumble over. The default asks a question as well as stating
 * something, so the clone hears both the user's falling and rising inflection.
 *
 * The chosen text is stored as the reference transcript character for character,
 * commas, apostrophes and question mark included.
 */
export const CLONE_SCRIPTS: readonly CloneScript[] = [
  {
    id: "asks",
    tone: "Natural, with a question (recommended)",
    text: "Honestly, is it going to rain later today, or should I grab a quick coffee and take a walk outside?",
    about: "about 8 seconds",
  },
  {
    id: "allrounder",
    tone: "Natural all-rounder",
    text: "Honestly, the weather today is surprisingly crisp and clear, so I might just grab a hot coffee and take a quick walk outside.",
    about: "about 7–8 seconds",
  },
  {
    id: "tech",
    tone: "High-energy, tech narrator",
    text: "If you configure the local parameters correctly, the entire system processes data almost instantly without lagging!",
    about: "about 6–7 seconds",
  },
  {
    id: "story",
    tone: "Calm storyteller",
    text: "Late in the evening, as the room grew quiet, he finally sat down at his desk and opened the ancient leather notebook.",
    about: "about 8–9 seconds",
  },
];

export const DEFAULT_CLONE_SCRIPT = CLONE_SCRIPTS[0];

/** Short lines shown next to the record button — guidance, not paragraphs. */
export const CLONE_TIPS: readonly string[] = [
  "Sit 6–12 inches from the microphone.",
  "A quiet room, no echo.",
  "Normal volume and pace — don’t over-enunciate.",
  "Ask the question the way you’d ask a friend; don’t exaggerate the rise.",
  "Pause where the punctuation is.",
];

/**
 * The rights note shown wherever a clip is recorded or imported.
 * Synapse never ships a voice it did not record here.
 */
export const CLONE_RIGHTS_NOTE =
  "Only record your own voice, or a voice you have the speaker’s permission to use. Clips stay on this Mac.";
