// The ONE scheduler every avatar shares. The sidebar can show dozens of avatars; each one registering
// its own requestAnimationFrame would be dozens of callbacks per frame. Here there is one rAF loop,
// it stops when nothing is registered, it pauses while the window is hidden, and an avatar that is
// scrolled off screen (IntersectionObserver) is skipped. The clock and rAF are injectable so tests
// drive time directly.
//
// Bug #100 (idle CPU): a ticker returns whether it is BUSY (mid-transition: a spin, hop, state change,
// overlay, trail, or the pointer over it). Busy avatars tick every display frame; calm ones — the
// ambient sway, breathing, drift and idle eye life (blinks, pose dwell) — tick at AMBIENT_FPS, and between ambient frames the loop sleeps
// on a timer instead of waking every vsync. While the window is blurred or hidden (ambient-pause.ts)
// calm avatars do not tick at all; a busy one (a live presence change) still plays out, then the loop
// goes quiet until something wakes it.
//
// This module knows nothing about what an avatar draws: a ticker is just `(nowMs) => busy`.

import { ambientPaused, onAmbientChange, windowHidden } from "../ambient-pause";

/** Returns true while the avatar needs the full display rate (a transition is playing). */
export type Ticker = (nowMs: number) => boolean | void;
/** Unregisters; `.wake()` asks for a full-rate tick now (a prop change, the pointer arriving). */
export type Registration = (() => void) & { wake(): void };
interface Entry { tick: Ticker; el: Element | null; onScreen: boolean; busy: boolean }
export interface AvatarClock {
  now(): number; raf(cb: () => void): number; caf(id: number): void;
  /** Optional: sleep `ms` then call back (the browser clock's timer). Without it the loop skips vsyncs instead. */
  timeout?(cb: () => void, ms: number): number; clearTimeout?(id: number): void;
}

/** Ambient motion rate. 30 fps is indistinguishable for motion this slow (periods of seconds). */
export const AMBIENT_FPS = 30;
const AMBIENT_MS = 1000 / AMBIENT_FPS;
/** A vsync may land a little early: accept an ambient frame this much before its nominal time. */
const JITTER_MS = 4;

const browserClock = (): AvatarClock => ({
  now: () => performance.now(),
  raf: (cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => cb()) : (setTimeout(cb, 16) as unknown as number)),
  caf: (id) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id)),
  timeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
});

let defaultClock: () => AvatarClock = browserClock;
let clock: AvatarClock = defaultClock();
const entries = new Set<Entry>();
let handle: number | null = null;
let timer: number | null = null;
let lastAmbient = -Infinity;
let io: IntersectionObserver | null = null;
const byEl = new Map<Element, Entry>();

function stop(): void {
  if (handle !== null) clock.caf(handle);
  if (timer !== null) clock.clearTimeout?.(timer);
  handle = timer = null;
}
function anyBusy(): boolean { for (const e of entries) if (e.busy && e.onScreen) return true; return false; }

function frame(): void {
  handle = null;
  if (entries.size === 0 || windowHidden()) return;
  const now = clock.now();
  const paused = ambientPaused();
  const ambient = !paused && now - lastAmbient >= AMBIENT_MS - JITTER_MS;
  if (ambient) lastAmbient = now;
  for (const e of entries) if (e.onScreen && (e.busy || ambient)) e.busy = e.tick(now) === true;
  schedule(now);
}
function schedule(now: number): void {
  if (handle !== null || timer !== null || entries.size === 0 || windowHidden()) return;
  if (anyBusy()) { handle = clock.raf(frame); return; }
  if (ambientPaused()) return; // quiet until a wake, a focus or a newly visible avatar
  const wait = lastAmbient + AMBIENT_MS - JITTER_MS - now; // sleep, then align to the next vsync
  if (clock.timeout && wait > 1) timer = clock.timeout(() => { timer = null; if (handle === null) handle = clock.raf(frame); }, wait);
  else handle = clock.raf(frame);
}
function ensureRunning(): void { schedule(clock.now()); }

const onVisibility = () => { if (windowHidden()) stop(); else ensureRunning(); };
if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
onAmbientChange(onVisibility); // blur / focus

function observer(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver !== "function") return io;
  io = new IntersectionObserver((list) => {
    let woke = false;
    for (const it of list) { const e = byEl.get(it.target); if (e) { if (it.isIntersecting && !e.onScreen) { e.busy = true; woke = true; } e.onScreen = it.isIntersecting; } }
    if (woke) ensureRunning();
  });
  return io;
}

/** Register an avatar. Returns the unregister function, with `.wake()`. */
export function addTicker(tick: Ticker, el: Element | null): Registration {
  const e: Entry = { tick, el, onScreen: true, busy: true };
  entries.add(e);
  const o = el ? observer() : null;
  if (el && o) { byEl.set(el, e); o.observe(el); }
  ensureRunning();
  const off = (() => {
    entries.delete(e);
    if (el && o) { byEl.delete(el); o.unobserve(el); }
    if (entries.size === 0) stop();
  }) as Registration;
  off.wake = () => {
    if (!entries.has(e)) return;
    e.busy = true;
    if (timer !== null) { clock.clearTimeout?.(timer); timer = null; }
    ensureRunning();
  };
  return off;
}

export function avatarNow(): number { return clock.now(); }
export function tickerCount(): number { return entries.size; }
export function loopRunning(): boolean { return handle !== null || timer !== null; }

/** Tests: replace the clock/rAF. `null` restores the default clock. */
export function setAvatarClock(c: AvatarClock | null): void {
  stop();
  clock = c ?? defaultClock();
  lastAmbient = -Infinity;
  ensureRunning();
}
/** The clock `setAvatarClock(null)` restores. The test setup makes it an inert clock, so a test that
 *  installs none never reads the real time or gets a real frame (the flaky-blink seam). */
export function setDefaultAvatarClock(make: () => AvatarClock): void { defaultClock = make; setAvatarClock(null); }

let interactionsOn = true;
export function avatarInteractions(): boolean { return interactionsOn; }
export function setAvatarInteractions(on: boolean): void { interactionsOn = on; }

/** prefers-reduced-motion, read once per avatar at mount (motion.md §8). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
