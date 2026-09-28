import { useLayoutEffect, useRef } from "react";
import { MOTION, SPRINGS, prefersReducedMotion, springAt, staggerDelay, stretchFor, type MotionToken, type Spring } from "./motion";

/**
 * FLIP — First, Last, Invert, Play — in ~60 lines, for continuity: an element that changes place moves
 * from where it WAS to where it IS instead of teleporting (decisions.md, "liquid motion").
 *
 * Three properties the rest of the renderer relies on:
 * - Compositor-only. The only keyframe properties ever written are `transform` and `opacity`
 *   (flip-perf.test.ts spies on `animate` and fails on anything else), so a move costs no layout and
 *   no paint per frame and 120Hz stays 120Hz.
 * - No layout thrash. Every rect is READ before any animation is WRITTEN, in one batch per phase, so
 *   a list of N rows forces at most one layout per phase — never N (flip-perf.test.ts pins the order).
 * - Interruptible. A new move measured mid-flight reads the element's CURRENT visual box (a
 *   getBoundingClientRect includes the running transform), cancels the old animation and starts the
 *   new one from there — so a second click redirects the motion instead of snapping it back. It also
 *   keeps the old move's VELOCITY ("ultra liquid"): the new spring is solved with that initial speed,
 *   so a redirected element carries its momentum instead of restarting from rest.
 *
 * Reduced motion: nothing moves; the DOM is already in its final state, so doing nothing IS instant.
 */

export type Snapshot = Map<Element, DOMRect>;
export interface Velocity { x: number; y: number }
export interface FlipOptions {
  token?: MotionToken;
  scale?: boolean;
  origin?: string;
  pseudoElement?: string;
  /** Rows trail each other by --stagger, capped (motion.ts staggerDelay): a list cascades. */
  stagger?: boolean;
  /** Stretch along the direction of travel in proportion to speed (motion.ts stretchFor). */
  stretch?: boolean;
  /** Start moving at this velocity (px/s) instead of from rest: momentum carried from an interrupted move. */
  velocity?: Velocity;
}

const running = new WeakMap<Element, Animation>();
const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === "function";

/**
 * MOMENTUM (decisions.md, "ultra liquid"). Every animation this module starts records the spring it
 * is running, so an interruption can ask how fast it was going without touching the DOM: the offset
 * is `springAt(spring, t, x0, v0)` in closed form, and its velocity is that function's slope at the
 * fake-able clock's `now`. No getComputedStyle, no extra layout: the read/write batching holds.
 */
interface MotionState { t0: number; delay: number; duration: number; spring: Spring; x0: number; y0: number; vx: number; vy: number }
const states = new WeakMap<Animation, MotionState>();
const clock = () => performance.now();
const ZERO: Velocity = { x: 0, y: 0 };

/** The velocity (px/s) an animation started here is rendering at right now; 0 before it starts and after it ends. */
export function velocityOf(anim: Animation | null | undefined, now = clock()): Velocity {
  const s = anim ? states.get(anim) : undefined;
  if (!s) return ZERO;
  const t = (now - s.t0 - s.delay) / 1000;
  if (t <= 0 || t * 1000 >= s.duration) return ZERO;
  const h = 0.001;
  const at = (u: number) => [springAt(s.spring, u, s.x0, s.vx), springAt(s.spring, u, s.y0, s.vy)] as const;
  const [ax, ay] = at(t - h);
  const [bx, by] = at(t + h);
  return { x: (bx - ax) / (2 * h), y: (by - ay) / (2 * h) };
}

const SAMPLES = 24;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** First: read every box. Reads only. */
export function measure(els: Iterable<Element>): Snapshot {
  const out: Snapshot = new Map();
  for (const el of els) out.set(el, el.getBoundingClientRect());
  return out;
}

/** Last, Invert, Play for every element of a snapshot that is still in the document. */
export function play(before: Snapshot, opts: FlipOptions = {}): void {
  if (!before.size || prefersReducedMotion()) return;
  const live = [...before].filter(([el]) => el.isConnected && canAnimate(el));
  const now = clock();
  // Momentum first (pure arithmetic on recorded springs), then drop the old offset so "Last" is the real box.
  const carried = live.map(([el]) => { const a = running.get(el); const v = velocityOf(a, now); a?.cancel(); return v; });
  const moves = live.map(([el, from], i) => ({ el, from, to: el.getBoundingClientRect(), v: carried[i]! })); // all reads…
  let n = 0;
  for (const { el, from, to, v } of moves) { // …then all writes
    if (animateFrom(el, from, to, { ...opts, velocity: v }, opts.stagger ? staggerDelay(n) : 0)) n++;
  }
}

/** One element, from an explicit starting box (a morph from something that is no longer there). */
export function flipFrom(el: Element, from: DOMRect, opts: FlipOptions = {}): Animation | null {
  if (prefersReducedMotion() || !el.isConnected || !canAnimate(el)) return null;
  let velocity = opts.velocity;
  if (!opts.pseudoElement) {
    const prev = running.get(el);
    velocity ??= velocityOf(prev);
    prev?.cancel();
  }
  return animateFrom(el, from, el.getBoundingClientRect(), { ...opts, velocity });
}

function animateFrom(el: Element, from: DOMRect, to: DOMRect, opts: FlipOptions, delay = 0): Animation | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = opts.scale && to.width ? from.width / to.width : 1;
  const sy = opts.scale && to.height ? from.height / to.height : 1;
  const v = opts.velocity ?? ZERO;
  const moving = Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
  if (!moving && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
  const token = opts.token ?? "glide";
  const { duration, easing } = MOTION[token];
  const origin = opts.origin ?? "0 0";
  // At rest and unstretched: the two-keyframe token, exactly the CSS curve. Carrying momentum or
  // stretching: the same spring solved with the carried velocity and sampled into keyframes.
  const sampled = moving || opts.stretch;
  const keyframes = sampled
    ? springKeyframes(SPRINGS[token], dx, dy, sx, sy, v, origin, opts.stretch ? to : null)
    : [
        { transformOrigin: origin, transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: origin, transform: "none" },
      ];
  // `backwards` only, and only while a cascade waits out its delay: a FLIP never holds its end
  // state, so it never leaves a transform (and a stacking context) behind.
  const timing: KeyframeAnimationOptions = { duration, easing: sampled ? "linear" : easing, pseudoElement: opts.pseudoElement };
  if (delay) { timing.delay = delay; timing.fill = "backwards"; }
  const anim = (el as HTMLElement).animate(keyframes, timing);
  states.set(anim, { t0: clock(), delay, duration, spring: SPRINGS[token], x0: dx, y0: dy, vx: v.x, vy: v.y });
  if (opts.pseudoElement) return anim;
  running.set(el, anim);
  anim.onfinish = () => { if (running.get(el) === anim) running.delete(el); };
  return anim;
}

/**
 * The spring solved from (dx, dy) moving at `v`, sampled into SAMPLES+1 keyframes run on a linear
 * timeline. Scale (a morph) eases on the from-rest curve. With `box`, each frame also stretches along
 * the frame's velocity (motion.ts stretchFor), about the box's centre, so it never drifts sideways;
 * that needs the default "0 0" origin, which is what the gliding selection fill uses.
 */
function springKeyframes(s: Spring, dx: number, dy: number, sx: number, sy: number, v: Velocity, origin: string, box: DOMRect | null): Keyframe[] {
  const out: Keyframe[] = [];
  const T = s.duration / 1000;
  const h = T / SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const t = i * h;
    const x = springAt(s, t, dx, v.x);
    const y = springAt(s, t, dy, v.y);
    const p = springAt(s, t, 1, 0); // 1 → 0: the share of the morph's scale still to go
    let bx = 1 + (sx - 1) * p;
    let by = 1 + (sy - 1) * p;
    let ox = x;
    let oy = y;
    if (box && origin === "0 0") {
      // The frame's velocity: exactly the carried one at t = 0 (0 from rest), a central difference after.
      const k = i === 0 ? stretchFor(v.x, v.y) : stretchFor(
        (springAt(s, t + 0.001, dx, v.x) - springAt(s, t - 0.001, dx, v.x)) / 0.002,
        (springAt(s, t + 0.001, dy, v.y) - springAt(s, t - 0.001, dy, v.y)) / 0.002,
      );
      ox += (box.width * bx * (1 - k.sx)) / 2;
      oy += (box.height * by * (1 - k.sy)) / 2;
      bx *= k.sx;
      by *= k.sy;
    }
    out.push({ transformOrigin: origin, transform: `translate(${r3(ox)}px, ${r3(oy)}px) scale(${+bx.toFixed(4)}, ${+by.toFixed(4)})` });
  }
  out.push({ transformOrigin: origin, transform: "none" });
  return out;
}

/** Where an element's gliding `::before` fill is on screen right now (its box, moved by the live transform). */
function visualBox(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (!el.classList.contains("glide-sel") || typeof DOMMatrixReadOnly === "undefined") return r;
  const t = getComputedStyle(el, "::before").transform;
  if (!t || t === "none") return r;
  const m = new DOMMatrixReadOnly(t); // origin 0 0, so the matrix maps the box's corner directly
  return new DOMRect(r.left + m.e, r.top + m.f, r.width * m.a, r.height * m.d);
}

/** End a glide: hand the fill back to the element's own background without its 120ms colour fade. */
function settle(el: HTMLElement): void {
  el.style.transitionProperty = "none";
  el.classList.remove("glide-sel");
  void getComputedStyle(el).backgroundColor; // one style flush, once per glide — not per frame
  el.style.transitionProperty = "";
}

/**
 * The selection MOVING: when `key` changes, the newly selected element's fill travels from wherever
 * the old selection's fill is (mid-glide included, so a fast second click redirects it) instead of
 * one row switching off while another switches on. The fill rides a `::before` for the length of the
 * glide only (`.glide-sel` in app.css); at rest the element's own `background` is untouched, so every
 * resting colour, contrast pair and hover state stays exactly what it was. The motion is in the
 * element's own coordinate space, so a scrolled or filtered list cannot desynchronise it — the
 * objection motion-spec §7.7 raised against an absolutely positioned pill.
 */
export function useSelectionGlide(root: { current: Element | null }, selector: string, key: unknown): void {
  const from = useRef<DOMRect | null>(null);
  const last = useRef(key);
  const live = useRef<{ anim: Animation; el: HTMLElement } | null>(null);
  if (!Object.is(last.current, key)) {
    last.current = key;
    const el = root.current?.querySelector(selector);
    from.current = el ? visualBox(el) : null;
  }
  useLayoutEffect(() => {
    const start = from.current;
    from.current = null;
    const el = root.current?.querySelector<HTMLElement>(selector);
    const prev = live.current;
    live.current = null;
    // Momentum: a fill redirected mid-glide keeps the speed it had (read off its recorded spring).
    const velocity = velocityOf(prev?.anim);
    if (prev) { prev.anim.cancel(); settle(prev.el); } // synchronously: a cancelled glide leaves no stray fill
    if (!start || !el) return;
    el.classList.add("glide-sel");
    // Stretch along travel: the fill lengthens along its path mid-flight and relaxes as it lands.
    const anim = flipFrom(el, start, { pseudoElement: "::before", scale: true, stretch: true, velocity });
    if (!anim) { settle(el); return; }
    live.current = { anim, el };
    anim.addEventListener("finish", () => { if (live.current?.anim === anim) { live.current = null; settle(el); } });
  }, [key]);
}

/**
 * React binding: whenever `trigger` changes, the elements `pick()` returns glide from their pre-commit
 * boxes to their post-commit ones. The "First" read happens during render — the last moment the old
 * DOM is still on screen — and the play happens in a layout effect, before the browser paints the
 * jump, so the user never sees a frame of the teleport.
 */
export function useFlip(pick: () => Iterable<Element>, trigger: unknown, opts?: FlipOptions): void {
  const snap = useRef<Snapshot | null>(null);
  const last = useRef(trigger);
  if (!Object.is(last.current, trigger)) {
    last.current = trigger;
    snap.current = measure(pick());
  }
  useLayoutEffect(() => {
    if (!snap.current) return;
    play(snap.current, opts);
    snap.current = null;
  }, [trigger]);
}

/**
 * Expand/collapse without animating height: the disclosed content enters on its own (a CSS entrance
 * on transform/opacity), and everything laid out BELOW the disclosure glides to its new place rather
 * than jumping — the "height: auto" illusion at compositor cost. `grid-template-rows: 0fr → 1fr` would
 * be simpler, and it is a layout animation on every frame; motion-css.test.ts forbids it.
 */
export function useExpandFlip(ref: { current: Element | null }, open: boolean, root = ".transcript"): void {
  useFlip(() => following(ref.current, root), open);
}

/**
 * Everything laid out after `el` inside `root`: its later siblings, then its parent's later siblings,
 * and so on up to `root`. When `el` expands or collapses, these are exactly the boxes that move.
 * Capped: a transcript can hold hundreds of rows, and the ones past the fold are not worth measuring.
 */
export function following(el: Element | null, root: string, cap = 24): Element[] {
  const out: Element[] = [];
  for (let node = el; node && !node.matches(root) && out.length < cap; node = node.parentElement) {
    for (let s = node.nextElementSibling; s && out.length < cap; s = s.nextElementSibling) out.push(s);
  }
  return out;
}
