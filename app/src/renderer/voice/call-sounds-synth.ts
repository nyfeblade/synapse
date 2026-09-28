/**
 * Pure sample synthesis for the two call sounds — plain math, no Web Audio and no DOM, so both the
 * live renderer (call-sounds.ts) and the offline render script (app/scripts/render-call-sounds.ts)
 * produce the exact same PCM from the same numbers (call-sounds-params.ts).
 */
import type { ChirpSpec, RingSpec } from "./call-sounds-params";

/** One note: a sine ramped up (attack), held, then ramped down (release) — never a hard edge (no click). */
function noteSamples(freq: number, ms: number, peak: number, attackMs: number, releaseMs: number, sampleRate: number): Float32Array {
  const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const attackN = Math.min(n, Math.round((attackMs / 1000) * sampleRate));
  const releaseN = Math.min(n - attackN, Math.round((releaseMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let g = peak;
    if (i < attackN) g = peak * (i / Math.max(1, attackN));
    else if (i >= n - releaseN) g = peak * ((n - i) / Math.max(1, releaseN));
    out[i] = g * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** The spec's notes, one after another, with silence gaps between them. */
export function synthesizeChirp(spec: ChirpSpec, sampleRate: number): Float32Array {
  const gapN = Math.round((spec.noteGapMs / 1000) * sampleRate);
  const parts = spec.notes.map((f) => noteSamples(f, spec.noteMs, spec.peakGain, spec.attackMs, spec.releaseMs, sampleRate));
  const total = parts.reduce((a, p) => a + p.length, 0) + gapN * Math.max(0, parts.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  parts.forEach((p, i) => {
    out.set(p, at);
    at += p.length;
    if (i < parts.length - 1) at += gapN;
  });
  return out;
}

/**
 * One ring pattern: the chirp, silence out to `patternMs`, then `pauseMs` more silence — the whole
 * repeating unit. `fadeIn` softens the very first one instead of starting sharp.
 */
export function synthesizeRingPattern(spec: RingSpec, sampleRate: number, fadeIn: boolean): Float32Array {
  const chirp = synthesizeChirp(spec, sampleRate);
  const patternN = Math.round((spec.patternMs / 1000) * sampleRate);
  const totalN = patternN + Math.round((spec.pauseMs / 1000) * sampleRate);
  const out = new Float32Array(Math.max(totalN, chirp.length));
  out.set(chirp.subarray(0, Math.min(chirp.length, out.length)), 0);
  if (fadeIn) {
    const fadeN = Math.min(out.length, Math.round((spec.firstFadeInMs / 1000) * sampleRate));
    for (let i = 0; i < fadeN; i++) out[i]! *= i / fadeN;
  }
  return out;
}

/** The hang-up sound is just its chirp — short, one-shot, no padding. */
export function synthesizeHangUp(spec: ChirpSpec, sampleRate: number): Float32Array {
  return synthesizeChirp(spec, sampleRate);
}
