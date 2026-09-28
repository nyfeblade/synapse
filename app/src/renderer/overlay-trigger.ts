// ---------------------------------------------------------------------------
// "Restore the trigger", done at a moment that actually works.
//
// The audit's CRITICAL detail: two of the app's four restore-the-trigger idioms read
// `document.activeElement` inside a `useEffect`. By the time that effect runs, the control that
// opened the surface — a menu item — has already unmounted, so the saved trigger is a detached node
// and `.focus()` is a silent no-op. Settings opened from the account menu returned focus to <body>.
//
// Reading it in a `useLayoutEffect` is necessary but not sufficient: React runs a commit's
// layout-effect *cleanups* (the menu going away) before its layout-effect *creates* (the dialog
// arriving), so at capture time the menu item is already gone and `document.activeElement` is
// <body>. The trigger has to have been recorded BEFORE the opening interaction.
//
// So this module remembers the last few elements that held focus, from a document-level `focusin`
// listener installed at import — long before any surface opens. `captureTrigger()` prefers whatever
// is focused right now (correct for a dialog opened from a button, and for a dialog stacked over
// another dialog, where the trigger legitimately lives inside the layer below) and otherwise walks
// back through that history to the most recent element still attached to the document. The detached
// menu item is skipped; the account button behind it is what comes back.
// ---------------------------------------------------------------------------

const HISTORY = 8;
const recent: HTMLElement[] = [];

function remember(el: EventTarget | null): void {
  if (!(el instanceof HTMLElement) || el === document.body) return;
  const i = recent.indexOf(el);
  if (i >= 0) recent.splice(i, 1);
  recent.push(el);
  if (recent.length > HISTORY) recent.shift();
}

if (typeof document !== "undefined") document.addEventListener("focusin", (e) => remember(e.target), true);

/**
 * The element a surface should hand focus back to when it closes, or null if there isn't one.
 *
 * `panel` is the surface that is opening, and everything inside it is disqualified. React applies
 * `autoFocus` during the COMMIT phase — before layout effects — so by the time a surface reads the
 * trigger, its own autofocused input already holds focus. The command palette caught exactly this:
 * it saved its own search box as the trigger, and on close that box was detached, so focus went to
 * <body>. Same failure mode as the detached menu item, arriving from the other direction.
 */
export function captureTrigger(panel?: HTMLElement | null): HTMLElement | null {
  const usable = (el: HTMLElement | null): boolean => !!el && el !== document.body && el.isConnected && !panel?.contains(el);
  const active = document.activeElement;
  if (active instanceof HTMLElement && usable(active)) return active;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (usable(recent[i]!)) return recent[i]!;
  }
  return null;
}

/** Tests only. */
export function resetTriggerHistory(): void { recent.length = 0; }
