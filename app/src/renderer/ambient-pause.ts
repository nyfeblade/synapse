// Bug #100: the app's ambient loops (the avatars' idle sway, breathing and drift; the infinite CSS
// pulses and shimmers) rest while nobody is looking at them. Two signals:
//
//  - The window is blurred or hidden: `html.motion-paused` is set, which pauses every infinite CSS
//    loop (app.css), and `ambientPaused()` tells the avatar loop to tick only avatars mid-transition.
//    Live state changes still render: a one-shot or a presence change is not an ambient loop.
//  - An element with an infinite loop is scrolled out of view: `loopInView` (a React callback ref)
//    gives it `.loop-offscreen` while it does not intersect the viewport, which pauses its loop.

type Listener = () => void;
const listeners = new Set<Listener>();
let focused = true;
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export function ambientPaused(): boolean { return !focused || hidden(); }
export function windowHidden(): boolean { return hidden(); }

/** Subscribe to pause/resume changes. Returns the unsubscribe function. */
export function onAmbientChange(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function sync(): void {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("motion-paused", ambientPaused());
  for (const fn of listeners) fn();
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("blur", () => { focused = false; sync(); });
  window.addEventListener("focus", () => { focused = true; sync(); });
  document.addEventListener("visibilitychange", sync);
}

let io: IntersectionObserver | null = null;
function observer(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver !== "function") return io;
  io = new IntersectionObserver((list) => { for (const it of list) it.target.classList.toggle("loop-offscreen", !it.isIntersecting); });
  return io;
}
/** Callback ref for an element that runs an infinite CSS loop: the loop pauses while it is off screen. */
export function loopInView(el: Element | null): (() => void) | void {
  const o = el ? observer() : null;
  if (!el || !o) return;
  o.observe(el);
  return () => { o.unobserve(el); el.classList.remove("loop-offscreen"); };
}
