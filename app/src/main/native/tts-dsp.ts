/**
 * Bug 161: every sample the natural voice plays passes through here, and nothing in this file knows
 * about Electron, the sidecar or the helper — it is plain PCM in, plain PCM out, so the offline
 * harness (app/look/tts-glitch.mjs) drives exactly the code the app runs.
 *
 * Kokoro speaks at 24 kHz mono float32; the helper's player resamples that to 48 kHz.
 */

export interface KokoroDone { synthMs: number; audioMs: number; rtf: number; firstMs: number }
export interface KokoroHandlers { audio(pcm: Buffer, seq: number): void; done(info: KokoroDone): void; error(message: string): void }

// ---- prosody: making a question SOUND like one (app/look/prosody.py measured it) ----
/**
 * Bug 151: Kokoro does not ask questions. The punctuation is not lost on the way in — misaki hands the
 * model "jˌu wˈɑnt mˌi tə sˈɛnd ɪt?" against "…ɪt." — the 82M model simply renders both the same way.
 * Measured over the nine curated voices at speeds 0.95 / 1.0 / 1.05 ("You want me to send it." vs "?"):
 * the question's final syllable ends a median 0.27 semitones from the statement's (inaudible; the
 * just-noticeable difference in running speech is about a semitone), and it FALLS in six of the nine
 * voices, is flat in three, and rises in none. Phoneme-level control was tried first and is not a fix:
 * the vocab does carry the IPA intonation arrows (↓→↗↘), and "…sˈɛnd ↗ɪt?" does lift af_heart's final
 * syllable by 2 st, but it does nothing at all for am_michael or bm_george — the model was never
 * trained on them for English. So we do it ourselves, on the PCM, behind a flag.
 *
 * The ramp is a resample-in-place over the last `rampMs` of VOICED speech: the tail is read back at a
 * rate rising to 2^(semitones/12), so there is no phase break and nothing to warble. Two details the
 * measurements forced:
 *   - it must end at the end of the last VOICED region, not of the audio. Kokoro pads a median 575 ms
 *     of silence after the words, and "send it?" then ends in an unvoiced /t/ plus breath; ramping to
 *     the end of the buffer put the whole rise where there is no pitch to hear (+0.2 st, not +2).
 *   - the rate reaches full lift at 70% of the window and HOLDS, so the slack in `voicedEnd` (0-160 ms
 *     against a full F0 track) still lands the vowel on the plateau.
 * Proven on this Mac: +1.70 st mean, +1.84 st median, over 51 voice x speed x case measurements.
 */
export interface Prosody {
  /** Off: no ramp. With `trimSilence` off too, the PCM reaches the helper byte for byte. */
  questionRamp: boolean;
  /**
   * How far the end of a question lifts. Swept on this Mac over the nine curated voices, measuring both
   * the lift and how much rougher the ramp makes the waveform (biggest sample-to-sample step against the
   * original's own, over the same window):
   *   2 st → +14 Hz median, roughness 0.96-1.02     4 st → +28 Hz median, roughness 0.98-1.39
   *   3 st → +19 Hz median, roughness 0.98-1.11     5 st → +34 Hz median, roughness 1.05-1.89
   * 4 is the pick: it sits inside the rise Apple's own asking voices make (+4.9 to +7.9 st within the
   * final syllable, measured) and still leaves the waveform under 1.4x its own roughness. 5 reaches
   * further but nearly doubles it, which is where a resample ramp starts to warble.
   */
  semitones: number;
  /** The window, in ms of voiced speech, the lift is spread over. */
  rampMs: number;
  /**
   * Off: Kokoro's own padding is passed on as-is. On: the silence gate below drops the 200-390 ms of
   * lead and 250-730 ms of tail it pads every chunk with, and caps a mid-line gap at `maxGapMs`.
   */
  trimSilence: boolean;
  /** The longest silence allowed INSIDE a chunk. The pauses BETWEEN chunks are the renderer's, not ours. */
  maxGapMs: number;
  /**
   * Bug 166: how much of the model's OWN trailing silence to keep on the end of a chunk.
   *
   * Kokoro wants 0: its 250-730 ms of pad says nothing, and the beat between lines is the renderer's
   * to place. (Bug 180: the word's own 25-60 ms decay into that pad is still kept — the gate always
   * keeps a line's tail until it has fallen 55 dB, whatever this is.) Qwen does not — it renders the sentence-final fall, the
   * breath after it and the pause it would have left inside a longer render, and cutting all of that
   * off at the last sample above the gate is what made a chunk end sound clipped and the join sound
   * like a new take. Keeping it (and then adding almost nothing, QWEN_PAUSE_MS) is what makes two
   * consecutive renders sound like one person carrying on.
   *
   * It is a CAP, not a pad: a chunk with less tail than this keeps what it has, and nothing is
   * invented. The closing fade then lands inside kept silence instead of on the last phoneme.
   */
  tailMs: number;
}
/**
 * Bug 161: what "clean" means for the audio this file hands the helper, in one place, so the tests and
 * the offline bench (app/look/tts-glitch.mjs) hold it to the same bar. The ramp is only allowed to be
 * on by default while every one of these holds on every curated voice.
 *   stepRatio   the biggest sample-to-sample step the ramp window may add, against the SAME window of
 *               the same line with the ramp off. Speech steps hard at a plosive on its own; what a
 *               click sounds like is a step that is bigger than the audio around it already is.
 *               Steps under -40 dBFS are scored as no defect whatever they are a multiple of.
 *   clickRatio  the same idea sharpened: the worst step measured against the median step of the 10 ms
 *               either side of it, ramp against no-ramp.
 *   median*      the same two across every line of the bench, which is what real audio is held to.
 *   thdDb       the ramp's interpolator on a steady tone, THD+N in the plateau. The shipped ramp read
 *               between samples with a straight line and measured -8.6 dB at 9 kHz — a buzz, which is
 *               what "glitching a little" was.
 *   edgeSample  the first and last sample of a spoken chunk, where the helper butts the line up
 *               against the pause silence. Anything but ~0 there steps, and it ticks once a sentence.
 *   liftSt      a question must actually end higher than the same line without the ramp.
 *   holeDb      the one the step metrics were blind to. The ramp WRITES the last rampMs but READS
 *               about 60 ms further back, and nothing stopped that read reaching across a pause: it
 *               grafted the pause into the middle of the last word and the level fell up to 36 dB for
 *               20 ms. Measured as the quietest 10 ms of the ramped window against that window\'s own
 *               median level, less the same figure with the ramp off — how much deeper a hole the
 *               ramp dug than the line already had.
 *
 * Every bound is set from the bench (app/look/tts-glitch.mjs, 36 question lines across the nine
 * curated voices), run with --compare so both code paths are scored on the SAME synthesis.
 *
 * WHICH OF THESE THE BENCH GATES ON, AND WHY IT IS NOT ALL OF THEM. Kokoro is not bit-deterministic:
 * the same text rendered twice differs, so the WORST single line of a ratio swings between runs (the
 * shipped build's worst window step measured 1.56 on one run and 5.12 on the next, from the same code
 * on the same text). Worse, the outliers that remain show up in BOTH builds at nearly the same value
 * — question/af_heart's worst click is 2.35 here and 2.22 on the shipped ramp — which says they are
 * Kokoro's own content landing inside the window, not something the ramp did. So on real audio the
 * bench gates on the measures that are stable AND actually separate the two builds, and prints the
 * per-line worsts beside them as diagnostics. The per-line stepRatio and clickRatio bounds are for
 * the unit tests, whose signal is generated and therefore identical every run.
 *
 *                       shipped -> fixed     gated on real audio?
 *   thdDb               -8.6  ->  -47.5      yes (the tone probe has no Kokoro in it, so it is exact)
 *   edgeSample        0.0061  -> 0.0000      yes — 56 of 126 chunks past the bound -> 0, every run
 *   holeDb             -37.2  ->   -6.7      yes, as a count — 7-8 lines of 36 past -10 dB -> 0, every run.
 *                                              ONE RESIDUAL, disclosed rather than hidden: question/
 *                                              bm_fable still dips 6-8 dB (it measured -5.2, -5.9,
 *                                              -6.7, -7.0 and -8.1 over five runs), against the
 *                                              36 dB hole it had before. The bound sits at -10 so it
 *                                              is a bound and not a coin toss; the shipped ramp fails
 *                                              it on 7-8 lines either way.
 *   medianStepRatio     0.99  ->   1.04      yes
 *   medianClickRatio    1.06  ->   1.00      yes
 *   worst stepRatio     1.56-5.12 -> 1.26-1.61    no: not reproducible, and present in both builds
 *   worst clickRatio    2.70-2.98 -> 1.81-2.35    no: same
 * The lift the ramp buys is unchanged: a median +3.7 st against +4.0, with 2-4 of the 36 left
 * deliberately flat where there is no run of speech long enough to ramp inside.
 */
export const TTS_CLEAN = {
  thdDb: -30, edgeSample: 1e-3, holeDb: -10, liftSt: 1.5,
  stepRatio: 1.3, clickRatio: 2, medianStepRatio: 1.15, medianClickRatio: 1.15,
} as const;

/**
 * Bug 224 (the user's decision): no question ramp on any voice. The bug-151 ramp (+4 st over a question's last 350 ms)
 * was the DSP behind the question glitches of bugs 161 and 190 — Kokoro's questions now end as the model says them,
 * as Qwen's always have. `rampStage` stays for the measurements that compare against it.
 */
export const PROSODY_DEFAULT: Prosody = { questionRamp: false, semitones: 4, rampMs: 350, trimSilence: true, maxGapMs: 350, tailMs: 0 };
export const PROSODY_OFF: Prosody = { questionRamp: false, semitones: 0, rampMs: 0, trimSilence: false, maxGapMs: 0, tailMs: 0 };

/**
 * Bug 166: what a Qwen3 line goes through instead.
 *
 *   questionRamp off — the ramp is bug 151's fix for a model that renders every question flat. Qwen
 *     does not: measured on this Mac it ends a question 3-5 st ABOVE the same line as a statement, so
 *     the ramp would be lifting a rise that is already there, on a model it was never swept against.
 *   maxGapMs 420 — a grouped chunk carries two or three sentences, and the pause the model leaves
 *     between them (measured 250-330 ms) is the one every boundary is being matched to. Kokoro's 350
 *     would clip it.
 *   tailMs 220 — the sentence-final fall and breath stay on the end of the chunk (see `tailMs`).
 */
export function qwenProsody(p: Prosody): Prosody {
  return p.trimSilence || p.questionRamp
    ? { ...p, questionRamp: false, semitones: 0, rampMs: 0, maxGapMs: 420, tailMs: 220 }
    : p;
}
export const PROSODY_QWEN: Prosody = qwenProsody(PROSODY_DEFAULT);

/**
 * Bug 190: what a Qwen Bot's line goes through when its KOKORO stand-in says it — a whole reply
 * when Qwen is unavailable, or every line once a short Mac drops the call to Light mode (both of the user's calls
 * after the bug-183 install did: 200 and 393 MB free). Kokoro's own trim, and no question handling
 * at all: the user asked for none on a Qwen Bot, and the bug-151 ramp on that stand-in was the
 * glitch measured at the end of its questions (af_heart: a click 148 ms from the end at 2.5x the
 * same line's worst without the ramp, and a +3.1 to +4.7 st swing in the last 350 ms).
 */
export function plainProsody(p: Prosody): Prosody {
  return { ...p, questionRamp: false, semitones: 0, rampMs: 0 };
}

/** `SYNAPSE_TTS_PROSODY=0` (or `off`/`false`) turns the ramp off for a run; anything else leaves it on. */
export function prosodyFrom(env: NodeJS.ProcessEnv = process.env): Prosody {
  const v = env.SYNAPSE_TTS_PROSODY?.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" ? PROSODY_OFF : PROSODY_DEFAULT;
}

/**
 * Does this spoken chunk END on a question? Only the last sentence counts — "Sure, I can do that. Do
 * you want me to send it?" asks, "Do you want me to send it? Let me know." does not. Closing quotes
 * and brackets stay with the sentence, as they do in the renderer's own sentence splitter.
 */
export function endsQuestion(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.replace(/[\s"')\]*_”’]+$/u, "");
  return t.endsWith("?");
}

const SAMPLE_RATE = 24_000;

/** A frame's float32 LE PCM as a Float32Array, without copying (FrameReader aligns every buffer). */
function samples(pcm: Buffer): Float32Array {
  return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length >>> 2);
}

/**
 * The last sample with a PITCH in it: energy above 8% of this line's peak and a zero-crossing rate low
 * enough to be a vowel rather than a fricative or breath. A thousandth of the work of an F0 track, and
 * within 0-160 ms of one across the curated set (app/look/prosody.py).
 */
export function voicedEnd(x: Float32Array, hop = 240): number {
  const n = Math.floor(x.length / hop);
  if (n < 2) return x.length;
  const rms = new Float64Array(n);
  const zcr = new Float64Array(n);
  let peak = 0;
  for (let f = 0; f < n; f++) {
    let sum = 0;
    let cross = 0;
    const a = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = x[a + i]!;
      sum += v * v;
      if (i > 0 && (v < 0) !== (x[a + i - 1]! < 0)) cross++;
    }
    rms[f] = Math.sqrt(sum / hop);
    zcr[f] = cross / (hop - 1);
    if (rms[f]! > peak) peak = rms[f]!;
  }
  for (let f = n - 1; f >= 0; f--) if (rms[f]! >= peak * 0.08 && zcr[f]! <= 0.06) return (f + 1) * hop;
  return x.length;
}

/** The raised-cosine (Hann) weight at `t` in 0..1: 0 at 0, 1 at 1, flat at both ends. */
const raisedCos = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t));

/**
 * Bug 161: reading the tail faster than it was written moves everything in it UP by the same factor,
 * and whatever sat above Nyquist/k folds back as a buzz that is not in the voice. So the source is
 * band-limited to sr/(2k) first — a linear-phase windowed-sinc, Blackman-windowed, cut at the rate's
 * own ceiling — and only then read faster. `taps` is odd, so the filter's delay is a whole sample and
 * the phase of the tail is untouched.
 */
function bandLimit(x: Float32Array, from: number, to: number, cutoff: number, taps = 95): Float64Array {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid;
    const s = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = s * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  const out = new Float64Array(to - from);
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (let j = 0; j < taps; j++) {
      const k = from + i + j - mid;
      acc += h[j]! * (k >= 0 && k < x.length ? x[k]! : 0);
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Bug 161: reading between two samples is itself a filter, and the shipped ramp used the cheapest one
 * there is — a straight line between neighbours. Measured with a steady tone through the ramp, that
 * left images only 14.8 dB below a 7 kHz tone and 8.5 dB below a 9 kHz one: not a click, a buzz, sat
 * on the end of every question. This is the band-limited read instead — a Blackman-windowed sinc over
 * `HALF` samples either side, which is what a resampler is supposed to be.
 */
const HALF = 16;
const SINC_PHASES = 512;
/** sinc x window, precomputed at 512 fractional positions: [phase][tap]. Built once, ~16 k doubles. */
const SINC = (() => {
  const t = new Float64Array(SINC_PHASES * 2 * HALF);
  for (let p = 0; p < SINC_PHASES; p++) {
    const f = p / SINC_PHASES;
    let sum = 0;
    for (let j = 0; j < 2 * HALF; j++) {
      const d = j - HALF + 1 - f; // distance from the read position to tap j
      const s = Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const u = (d + HALF) / (2 * HALF);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      t[p * 2 * HALF + j] = s * w;
      sum += t[p * 2 * HALF + j]!;
    }
    for (let j = 0; j < 2 * HALF; j++) t[p * 2 * HALF + j]! /= sum; // unity gain at DC, so no level drift
  }
  return t;
})();
function sincRead(s: Float64Array, i0: number, f: number): number {
  const p = (Math.min(SINC_PHASES - 1, Math.max(0, Math.round(f * SINC_PHASES))) * 2 * HALF) | 0;
  let acc = 0;
  for (let j = 0; j < 2 * HALF; j++) {
    const k = i0 + j - HALF + 1;
    acc += SINC[p + j]! * (k < 0 ? s[0]! : k >= s.length ? s[s.length - 1]! : s[k]!);
  }
  return acc;
}

/** rate(u) rises 1 -> k over a raised cosine across the first 70% of the window, then holds. `src` is
 * how many samples the read consumes to write `n` — always more than `n`, because it reads faster. */
function rampPlan(n: number, k: number): { pos: Float64Array; src: number } {
  const pos = new Float64Array(n);
  let acc = 0;
  let first = 0;
  for (let i = 0; i < n; i++) {
    const rate = 1 + (k - 1) * raisedCos((i + 1) / (0.7 * n));
    if (i === 0) first = rate;
    acc += rate;
    pos[i] = acc - first;
  }
  return { pos, src: Math.ceil(pos[n - 1]!) + 2 };
}

/**
 * Bug 161: where the final unbroken run of speech before `end` begins.
 *
 * This is the one the user could hear. The ramp writes the last `rampMs` but READS about 60 ms further
 * back, and nothing stopped that read reaching back across a pause: on af_bella's "…this afternoon?"
 * it reached into the 25 ms of silence before the last word and grafted it into the middle of that
 * word — the level fell 45 dB for 20 ms, a hole, not a click, which is why every step measurement
 * said the line was fine. The ramp now has to fit inside one run of speech or make itself shorter.
 *
 * A stop closure inside a word dips too, so a run only ends after `holdMs` of continuous quiet.
 */
function speechRunStart(x: Float32Array, end: number, sr: number, holdMs = 20): number {
  const hop = Math.round(sr / 100); // 10 ms
  const last = Math.max(0, end - Math.round(sr * 0.8));
  let peak = 0;
  const rmsAt = (a: number): number => {
    let s = 0;
    for (let i = a; i < a + hop && i < x.length; i++) s += x[i]! * x[i]!;
    return Math.sqrt(s / hop);
  };
  for (let a = last; a + hop <= end; a += hop) peak = Math.max(peak, rmsAt(a));
    // Swept on the nine curated voices: peak*0.04 with a 20 ms hold is the setting that rides over
  // a stop closure but stops dead at a real pause — the deepest hole the ramp then digs is -5.6 dB
  // against -36.4 before, and it costs 0.3 st of median lift (3.92 against 4.20).
  const gate = Math.max(peak * 0.04, 0.003);
  const hold = Math.max(1, Math.round((holdMs * sr) / 1000 / hop));
  let quiet = 0;
  let a = end - hop;
  for (; a >= 0; a -= hop) {
    if (rmsAt(a) < gate) {
      if (++quiet >= hold) return a + (quiet * hop);
    } else quiet = 0;
  }
  return 0;
}

/**
 * The ramp itself, pure: a new Float32Array with the last `rampMs` of voiced speech lifted by
 * `semitones`. Returns the input unchanged when there is not enough voiced audio to ramp (a filler,
 * a one-word chunk) — a short chunk is never worth an artefact.
 */
export function rampQuestionTail(x: Float32Array, o: { semitones: number; rampMs: number; sampleRate?: number }): Float32Array {
  const sr = o.sampleRate ?? SAMPLE_RATE;
  const want = Math.round((sr * o.rampMs) / 1000);
  if (want < 64 || !(o.semitones > 0) || x.length < want + 16) return x;
  const k = 2 ** (o.semitones / 12);
  const end = voicedEnd(x);
  // Reading faster than we write, so we SOURCE more than we replace; then the read head's last sample
  // is lined up with the tail's last sample, so the full lift lands on the very end of the word.
  // Bug 161: and the whole read has to sit inside the final run of speech. If it doesn't fit, the
  // window shrinks to what does — and if what fits is under 120 ms there is no room for a rise worth
  // hearing, so the line goes out as the sidecar rendered it.
  const room = end - speechRunStart(x, end, sr) - 16;
  let n = want;
  let plan = rampPlan(n, k);
  if (plan.src > room) {
    n = Math.floor((room * n) / Math.max(1, plan.src));
    if (n < Math.round(sr * 0.12)) return x;
    plan = rampPlan(n, k);
    if (plan.src > room) return x;
  }
  const { pos, src } = plan;
  if (end < src + 16 || pos[n - 1]! <= 0) return x;
  const scale = (src - 2) / pos[n - 1]!;
  const out = Float32Array.from(x);
  // Bug 161: the window is written from `end - n` but read from `end - src`, about 60 ms of content
  // earlier, so the two signals the opening cross-fade blends are at unrelated points in the pitch
  // cycle — they partly cancel, and 20 ms of the word goes rough and quiet. So the read is slid back
  // to the offset whose waveform best MATCHES the window it is about to replace (plain normalised
  // cross-correlation over the first 20 ms, searching back one pitch period at 70 Hz). The match is
  // found at a whole number of pitch periods, which is why sliding the read start does not spoil the
  // other end: `end - 2 + shift` is still the same point in the cycle as `end - 2`.
  const L = Math.min(Math.round(sr * 0.02), n >> 1);
  const floor2 = end - speechRunStart(x, end, sr);
  let shift = 0;
  if (src + L < floor2) {
    const reach = Math.min(Math.round(sr / 45), floor2 - src - L);
    let bestScore = -Infinity;
    for (let d = -reach; d <= 0; d++) {
      let num = 0;
      let den = 0;
      for (let i = 0; i < L; i++) {
        const a = x[end - n + i]!;
        const b = x[end - src + d + i]!;
        num += a * b;
        den += b * b;
      }
      // Normalised, so a quiet stretch can't win the match just by being quiet.
      const score = den > 1e-12 ? num / Math.sqrt(den) : -Infinity;
      if (score > bestScore) { bestScore = score; shift = d; }
    }
  }
  const base = end - src + shift;
  // Bug 161: band-limit the source to the ceiling the fastest read can carry (sr/2k), measured at
  // +12.8 dB of >9.5 kHz junk over the sidecar's own before this, and under +1 dB after.
  const s = bandLimit(x, base, base + src, 0.5 / k);
  // Bug 161: both ends of the window are cross-faded on a RAISED COSINE, not a straight line. A linear
  // fade between two signals that no longer share a phase dips by up to 3 dB in the middle of the
  // fade — a small swallow at the very moment the pitch starts to move. 20 ms in, 8 ms out, and the
  // out-fade reaches the original exactly at the last sample of the window, so there is no step at all
  // where the warped tail hands back to the unvoiced consonant and Kokoro's own silence.
  const join = Math.min(n >> 2, Math.round(sr * 0.02));
  const out2 = Math.min(n >> 2, Math.round(sr * 0.008));
  for (let i = 0; i < n; i++) {
    const p = pos[i]! * scale;
    const i0 = Math.min(src - 2, Math.max(0, Math.floor(p)));
    let w = 1;
    if (i < join) w = raisedCos(i / join);
    if (i >= n - out2) w = Math.min(w, raisedCos((n - 1 - i) / out2));
    const orig = x[end - n + i]!;
    out[end - n + i] = w <= 0 ? orig : orig * (1 - w) + sincRead(s, i0, p - i0) * w;
  }
  return out;
}

/**
 * The streaming side. A chunk that does NOT end in "?" (or the flag being off) is passed straight
 * through, frame by frame, exactly as today — same bytes, same latency. A question is held until the
 * sidecar says "done", ramped, and released in frames of the same size, because the ramp needs the end
 * of the line to know where the voiced speech stops. Questions are short (a measured 1.4-2.3 s) and the
 * sidecar renders well under real time, so the wait is the line's own synth time, not a new delay.
 */
/**
 * Kokoro pads every chunk it renders: a measured 200-390 ms of silence before the words and 250-730 ms
 * after them, and af_nicole leaves 500-720 ms sitting mid-line. A call speaks a reply chunk by chunk, so
 * that padding stacks on top of the pause the renderer already asks the helper for between chunks — it
 * is dead air on the front of every line and slack in the middle of them.
 *
 * One filter does all three, and it streams: silence is HELD rather than emitted. When speech resumes,
 * at most `maxGapMs` of what was held goes out (so a mid-line gap is capped); nothing is emitted before
 * the first speech (so the lead is dropped); and whatever is still held at "done" is discarded (so the
 * tail is dropped) — past the word's own decay, which bug 180 keeps. First audio is never delayed — only audio that follows a silence waits, and only
 * for as long as that silence is allowed to be.
 */
export function silenceGate(h: KokoroHandlers, o: { maxGapMs: number; tailMs?: number; sampleRate?: number }): KokoroHandlers {
  const sr = o.sampleRate ?? SAMPLE_RATE;
  const block = Math.round(sr / 100); // 10 ms
  const maxGap = Math.max(0, Math.round((sr * o.maxGapMs) / 1000));
  const keepTail = Math.max(0, Math.round((sr * (o.tailMs ?? 0)) / 1000));
  // Kokoro's padding is true digital near-silence; speech sits two orders above this. A stop closure
  // inside a word reads as "silence" here and that is harmless: it is far shorter than maxGap.
  const GATE = 0.003;
  // Bug 161: the two edges the trim creates — where the line now begins and where it now ends — meet
  // the helper's own pause silence, and a cut left mid-waveform steps straight to zero there. 5 ms of
  // raised cosine at each edge, which is under half a pitch period of the lowest curated voice (81 Hz
  // = 12.3 ms), so no word loses its first or last phoneme: measured, the first 30 ms of speech keeps
  // 0.97x of its untrimmed RMS and the last 30 ms 0.98x.
  const FADE = Math.round(sr * 0.005);
  /**
   * Bug 180: the end of the WORD is not the end of the loud part. GATE sits only 30-37 dB under a
   * Kokoro line's peak, and a sentence takes 25-60 ms after its last loud sample to fall 55 dB
   * (measured, app/look/sentence-tail.mjs) — so the trim cut every sentence 0-10 ms after the last
   * loud sample, in the middle of that fall, and the word stopped instead of ending. The tail is now
   * kept until the line's own level has fallen DECAY_DB under its loudest 10 ms, so the closing fade
   * lands in the pad; at most DECAY_MAX_MS of it, so a tail that never gets there (a breath, a hum)
   * is not kept whole. This is the model's own ending, not added silence.
   */
  const DECAY_DB = 55;
  const DECAY_MAX_MS = 150;
  let peak = 0;
  let carry = Buffer.alloc(0);
  let gap: Float32Array[] = [];
  let gapLen = 0;
  let started = false;
  let seq = 0;
  /** Everything emitted so far and not yet sent. The last FADE samples are always held back, so the
   * closing fade can land on the line's true last samples rather than on whichever frame came last. */
  const pending: number[] = [];
  let sent = 0;
  const emit = (x: Float32Array) => { for (let i = 0; i < x.length; i++) pending.push(x[i]!); };
  const flush = (final: boolean) => {
    const n = final ? pending.length : pending.length - FADE;
    if (n <= 0) return;
    // Never fade more than a quarter of the line: a "line" of a few samples (a cache probe, a test)
    // has to come out as a few samples, not as a 5 ms fade in and straight back out of nothing.
    const fade = Math.min(FADE, Math.max(1, (sent + pending.length) >> 2));
    const b = Buffer.allocUnsafeSlow(n * 4);
    for (let i = 0; i < n; i++) {
      const g = sent + i;
      let w = 1;
      if (g < fade) w = raisedCos((g + 1) / fade);
      if (final && i >= n - fade) w = Math.min(w, raisedCos((n - 1 - i) / fade));
      b.writeFloatLE(pending[i]! * w, i * 4);
    }
    pending.splice(0, n);
    sent += n;
    h.audio(b, seq++);
  };
  /**
   * Bug 161: a cut belongs at a zero crossing. Inside the held silence every sample is small, but
   * "small" is not "zero" — the sample nearest zero in the 2 ms around `at` is, and cutting there
   * leaves nothing for the fade to have to hide.
   */
  const snapZero = (g: Float32Array[], at: number): number => {
    const span = Math.round(sr * 0.002);
    const lo = Math.max(0, at - span);
    const hi = Math.min(gapLen, at + span);
    const sampleAt = (i: number): number => {
      let k = i;
      for (const b2 of g) { if (k < b2.length) return b2[k]!; k -= b2.length; }
      return 0;
    };
    let best = at;
    let bestV = Infinity;
    for (let i = lo; i < hi; i++) {
      const v = Math.abs(sampleAt(i));
      if (v < bestV) { bestV = v; best = i; }
    }
    return best;
  };
  const emitGapFrom = (from: number): void => {
    let drop = from;
    for (const g of gap) {
      if (drop >= g.length) { drop -= g.length; continue; }
      emit(drop ? g.subarray(drop) : g);
      drop = 0;
    }
  };
  /** Bug 166: the FIRST `upto` samples of the held silence — the model's own tail, kept. */
  const emitGapUpTo = (upto: number): void => {
    let left = upto;
    for (const g of gap) {
      if (left <= 0) return;
      emit(left >= g.length ? g : g.subarray(0, left));
      left -= g.length;
    }
  };
  return {
    audio: (pcm) => {
      const buf = carry.length ? Buffer.concat([carry, pcm]) : pcm;
      const whole = Math.floor(buf.length / (block * 4));
      carry = Buffer.from(buf.subarray(whole * block * 4));
      for (let b = 0; b < whole; b++) {
        const x = new Float32Array(block);
        let sum = 0;
        for (let i = 0; i < block; i++) {
          const v = buf.readFloatLE((b * block + i) * 4);
          x[i] = v;
          sum += v * v;
        }
        if (Math.sqrt(sum / block) < GATE) {
          gap.push(x);
          gapLen += block;
          continue;
        }
        if (!started && gapLen) {
          // The lead is dropped, but the cut itself lands at a zero crossing, and far enough back that
          // the opening fade runs out inside Kokoro's own padding — so the line opens on the run-in to
          // the word, and the word's first phoneme is never the thing being faded up.
          emitGapFrom(snapZero(gap, Math.max(0, gapLen - FADE - Math.round(sr * 0.002))));
        } else if (started && gapLen > maxGap) {
          // Cap the gap: keep the LAST maxGap samples of it, so the run-in to the next word is intact.
          emitGapFrom(snapZero(gap, gapLen - maxGap));
        } else if (started) {
          emitGapFrom(0);
        }
        gap = [];
        gapLen = 0;
        started = true;
        peak = Math.max(peak, Math.sqrt(sum / block));
        emit(x);
      }
      flush(false);
    },
    // Whatever silence is still held is Kokoro's trailing pad: it never goes out. The partial block in
    // `carry` is the line's last few ms of real audio, so it always does — even if no whole block ever
    // cleared the gate, because a line shorter than 10 ms is still a line, and audio is never dropped
    // on a guess. (At most 10 ms of trailing pad rides along; nobody can hear that.)
    done: (info) => {
      // Bug 166: `tailMs` of the model's own trailing silence is kept — the fall and the breath the
      // renderer would otherwise have to fake with a pause. The cut lands at a zero crossing, so the
      // closing fade has nothing to hide, and a chunk with less tail than that simply keeps its own.
      // Bug 180: and never less than the word's own decay (see DECAY_DB): the held blocks are walked
      // until one has fallen under it, and the cut goes a fade's length into that block.
      let keep = keepTail;
      if (started && gapLen) {
        const floor = peak * 10 ** (-DECAY_DB / 20);
        const most = Math.round((sr * DECAY_MAX_MS) / 1000);
        let at = 0;
        for (const g of gap) {
          if (at >= most) break;
          let s = 0;
          for (let i = 0; i < g.length; i++) s += g[i]! * g[i]!;
          if (Math.sqrt(s / g.length) < floor) break;
          at += g.length;
        }
        keep = Math.max(keep, Math.min(most, at + FADE));
      }
      if (keep && started && gapLen) emitGapUpTo(snapZero(gap, Math.min(gapLen, keep)));
      if (carry.length >= 4) {
        const tail = new Float32Array(carry.length >>> 2);
        for (let i = 0; i < tail.length; i++) tail[i] = carry.readFloatLE(i * 4);
        emit(tail);
      }
      carry = Buffer.alloc(0);
      gap = [];
      gapLen = 0;
      flush(true);
      h.done(info);
    },
    error: (m) => { pending.length = 0; gap = []; gapLen = 0; carry = Buffer.alloc(0); h.error(m); },
  };
}

/** The question ramp's own stage: hold the line, lift its end, release it. */
function rampStage(h: KokoroHandlers, p: Prosody): KokoroHandlers {
  const held: Buffer[] = [];
  let seq = 0;
  const release = () => {
    if (!held.length) return;
    const all = Buffer.concat(held);
    held.length = 0;
    // Buffer.concat comes out of Node's pool and may start at any byte, and Float32Array throws on an
    // unaligned offset. allocUnsafeSlow is never pooled, so its byteOffset is always 0.
    let aligned = all;
    if (all.byteOffset % 4 !== 0) {
      aligned = Buffer.allocUnsafeSlow(all.length);
      all.copy(aligned);
    }
    const ramped = rampQuestionTail(samples(aligned), { semitones: p.semitones, rampMs: p.rampMs });
    const out = Buffer.from(ramped.buffer, ramped.byteOffset, ramped.length * 4);
    for (let i = 0; i < out.length; i += FRAME_BYTES) h.audio(out.subarray(i, i + FRAME_BYTES), seq++);
  };
  return {
    audio: (pcm) => { held.push(pcm); },
    done: (info) => { release(); h.done(info); },
    error: (message) => { held.length = 0; h.error(message); },
  };
}

/**
 * What a line actually goes through on its way to the helper: the silence gate first (streaming), then
 * the question ramp (only for a chunk that ends on a "?"). With both off the handlers come back
 * untouched, so the sidecar's own bytes reach the helper.
 */
export function withProsody(text: string, h: KokoroHandlers, p: Prosody): KokoroHandlers {
  let out = h;
  if (p.questionRamp && endsQuestion(text)) out = rampStage(out, p);
  if (p.trimSilence) out = silenceGate(out, { maxGapMs: p.maxGapMs, tailMs: p.tailMs });
  return out;
}

/** The sidecar's own frame size: half a second of 24 kHz float32. */
const FRAME_BYTES = (SAMPLE_RATE / 2) * 4;

