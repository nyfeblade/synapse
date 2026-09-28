/**
 * The one piece of motion the stylesheet cannot reach.
 *
 * app.css's universal `prefers-reduced-motion: reduce` block collapses every `animation` and every
 * `transition` in the renderer, including `animation-delay` and `scroll-behavior`. It cannot reach a
 * `behavior` passed to `scrollIntoView()` as a JS argument, because that is an argument and not a CSS
 * declaration — so every caller that asks for a smooth scroll has to consult the media query itself.
 * The same is true of the Web Animations API (flip.ts, and the view change in view-transition.ts).
 *
 * Read at call time rather than captured at module load: the OS setting can change while the app is
 * open, and a module-level `const` would hold the value from whenever the bundle happened to
 * evaluate. `matchMedia` is also guarded because it does not exist in every test environment.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** `"smooth"` unless the user has asked for less motion, in which case scrolling is instant. */
export function scrollBehavior(smooth: boolean): ScrollBehavior {
  return smooth && !prefersReducedMotion() ? "smooth" : "auto";
}

/**
 * The two springs, as PHYSICS (decisions.md, "ultra liquid"). A damped harmonic oscillator released
 * from rest one unit away from its target: zeta is the damping ratio (under 1 = it sloshes past once),
 * omega the natural frequency in rad/s, duration the window it is sampled over. Heavier than the
 * "water" pass (560/480ms): more mass, one slightly bigger slosh (glide ~4%, pop ~7%), still ONE
 * settle and no second bounce (at these zetas the second swing is under 0.05% and rounds away).
 * tokens.css holds the sampled strings; motion-css.test.ts re-samples these numbers and requires the
 * stylesheet to match, so a curve can only change by changing the physics here.
 */
export interface Spring { readonly duration: number; readonly zeta: number; readonly omega: number }
export const SPRINGS = {
  glide: { duration: 680, zeta: 0.716, omega: 12.5 },
  pop: { duration: 550, zeta: 0.646, omega: 17 },
} as const satisfies Record<string, Spring>;

/**
 * Displacement from the target at time `t` (seconds) of a spring released at displacement `x0` with
 * velocity `v0` (units/s); 0 is at rest on the target. The closed-form underdamped solution: no
 * integration error and no per-frame state, so evaluating it costs a handful of flops.
 */
export function springAt(s: Spring, t: number, x0: number, v0: number): number {
  const a = s.zeta * s.omega;
  const wd = s.omega * Math.sqrt(1 - s.zeta * s.zeta);
  return Math.exp(-a * t) * (x0 * Math.cos(wd * t) + ((v0 + a * x0) / wd) * Math.sin(wd * t));
}

/** Progress 0→1 of a spring released from rest, sampled into CSS `linear()` (30 even steps, 3dp). */
export function springCurve(s: Spring, steps = 30): string {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(i === steps ? 1 : Math.round((1 - springAt(s, ((i / steps) * s.duration) / 1000, 1, 0)) * 1000) / 1000);
  }
  return `linear(${pts.join(", ")})`;
}

/**
 * The JS mirror of tokens.css's two spring tokens, for motion that has to run through the Web
 * Animations API (a FLIP's start offset is only known at run time, so it cannot be a keyframe in a
 * stylesheet). motion-css.test.ts pins these to tokens.css, so the two can never drift: a change to a
 * curve is a change to SPRINGS and to the stylesheet, or the suite fails.
 */
export const MOTION = {
  glide: { duration: SPRINGS.glide.duration, easing: springCurve(SPRINGS.glide) },
  pop: { duration: SPRINGS.pop.duration, easing: springCurve(SPRINGS.pop) },
} as const;
export type MotionToken = keyof typeof MOTION;

/**
 * Follow-through and cascades (decisions.md, "ultra liquid"). A list's rows, or a container's
 * children, trail by STAGGER_MS each, and the trail stops growing after STAGGER_CAP items, so a
 * 200-row list lags no more than a 5-row one. Mirrors tokens.css's `--stagger` (pinned by a test).
 */
export const STAGGER_MS = 40;
export const STAGGER_CAP = 4;
export const staggerDelay = (i: number): number => Math.min(Math.max(0, i), STAGGER_CAP) * STAGGER_MS;

/**
 * Stretch along travel: a moving indicator lengthens along its direction of motion by up to
 * STRETCH_MAX and thins across it by up to SQUASH_MAX, in proportion to its speed (full at
 * STRETCH_SPEED px/s), so it is 1:1 at rest and relaxes as it arrives.
 */
export const STRETCH_MAX = 0.06;
export const SQUASH_MAX = 0.03;
export const STRETCH_SPEED = 1600;
export function stretchFor(vx: number, vy: number): { sx: number; sy: number } {
  const speed = Math.hypot(vx, vy);
  if (!speed) return { sx: 1, sy: 1 };
  const k = Math.min(1, speed / STRETCH_SPEED);
  const ux = Math.abs(vx) / speed;
  const uy = Math.abs(vy) / speed;
  return { sx: 1 + k * (STRETCH_MAX * ux - SQUASH_MAX * uy), sy: 1 + k * (STRETCH_MAX * uy - SQUASH_MAX * ux) };
}

/**
 * Message entrance (the smooth pass, Task 9; decisions.md, "messages glide, no squash-bounce" —
 * replaces the send bloop's sampled spring). The user's message is already in its final place
 * (Transcript renders it optimistically at Enter) and glides out of its tail corner on the flat
 * --ease-out family Task 8 introduced (app.css `@keyframes msg-in-user`, on --motion-msg-user); the
 * Bot's reply mirrors it with no scale (`@keyframes msg-in-left`, on --motion-msg-bot). Avatars keep
 * their own springs (avatar/face-sim.ts) — neither of these touches them.
 *
 * MSG_USER_ENTER_MS is the one number Transcript.tsx needs at run time, to hold the Bot's typing dots
 * off screen until the user's own message has finished gliding in; motion-css.test.ts pins it to
 * tokens.css's --motion-msg-user so the two cannot drift apart.
 */
export const MSG_USER_ENTER_MS = 240;
export const MSG_BOT_ENTER_MS = 220;
