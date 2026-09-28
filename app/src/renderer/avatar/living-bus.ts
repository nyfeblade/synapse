// Living Bots (bug 226): the one place that watches the app for what the avatars react to — the
// pointer near an avatar, the composer while the user types, a focused password field, the approval
// button a Bot is waiting on, the user reading a long reply, a hand-off between two Bots, the call's
// nod. Avatars that opt in (ShapeAvatar's `living` prop) join here; everything is client-side, from
// DOM events and the app's own event stream: zero tokens.
//
// Cost: the pointer and scroll handlers only note what happened and ask for ONE animation frame; that
// frame reads the rectangles of the avatars on screen (its own IntersectionObserver skips the rest)
// and wakes only an avatar whose gaze changed. Nothing runs while the window is hidden.

import { faceCatch, faceNod, setFaceLook, setFaceQuiet, type FaceSim } from "./face-sim";
import { avatarNow, prefersReducedMotion } from "./avatar-loop";
import { gazeAt, handoffPair, isSecretField, lookAway, orbBow, orbPoint, pointerNear, type Box, type Look } from "./living-gaze";
import { windowHidden } from "../ambient-pause";
import { useUi } from "../store";

export interface LivingMember {
  botId: string;
  el: SVGSVGElement;
  sim: FaceSim;
  wake(): void;
  /** The body colour (a CSS colour or var()), for the hand-off orb. */
  color: string;
  /** A look from the caller (the call screen's glance at the speaker's seat), under the live ones. */
  base: Look | null;
}
interface Entry { m: LivingMember; onScreen: boolean; last: Look | null; quiet: boolean }

const entries = new Map<LivingMember, Entry>();
const byEl = new Map<Element, Entry>();
let io: IntersectionObserver | null = null;
let installed = false;
let frame: number | null = null;
let pointer: { x: number; y: number } | null = null;
let typingUntil = 0;
let readingUntil = 0;
let endTimer: ReturnType<typeof setTimeout> | null = null;

/** The composer's text box, and how long after a keystroke the Bot keeps watching it. */
const COMPOSER = "textarea.composer-input";
const TYPING_MS = 1500;
/** The button a waiting Bot looks at: a pending approval (or secret) card's primary action. */
const WAITING_BUTTON = ".card.pending .btn-primary";
/** Scrolling the transcript reads as reading, for this long after the last scroll. */
const SCROLL_READ_MS = 2500;
/** The hand-off orb's flight. */
export const ORB_MS = 720;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function schedule(): void {
  if (frame !== null || typeof requestAnimationFrame !== "function") return;
  frame = requestAnimationFrame(() => { frame = null; sweep(); });
}
function scheduleAt(ms: number): void {
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(() => { endTimer = null; schedule(); }, Math.max(0, ms) + 30);
}

function onPointer(e: PointerEvent): void { pointer = { x: e.clientX, y: e.clientY }; schedule(); }
function onPointerOut(e: PointerEvent): void { if (!e.relatedTarget) { pointer = null; schedule(); } }
function onFocus(): void { schedule(); }
function onInput(e: Event): void {
  const t = e.target as Element | null;
  if (t && typeof t.matches === "function" && t.matches(COMPOSER)) {
    typingUntil = now() + TYPING_MS; readingUntil = 0; scheduleAt(TYPING_MS); schedule();
  }
}
function onWheel(e: Event): void {
  const t = e.target as Element | null;
  if (t && typeof t.closest === "function" && t.closest(".transcript")) livingReading(SCROLL_READ_MS);
}
function onScroll(): void { schedule(); }

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const opt = { capture: true, passive: true } as const;
  window.addEventListener("pointermove", onPointer, opt);
  window.addEventListener("pointerout", onPointerOut, opt);
  window.addEventListener("focusin", onFocus, opt);
  window.addEventListener("focusout", onFocus, opt);
  window.addEventListener("input", onInput, opt);
  window.addEventListener("wheel", onWheel, opt);
  window.addEventListener("scroll", onScroll, opt);
  window.addEventListener("resize", onScroll, opt);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (!windowHidden()) schedule(); });
}

function observer(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver !== "function") return io;
  io = new IntersectionObserver((list) => {
    for (const it of list) { const e = byEl.get(it.target); if (e) e.onScreen = it.isIntersecting; }
    schedule();
  });
  return io;
}

/** Join the bus. Returns the leave function. */
export function joinLiving(m: LivingMember): () => void {
  install();
  const e: Entry = { m, onScreen: true, last: null, quiet: false };
  entries.set(m, e);
  byEl.set(m.el, e);
  observer()?.observe(m.el);
  schedule();
  return () => { entries.delete(m); byEl.delete(m.el); io?.unobserve(m.el); };
}
/** Something about a member changed (its pose, its base look): look again soon, and again once a
 *  card has had time to mount. */
export function livingRefresh(): void { schedule(); scheduleAt(300); }

/** The user is reading: every avatar holds still for `ms` (a longer read wins). */
export function livingReading(ms: number): void {
  const until = now() + ms;
  if (until <= readingUntil) return;
  readingUntil = until;
  scheduleAt(ms);
  schedule();
}
export function livingReadingUntil(): number { return readingUntil; }

const same = (a: Look | null, b: Look | null) => (a === null || b === null ? a === b : Math.abs(a.nx - b.nx) < 0.03 && Math.abs(a.ny - b.ny) < 0.03);
const inView = (r: Box) => r.width > 0 && r.height > 0 && r.top + r.height > 0 && r.left + r.width > 0 &&
  r.top < (typeof window !== "undefined" ? window.innerHeight : Infinity) && r.left < (typeof window !== "undefined" ? window.innerWidth : Infinity);
const centre = (r: Box) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * One avatar's outside look, in priority order: a focused secret field (look away), the pointer nearby,
 * the composer while the user types (the open Bot only), the button it waits on, the caller's
 * own look. Exported for tests.
 */
export function chooseLook(r: Box, ctx: {
  pointer: { x: number; y: number } | null; secret: Box | null; composer: Box | null; typing: boolean;
  isActive: boolean; waiting: boolean; button: Box | null; base: Look | null;
}): Look | null {
  // A focused secret field wins over everything, the pointer included: while a password has focus,
  // every Bot looks away.
  if (ctx.secret) { const c = centre(ctx.secret); return lookAway(gazeAt(r, c.x, c.y)); }
  if (ctx.pointer && pointerNear(r, ctx.pointer.x, ctx.pointer.y)) return gazeAt(r, ctx.pointer.x, ctx.pointer.y);
  if (ctx.typing && ctx.isActive && ctx.composer) { const c = centre(ctx.composer); return gazeAt(r, c.x, c.y); }
  if (ctx.waiting && ctx.isActive && ctx.button) { const c = centre(ctx.button); return gazeAt(r, c.x, c.y); }
  return ctx.base;
}

function sweep(): void {
  if (entries.size === 0 || windowHidden()) return;
  const t = now();
  const doc = typeof document !== "undefined" ? document : null;
  const focused = doc?.activeElement as (HTMLElement & HTMLInputElement) | null;
  const secretEl = isSecretField(focused) ? focused : null;
  const secret = secretEl ? secretEl.getBoundingClientRect() : null;
  const typing = t < typingUntil;
  const composerEl = typing ? doc?.querySelector(COMPOSER) : null;
  const composer = composerEl ? composerEl.getBoundingClientRect() : null;
  let button: Box | null | undefined; // read once, only if a waiting Bot needs it
  const active = useUi.getState().activeBotId;
  const reading = t < readingUntil;
  for (const e of entries.values()) {
    const { m } = e;
    let changed = false;
    if (e.quiet !== reading) { e.quiet = reading; setFaceQuiet(m.sim, reading); changed = true; }
    if (e.onScreen && m.el.isConnected) {
      const r = m.el.getBoundingClientRect();
      if (r.width > 0) {
        const waiting = m.sim.act === "needs-you";
        if (waiting && button === undefined) { const b = doc?.querySelector(WAITING_BUTTON)?.getBoundingClientRect() ?? null; button = b && inView(b) ? b : null; }
        const look = chooseLook(r, { pointer, secret, composer, typing, isActive: m.botId === active, waiting, button: button ?? null, base: m.base });
        if (!same(look, e.last)) { e.last = look; setFaceLook(m.sim, look); changed = true; }
      }
    }
    if (changed) m.wake();
  }
}

/** Tests: run the sweep now (no animation frame). */
export function livingSweepNow(): void { if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame); frame = null; sweep(); }
/** Tests: forget the pointer, typing and reading state. */
export function resetLivingBus(): void { pointer = null; typingUntil = 0; readingUntil = 0; }
export function setLivingPointer(p: { x: number; y: number } | null): void { pointer = p; }

// ---------- the call's nod ----------
/** The Bot's "Mm" landed: its avatars nod. */
export function livingNod(botId: string): void {
  for (const m of entries.keys()) if (m.botId === botId) { faceNod(m.sim); m.wake(); }
}

// ---------- hand-offs ----------
function visibleOf(botId: string): { m: LivingMember; box: Box }[] {
  const out: { m: LivingMember; box: Box }[] = [];
  for (const e of entries.values()) {
    if (e.m.botId !== botId || !e.onScreen || !e.m.el.isConnected) continue;
    const box = e.m.el.getBoundingClientRect();
    if (inView(box)) out.push({ m: e.m, box });
  }
  return out;
}

/**
 * One Bot handed work or a message to another. If both are on screen (the call row, a group chat,
 * the sidebar), a small orb in the sender's colour arcs from one to the other and the receiver
 * catches it. Reduced motion: no flight; the receiver's catch is its still acknowledgement.
 * Returns whether anything played.
 */
export function livingHandoff(from: string, to: string): boolean {
  if (from === to || windowHidden()) return false;
  const pair = handoffPair(visibleOf(from), visibleOf(to));
  if (!pair) return false;
  const [a, b] = pair;
  const land = () => { faceCatch(b.m.sim, avatarNow()); b.m.wake(); };
  const el = typeof document !== "undefined" ? document.createElement("div") : null;
  if (!el || prefersReducedMotion() || a.m.sim.rm || typeof el.animate !== "function") { land(); return true; }
  const s = Math.round(Math.min(12, Math.max(7, a.box.width * 0.22)));
  const ax = a.box.left + a.box.width / 2, ay = a.box.top + a.box.height * 0.4;
  const bx = b.box.left + b.box.width / 2, by = b.box.top + b.box.height * 0.4;
  const lift = Math.min(90, 24 + Math.hypot(bx - ax, by - ay) * 0.25), bow = orbBow(ax, ay, bx, by);
  el.className = "living-orb";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `position:fixed;left:0;top:0;width:${s}px;height:${s}px;border-radius:50%;background:${a.m.color};pointer-events:none;z-index:2147483000`;
  document.body.appendChild(el);
  const N = 16, frames: Keyframe[] = [];
  for (let i = 0; i <= N; i++) {
    const p = orbPoint(ax, ay, bx, by, i / N, lift, bow);
    frames.push({ transform: `translate(${(p.x - s / 2).toFixed(1)}px, ${(p.y - s / 2).toFixed(1)}px) scale(${(1 - 0.35 * (i / N)).toFixed(3)})` });
  }
  const anim = el.animate(frames, { duration: ORB_MS, easing: "linear", fill: "forwards" });
  const done = () => { el.remove(); land(); };
  anim.onfinish = done;
  anim.oncancel = () => el.remove();
  return true;
}
