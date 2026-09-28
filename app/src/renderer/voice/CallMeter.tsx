import { useEffect, useLayoutEffect, useRef } from "react";
import { addTicker, prefersReducedMotion } from "../avatar/avatar-loop";

// The call's microphone meter. STATIONARY: a fixed, centred envelope of bars that breathes in place
// with the CURRENT level. (It used to be a 32-sample history shifted left on every level event, with a
// CSS transition on each bar smearing the scroll, so the waveform travelled across the screen.)
// Driven per frame by the avatars' one shared loop: no per-bar CSS transition to lag behind.

export const METER_BARS = 11;
/** Taller in the centre, symmetric: a raised cosine from 0.3 at the edges to 1 in the middle. */
export const METER_ENVELOPE: readonly number[] = Array.from({ length: METER_BARS }, (_, i) => {
  const x = (i - (METER_BARS - 1) / 2) / ((METER_BARS - 1) / 2); // -1..1
  return 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(Math.PI * x));
});
/** A small, stable per-bar variation so it reads as a voice, not a bar chart. Fixed: it never moves. */
const VARIATION = [0.92, 1.04, 0.95, 1.06, 0.97, 1, 0.97, 1.03, 0.94, 1.05, 0.93];
/** The height of a bar at rest (and of every bar while muted). */
const FLOOR = 0.08;
export const METER_ATTACK_MS = 60;
export const METER_RELEASE_MS = 250;

/** One smoothing step toward `target`: a quick attack, a slower release (exponential, frame-rate free). */
export function meterFollow(cur: number, target: number, dtMs: number): number {
  const tau = target > cur ? METER_ATTACK_MS : METER_RELEASE_MS;
  return target + (cur - target) * Math.exp(-Math.max(0, dtMs) / tau);
}

/** Each bar's scaleY for a smoothed level (0..1). The same shape at every level: only its height changes. */
export function meterBars(level: number, muted: boolean): number[] {
  const l = muted ? 0 : Math.min(1, Math.max(0, level));
  return METER_ENVELOPE.map((e, i) => FLOOR + (1 - FLOOR) * l * e * VARIATION[i]!);
}

export function CallMeter({ level, muted, label }: { level: number; muted: boolean; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const wake = useRef<(() => void) | null>(null);
  target.current = muted ? 0 : Math.min(100, Math.max(0, level)) / 100;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const bars = Array.from(el.querySelectorAll<HTMLElement>("i"));
    const rm = prefersReducedMotion();
    let cur = 0, last = -1;
    const draw = () => meterBars(cur, mutedRef.current).forEach((v, i) => {
      const t = `scaleY(${v.toFixed(3)})`;
      if (bars[i]!.style.transform !== t) bars[i]!.style.transform = t;
    });
    const off = addTicker((now) => {
      const dt = last < 0 ? 0 : now - last;
      last = now;
      cur = rm ? target.current : meterFollow(cur, target.current, dt);
      if (Math.abs(cur - target.current) < 0.002) cur = target.current;
      draw();
      return cur !== target.current; // busy (display rate) only while it is still moving
    }, el);
    wake.current = off.wake;
    draw();
    return () => { off(); wake.current = null; };
  }, []);
  useLayoutEffect(() => { wake.current?.(); }, [level, muted]);

  return (
    <div ref={root} className="call-wave" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} data-muted={muted}>
      {METER_ENVELOPE.map((_, i) => <i key={i} style={{ transform: `scaleY(${FLOOR})` }} />)}
    </div>
  );
}
