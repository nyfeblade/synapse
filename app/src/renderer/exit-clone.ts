/**
 * Shared plumbing for an exit-fade clone (Menus.tsx's `beginMenuExit`, DetailsPanel.tsx's
 * `beginPanelExit`, fix rounds 1–2, docs/sdd 2026-09-23). Both play a menu's or the right panel's
 * 120ms opacity-only close on a DETACHED CLONE of the live element, appended to `<body>` the instant
 * before React removes the real one — never on the real, interactive element, so the real component's
 * own close/unmount timing is untouched (see either call site's own comment for why that matters).
 *
 * Fix round 2: a clone is a snapshot, and it kept every attribute the live element had — including
 * its `id`s. Those ids are still "live" in the sense that a FRESH instance of the same view can mint
 * the exact same one while the ghost is still fading beside it (BotSettingsPanel's `#model-label` /
 * `#effort-label`, RoutineDetail's `#routine-when` — switching Bots with Settings open remounts the
 * SAME ids right behind the closing one's clone). Two elements sharing an id is not an error the DOM
 * raises; it is a silent one `getElementById` and any `aria-labelledby` / `aria-describedby` /
 * `aria-controls` / `<label for>` pointed at it only notice by resolving to whichever element the
 * engine happens to prefer.
 */
export function sanitizeExitClone(clone: HTMLElement): void {
  clone.setAttribute("aria-hidden", "true");
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
    clone.removeAttribute(attr);
    clone.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
  }
  // Belt-and-braces: `inert` drops the whole subtree from hit-testing, the tab order and the
  // accessibility tree in one attribute, on top of whatever per-control disabling each call site
  // still does (a <button>'s `disabled`, which `inert` alone does not set).
  clone.setAttribute("inert", "");
}

/** Removes `clone` once its exit animation ends — `animationend`, with a fallback timeout for jsdom
 *  (which never fires one) and for a dropped frame in the real browser. Reduced motion skips the wait
 *  entirely: CSS already collapses the animation, so there is nothing to wait for. */
export function scheduleExitRemoval(clone: HTMLElement, fallbackMs: number): void {
  const finish = () => clone.remove();
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) { finish(); return; }
  const t = window.setTimeout(finish, fallbackMs);
  // Only the clone's OWN fade ends the exit: a child's animationend (anything still animating inside
  // the snapshot) bubbles here too and must not cut the fade short.
  const onEnd = (e: Event) => {
    if (e.target !== clone) return;
    clone.removeEventListener("animationend", onEnd);
    window.clearTimeout(t);
    finish();
  };
  clone.addEventListener("animationend", onEnd);
}
