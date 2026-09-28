import { create } from "zustand";

// ---------------------------------------------------------------------------
// One overlay stack for the whole app.
//
// Before this, thirteen overlays each hand-rolled `window.addEventListener("keydown", …)` and each
// independently decided whether it was the topmost layer with an ad-hoc predicate: `!sheetAbove`,
// `!useUi.getState().settingsOpen`, `useOverlays.getState().open`, `!editingAvatar`, and a
// capture-phase listener with no predicate at all. Those predicates were pairwise — each knew about
// the surfaces that existed when it was written and nothing added since — so one Escape closed two
// stacked surfaces, and ⌘N / ⌘, navigated the app underneath a modal.
//
// The stack replaces all of them with one rule: the top of the stack owns Escape and it stops there,
// and a chord that would navigate the app *underneath* an overlay is suppressed while the stack is
// non-empty (`overlaysOpen()`).
//
// The Escape listener is on `window` in the BUBBLE phase on purpose. A field with a half-typed edit
// (the Settings auto-review rule) handles its own Escape and calls `stopPropagation()`, so the event
// never reaches the stack and the surface does not get thrown away underneath the edit. Innermost
// handler first, then the topmost layer, then nothing.
// ---------------------------------------------------------------------------

/**
 * How high a layer PAINTS, which is a different question from when it pushed.
 *
 * Bug 31: the stack ranked layers by the moment they pushed and the stylesheet ranked them by
 * z-index, and nothing tied the two together — so a layer could be top of the stack, owning Escape
 * and the focus trap, while painting underneath the layer the user was actually looking at. The
 * computer view is the app's one page-level surface (`.computer-view`, z-index 40): a full-window
 * view of a Bot's screen that transient surfaces open OVER. Everything else is a modal on the
 * shared `.scrim` at z-index 50. A layer never sits above one that paints above it.
 *
 * Declared rather than measured: jsdom loads no stylesheet, so `getComputedStyle(...).zIndex` is
 * "auto" in every test that drives these surfaces. `overlay-hand-rolling.test.ts` ties the two
 * names back to the real z-indexes so the declaration cannot drift from the CSS.
 */
export type OverlayLayer = "page" | "modal";
const RANK: Record<OverlayLayer, number> = { page: 0, modal: 1 };

/** Each layer's close handler, kept in a ref-like box so a re-render never has to touch the store. */
const handlers = new Map<string, { current: () => void }>();
/** Each layer's panel element, used to keep the stack's order the same as the DOM's nesting. */
const panels = new Map<string, HTMLElement>();
/** Each layer's paint rank. Absent means "modal", the default every surface but the computer view takes. */
const ranks = new Map<string, number>();
const rankOf = (id: string): number => ranks.get(id) ?? RANK.modal;

/** The layer ids, bottom of the stack first. Subscribable: components can react to depth changes. */
export const useOverlayStack = create<{ ids: string[] }>(() => ({ ids: [] }));

export const overlayDepth = (): number => useOverlayStack.getState().ids.length;
/** True while any overlay is open — the one guard a global chord needs. */
export const overlaysOpen = (): boolean => overlayDepth() > 0;
export const topOverlay = (): string | null => useOverlayStack.getState().ids.at(-1) ?? null;
export const isTopOverlay = (id: string): boolean => topOverlay() === id;

/**
 * The PANEL of the topmost layer that has one, or null while nothing covers the app.
 *
 * The stack already answers "which surface is on top" for Escape and the focus trap, and bug 31 tied
 * that answer to the stylesheet's painting order, so it is also the answer to "which surface can the
 * user see". Bug 46 needs the element rather than the id: an announcement that any surface can raise
 * — a failed action, a box lifecycle step — is rendered INTO this node, so it is inside the surface
 * the user is looking at (and inside its `aria-modal`, where a screen reader will still read it)
 * rather than behind it. A layer that pushed without a panel is skipped rather than treated as a
 * cover, because an announcement put nowhere is the defect itself.
 */
export function topOverlayPanel(): HTMLElement | null {
  const { ids } = useOverlayStack.getState();
  for (let i = ids.length - 1; i >= 0; i--) {
    const p = panels.get(ids[i]!);
    if (p?.isConnected) return p;
  }
  return null;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const id = topOverlay();
  if (!id) return;
  // stopImmediatePropagation, not stopPropagation: "the top of the stack handles it and stops" has
  // to mean every other window listener too, since that is where all thirteen surfaces used to put
  // theirs. Listeners registered ahead of this one still run — they are guarded by `overlaysOpen()`.
  e.preventDefault();
  e.stopImmediatePropagation();
  handlers.get(id)?.current();
}

let listening = false;
function listen(on: boolean): void {
  if (on === listening || typeof window === "undefined") return;
  listening = on;
  if (on) window.addEventListener("keydown", onKeyDown);
  else window.removeEventListener("keydown", onKeyDown);
}

/**
 * Where a newly-opened layer belongs.
 *
 * Normally the end: layers open one after another, and the last one to open is on top. Two things
 * override that, both of them cases where "last to push" is not "on top":
 *
 *  - PAINT RANK. A layer never goes above one that paints above it. The computer view is page-level
 *    and can be raised while a modal already covers the app (the Take-over route, a display event),
 *    and before bug 31 it then owned Escape and pulled focus behind the modal's scrim.
 *  - DOM CONTAINMENT. A layer that mounts in the SAME commit as one nested inside it: React runs
 *    layout effects child-first, so the inner layer pushes first. A layer whose panel contains an
 *    already-pushed layer's panel goes underneath it — within its own rank band.
 */
function insertionIndex(ids: string[], panel: HTMLElement | null, rank: number): number {
  let end = ids.length;
  while (end > 0 && rankOf(ids[end - 1]!) > rank) end--;
  if (!panel) return end;
  for (let i = end - 1; i >= 0; i--) {
    const p = panels.get(ids[i]!);
    if (p && p !== panel && panel.contains(p)) return i;
  }
  return end;
}

export function pushOverlay(id: string, close: () => void, panel?: HTMLElement | null, layer: OverlayLayer = "modal"): void {
  handlers.set(id, { current: close });
  if (panel) panels.set(id, panel);
  ranks.set(id, RANK[layer]);
  useOverlayStack.setState((s) => {
    const ids = s.ids.filter((x) => x !== id);
    ids.splice(insertionIndex(ids, panel ?? null, RANK[layer]), 0, id);
    return { ids };
  });
  listen(true);
}

/** Keep a layer's close handler current without reordering the stack (called on every render). */
export function setOverlayClose(id: string, close: () => void): void {
  const box = handlers.get(id);
  if (box) box.current = close;
}

export function removeOverlay(id: string): void {
  handlers.delete(id);
  panels.delete(id);
  ranks.delete(id);
  useOverlayStack.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  if (!overlayDepth()) listen(false);
}

/** Tests only: drop every layer and detach the listener. */
export function resetOverlayStack(): void {
  handlers.clear();
  panels.clear();
  ranks.clear();
  useOverlayStack.setState({ ids: [] });
  listen(false);
}
