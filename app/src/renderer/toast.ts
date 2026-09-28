import { STRG } from "@synapse/shared";

/** How long the confirmation stays up before it starts leaving. Matches ConnectGoogleSheet's 1500ms. */
const VISIBLE_MS = 1500;
/** The exit animation's length. Must stay equal to --motion-tap, or the toast is cut off mid-fade. */
const LEAVE_MS = 120;

let live: { el: HTMLElement; timers: number[] } | null = null;

function dismiss(): void {
  if (!live) return;
  for (const t of live.timers) clearTimeout(t);
  live.el.remove();
  live = null;
}

/**
 * Copy confirmation (docs/motion-spec.md §7.5).
 *
 * This is a correctness fix that happens to be delivered as motion. Five call sites — three items in
 * the message "…" menu, the tray's request-id button and RoutineDetail's copy buttons — wrote to the
 * clipboard and gave no feedback whatsoever, so a successful copy and a misclick looked identical.
 *
 * Imperative on purpose. One toast is shared by five unrelated components in three different trees;
 * threading per-site React state through all of them would be five copies of the same state machine
 * and five chances to get the teardown wrong. The element reuses the shipped `.link-copied` styling
 * and its entrance/exit keyframes, so reduced motion collapses it through the universal CSS block.
 */
export function confirmCopy(label: string = STRG.copied): void {
  dismiss(); // A second copy replaces the first rather than stacking two toasts on one spot.
  const el = document.createElement("span");
  el.className = "link-copied";
  el.setAttribute("role", "status");
  el.textContent = label;
  document.body.appendChild(el);
  live = {
    el,
    timers: [
      window.setTimeout(() => el.classList.add("leaving"), VISIBLE_MS),
      window.setTimeout(dismiss, VISIBLE_MS + LEAVE_MS),
    ],
  };
}

/**
 * Copy `text` to the clipboard and confirm it. Every copy site in the renderer goes through here.
 * A rejected clipboard write shows nothing, because nothing was copied and a confirmation would be a
 * lie — which is the same defect as silence, pointed the other way.
 */
export async function copyWithConfirmation(text: string, label?: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    return;
  }
  confirmCopy(label);
}
