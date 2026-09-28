import { flushSync } from "react-dom";
import { MOTION, prefersReducedMotion } from "./motion";

/**
 * Route/view changes (a Bot opened, New chat): the new main pane ARRIVES — it rises 6px and brightens
 * on the glide spring — while everything else stays put.
 *
 * WHY NOT A VIEW TRANSITION (motion glitches, decisions.md; bug log). This used to be
 * `document.startViewTransition`, with a sidebar-to-header Bot morph riding it. The motion check
 * (app/motion, headless) caught both breaking on every switch:
 * - DEAD CLICKS: for the whole 680ms a transition runs, Chromium hit-tests its overlay to <html>,
 *   `::view-transition { pointer-events: none }` notwithstanding. A second Bot clicked mid-switch was
 *   simply lost, so "switch quickly" did nothing.
 * - A BLANK HEADER: the morph's named header avatar and name drew nothing for ~650ms and then popped
 *   in, while the ghost flew over the sidebar with its name stretched to three times its size.
 * An animation on the real element has no overlay, so clicks land, and nothing is named, so nothing
 * can go blank. Compositor-only (opacity + transform), and it never starts from fully transparent, so
 * a fast run of switches never strobes. A change mid-flight cancels the running entrance and starts
 * the new one; the update itself is applied synchronously, as before.
 *
 * Reduced motion: the update only.
 */
const FROM: Keyframe = { opacity: 0.35, transform: "translateY(6px)" };
const TO: Keyframe = { opacity: 1, transform: "none" };
let running: Animation | null = null;

export function withViewChange(update: () => void): void {
  if (typeof document === "undefined") { update(); return; }
  flushSync(update);
  running?.cancel();
  running = null;
  if (prefersReducedMotion()) return;
  const main = document.querySelector<HTMLElement>(".main");
  if (!main || typeof main.animate !== "function") return;
  const a = main.animate([FROM, TO], { duration: MOTION.glide.duration, easing: MOTION.glide.easing });
  running = a;
  a.addEventListener?.("finish", () => { if (running === a) running = null; });
}
