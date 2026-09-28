/**
 * The snap's sound, synthesized (no audio file), to the recipe chosen on the snap-sound board.
 *
 * Timing: an AudioContext made at the moment of the snap starts its clock late, so the click landed
 * after the halves met. The context is opened when the snap STARTS, and the clicks are scheduled
 * then on the audio clock at the times the physics puts them (launch-snap.ts `snapClicks`).
 */
export interface SnapClick { t: number; level: number }

let shared: AudioContext | null = null;

/** The one audio context, opened (and asked to run) as early as possible. Null when there is no audio. */
export function openSnapAudio(): AudioContext | null {
  try {
    shared ??= new AudioContext({ latencyHint: "interactive" });
    if (shared.state === "suspended") void shared.resume().catch(() => {});
    return shared;
  } catch { return null; }
}

/**
 * The snap, as tuned by ear on the snap-sound board and saved from it (2026-09-26): a pen-sharp crack,
 * a short resonant body, a brief metallic ping, a small thump, then its own settle click 5 ms later.
 * `snap()` below is the board's own recipe function, so the app plays exactly what was chosen there.
 */
export const RECIPE = {
  swishMs: 0, swishLevel: 0, swishFrom: 800, swishTo: 4000,
  tickLevel: 1.2, tickCut: 3500, tickDecay: 0.35,
  bodyLevel: 1.2, bodyFreq: 2600, bodyQ: 14, bodyDecay: 2.5,
  ringLevel: 0.6, ringFreq: 4000, ringDecay: 5,
  popLevel: 0.12, popFreq: 200, popDecay: 8,
  settleMs: 5, settleLevel: 0.5, volume: 1,
} as const;
type Recipe = { [K in keyof typeof RECIPE]: number };

/**
 * Schedules the snap (ms on the snap's own clock) given that `elapsedMs` of the snap has already
 * played. The hit (level 1) plays the recipe with its own settle click; the physics' quieter re-seat
 * is left to the recipe, which is what was heard on the board. Output latency is taken off so the
 * sound is heard, not just started, as the halves meet. Returns a cancel that silences whatever has
 * not played yet (a click or key ended the snap early).
 */
export function scheduleSnapClicks(ac: AudioContext, elapsedMs: number, clicks: readonly SnapClick[]): () => void {
  const out = ac.createGain();
  out.gain.value = 1; out.connect(ac.destination);
  const now = ac.currentTime, lat = Number.isFinite(ac.outputLatency) ? ac.outputLatency : 0;
  for (const c of clicks) {
    if (c.t < elapsedMs || c.level < 1) continue;
    const t0 = Math.max(now, now + (c.t - elapsedMs) / 1000 - lat);
    snap(ac, out, t0, 1, RECIPE);
    if (RECIPE.settleLevel > 0 && RECIPE.settleMs > 0) snap(ac, out, t0 + RECIPE.settleMs / 1000, RECIPE.settleLevel, { ...RECIPE, swishMs: 0 });
  }
  return () => { try { out.disconnect(); } catch { /* already gone */ } };
}

function snap(ac: AudioContext, dest: AudioNode, t0: number, level: number, p: Recipe) {
  const out = ac.createGain(); out.gain.value = p.volume; out.connect(dest);
  const sr = ac.sampleRate, now = ac.currentTime;
  const noise = (secs: number, decayMs: number | null) => {
    const len = Math.max(1, Math.floor(sr * secs)), buf = ac.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (decayMs === null ? 1 : Math.exp(-i / ((sr * decayMs) / 1000)));
    const src = ac.createBufferSource(); src.buffer = buf; return src;
  };
  const filt = (type: BiquadFilterType, f: number, q: number) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const gain = (v: number) => { const g = ac.createGain(); g.gain.value = v; return g; };
  if (level >= 1 && p.swishMs > 5 && p.swishLevel > 0) {
    const w0 = Math.max(now, t0 - p.swishMs / 1000), dur = t0 - w0;
    if (dur > 0.005) {
      const src = noise(dur + 0.005, null), bp = filt("bandpass", p.swishFrom, 1.6), g = ac.createGain();
      bp.frequency.setValueAtTime(p.swishFrom, w0); bp.frequency.exponentialRampToValueAtTime(p.swishTo, t0);
      g.gain.setValueAtTime(0.0001, w0); g.gain.exponentialRampToValueAtTime(p.swishLevel * level, Math.max(w0 + 0.001, t0 - 0.003)); g.gain.linearRampToValueAtTime(0, t0);
      src.connect(bp).connect(g).connect(out); src.start(w0); src.stop(t0 + 0.005);
    }
  }
  if (p.tickLevel > 0) { const src = noise(0.02, p.tickDecay); src.connect(filt("highpass", p.tickCut, 0.7)).connect(filt("highpass", p.tickCut, 0.7)).connect(gain(p.tickLevel * level)).connect(out); src.start(t0); }
  if (p.bodyLevel > 0) { const src = noise(Math.min(0.2, (p.bodyDecay / 1000) * 8), p.bodyDecay); src.connect(filt("bandpass", p.bodyFreq, p.bodyQ)).connect(gain(p.bodyLevel * level)).connect(out); src.start(t0); }
  if (p.ringLevel > 0) {
    for (const [ratio, share] of [[1, 1], [1.502, 0.75], [2.187, 0.55], [2.93, 0.38]] as const) {
      const o = ac.createOscillator(), g = ac.createGain(), d = p.ringDecay / 1000 / Math.sqrt(ratio);
      o.frequency.value = p.ringFreq * ratio;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(p.ringLevel * share * level, t0 + 0.0008); g.gain.exponentialRampToValueAtTime(0.0003, t0 + d);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + d + 0.01);
    }
  }
  if (p.popLevel > 0) {
    const o = ac.createOscillator(), g = ac.createGain(), d = p.popDecay / 1000;
    o.frequency.setValueAtTime(p.popFreq, t0); o.frequency.exponentialRampToValueAtTime(p.popFreq * 0.5, t0 + d);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(p.popLevel * level, t0 + 0.001); g.gain.exponentialRampToValueAtTime(0.0003, t0 + d);
    o.connect(g).connect(out); o.start(t0); o.stop(t0 + d + 0.01);
  }
}
