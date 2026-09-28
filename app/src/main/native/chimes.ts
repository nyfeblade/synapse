/**
 * Bug 134: the join and leave sounds, synthesized here (no recorded or borrowed sound). Two soft
 * sine "glass" notes with a quick attack and an exponential decay, a fifth apart: rising when a Bot
 * joins, falling when one leaves. 24 kHz mono float32 LE, peak about −13 dBFS, ~0.3 s, click-free (both
 * ends fade to silence). Played by the helper on its own player in the call's mixer, so echo
 * cancellation hears it too and the Bots' speech queue is never touched.
 */

const RATE = 24_000;
const PEAK = 0.22;

function note(out: Float32Array, startS: number, freq: number, durS: number, gain: number): void {
  const start = Math.round(startS * RATE);
  const n = Math.round(durS * RATE);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.008);
    const decay = Math.exp(-t / (durS / 4.5));
    // A touch of the octave for a soft bell colour.
    const v = Math.sin(2 * Math.PI * freq * t) + 0.18 * Math.sin(2 * Math.PI * freq * 2 * t);
    out[start + i]! += (v / 1.18) * attack * decay * gain;
  }
}

const cache = new Map<string, Buffer>();

export function chimePcm(kind: "join" | "leave"): Buffer {
  const hit = cache.get(kind);
  if (hit) return hit;
  const total = 0.32;
  const out = new Float32Array(Math.round(total * RATE));
  // E5 → B5 rising for a join; B5 → E5 falling for a leave (a perfect fifth).
  const [a, b] = kind === "join" ? [659.25, 987.77] : [987.77, 659.25];
  note(out, 0, a, 0.2, PEAK);
  note(out, 0.11, b, 0.2, PEAK);
  // A 12 ms fade at both ends: never a click.
  const fade = Math.round(0.012 * RATE);
  for (let i = 0; i < fade; i++) { const g = i / fade; out[i]! *= g; out[out.length - 1 - i]! *= g; }
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  if (peak > PEAK) for (let i = 0; i < out.length; i++) out[i]! *= PEAK / peak;
  const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  cache.set(kind, buf);
  return buf;
}
