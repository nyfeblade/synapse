import { useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { topOverlayPanel, useOverlayStack } from "../overlay-stack";

// ---------------------------------------------------------------------------
// WHERE AN ANNOUNCEMENT GOES — the fix for bug 46, and for its class: a single global reader for
// state that any surface can write, mounted somewhere that is not always visible.
//
// `actionError` is the renderer's catch-all failure route. Ten call sites write it directly and
// `bridge.ts`'s `call()` reports every rejection into it by default, so a Bot action, a Settings
// toggle, a palette row and a template import all end up in the same place. That place was one
// `role="alert"` inside `<nav class="sidebar">`, and `.sidebar` declares no `z-index` at all — so
// the announcement painted under `.computer-view` (z-index 40, opaque) and under `.scrim`
// (z-index 50). A cover being up is not independent of something failing: three of the writers
// (`GoogleToggle`, `AdvancedSettingsCard`, `theme.ts`) are controls that live INSIDE Settings.
//
// NOT RAISING THE SIDEBAR. The one-line fix — give `.sidebar` a z-index above the scrim — puts a
// navigation bar over a modal, which is its own defect, and it leaves the alert outside the
// dialog's `aria-modal="true"`, where a screen reader is entitled to ignore it. Both halves of the
// bug are about the announcement being in the wrong PLACE, not at the wrong height.
//
// THE MECHANISM. The overlay stack already answers "which surface is on top", and bug 31 tied that
// answer to the stylesheet's painting order, so it is the same as "which surface can the user see".
// `AnnounceOutlet` renders one strip into that surface; `Announce` puts its children in the strip
// when there is one and leaves them where they are when there is not. So:
//
//  - OWNERSHIP. Exactly one copy exists at any moment — it MOVES rather than being duplicated, so a
//    second alert under the cover is structurally impossible rather than merely unlikely. This is
//    the shape `TeachSurface` (TeachBanner.tsx) settled on for bug 42.
//  - UNCOVERED IS UNCHANGED. With nothing on the stack the alert renders in the sidebar's foot and
//    the box banner at the top of the window, exactly where each has always been.
//  - NOTHING IS LOST ON CLOSE. The message lives in the store, not in the surface, so an error
//    raised behind a cover and still unread when the cover closes simply re-renders in the chrome,
//    same text, same Dismiss. Nothing has to be replayed, and nothing can be dropped on the way.
//  - IT IS ANNOUNCED. Inside the panel means inside `aria-modal`, so `role="alert"` is read out
//    rather than being hidden with the rest of the page behind the modal.
// ---------------------------------------------------------------------------

/** The strip element, published so `Announce` can portal into it from anywhere in the tree. */
const useOutlet = create<{ el: HTMLElement | null }>(() => ({ el: null }));

/**
 * Mounted once, by `App`. Draws the announcement strip inside whichever surface is on top, and
 * nothing at all while the app is uncovered.
 */
export function AnnounceOutlet() {
  useOverlayStack((s) => s.ids); // re-render whenever the surface on top changes
  const panel = topOverlayPanel();
  // A callback ref rather than an effect: it runs in the same commit as the portal, so an
  // announcement raised in the very act that opened the surface lands on it without a frame in between.
  const ref = useCallback((el: HTMLDivElement | null) => useOutlet.setState({ el }), []);
  return panel ? createPortal(<div ref={ref} className="surface-announce" />, panel) : null;
}

/** Put an announcement where the user is looking: on the top surface, or in place when nothing covers it. */
export function Announce({ children }: { children: ReactNode }) {
  const el = useOutlet((s) => s.el);
  return el ? createPortal(children, el) : <>{children}</>;
}
