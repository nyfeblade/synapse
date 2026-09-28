import { SPRINGS, prefersReducedMotion, springAt } from "./motion";

/**
 * SCROLL ON THE SPRING ("ultra liquid", decisions.md). The browser's `behavior: "smooth"` runs its own
 * fixed curve; this drives `scrollTop` from the glide spring instead, so the transcript lands the way
 * everything else moves: a little heavy, one soft settle (at the bottom edge the slosh is clamped away).
 *
 * - The target is a FUNCTION, re-read every frame: content that grows mid-glide (a streamed reply, an
 *   image decoding) is tracked, not overshot or snapped to. The offset from the target is the spring's
 *   state; the target itself can move.
 * - Interruptible by the user: wheel, touch, pointer or key input on the scroller stops it that frame.
 * - Momentum: a re-glide mid-flight starts at the current speed, not from rest.
 * - Reduced motion: lands instantly.
 * One write per frame (scrollTop), no layout reads beyond scrollHeight/clientHeight.
 */
interface Glide { raf: number; t0: number; x0: number; v0: number; target: () => number; stop: () => void }
const glides = new WeakMap<HTMLElement, Glide>();
const INPUTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
const S = SPRINGS.glide;

/** Offset from the target (px) and its speed (px/s) of a running glide at `now`. */
function state(g: Glide, now: number): { x: number; v: number } {
  const t = Math.max(0, now - g.t0) / 1000;
  const x = springAt(S, t, g.x0, g.v0);
  const v = (springAt(S, t + 0.001, g.x0, g.v0) - springAt(S, Math.max(0, t - 0.001), g.x0, g.v0)) / (t > 0.001 ? 0.002 : 0.001);
  return { x, v };
}

export function isGliding(el: HTMLElement): boolean {
  return glides.has(el);
}

export function stopGlide(el: HTMLElement): void {
  glides.get(el)?.stop();
}

export function glideScroll(el: HTMLElement, target: () => number, onEnd?: () => void): void {
  const now = performance.now();
  const prev = glides.get(el);
  const carried = prev ? state(prev, now) : null;
  prev?.stop();
  if (prefersReducedMotion()) { el.scrollTop = target(); onEnd?.(); return; }
  const to = target();
  // Continue from where the scroller IS, at a running glide's speed. NOT `carried.x + (prev.target() -
  // to)`: a target is a live function, so for a re-glide on new content prev.target() already reads the
  // NEW bottom, the correction was always 0, and every message that arrived while the last glide was
  // still settling teleported the transcript to the end (motion check "scroll-jump", bug log).
  const x0 = el.scrollTop - to;
  const g: Glide = {
    raf: 0, t0: now, x0, v0: carried?.v ?? 0, target,
    stop: () => {
      cancelAnimationFrame(g.raf);
      for (const t of INPUTS) el.removeEventListener(t, g.stop);
      if (glides.get(el) === g) glides.delete(el);
    },
  };
  const frame = () => {
    const t = performance.now() - g.t0;
    if (t >= S.duration) { el.scrollTop = g.target(); g.stop(); onEnd?.(); return; }
    el.scrollTop = g.target() + state(g, performance.now()).x;
    g.raf = requestAnimationFrame(frame);
  };
  for (const t of INPUTS) el.addEventListener(t, g.stop, { passive: true });
  glides.set(el, g);
  g.raf = requestAnimationFrame(frame);
}
