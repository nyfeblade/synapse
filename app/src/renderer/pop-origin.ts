import { useLayoutEffect, type RefObject } from "react";

/**
 * Popovers grow OUT OF what opened them ("ultra liquid", decisions.md). app.css's `pop-in` scales a
 * menu or listbox up from 0.96 on the pop spring; this picks the transform-origin that makes the
 * scale start at the trigger: the trigger's edge-centre nearest the popover (its bottom when the
 * popover opens below, its top when above), or the pointer for a menu opened at a click. Expressed in
 * the popover's own box and clamped to it. Menus.tsx already does this for its anchor point.
 */
export type Anchor = DOMRect | { x: number; y: number };

export function originFrom(trigger: Anchor, pop: DOMRect): string {
  let px: number;
  let py: number;
  if ("width" in trigger) {
    px = trigger.left + trigger.width / 2;
    py = pop.top >= trigger.bottom - 1 ? trigger.bottom : pop.bottom <= trigger.top + 1 ? trigger.top : trigger.top + trigger.height / 2;
  } else {
    px = trigger.x;
    py = trigger.y;
  }
  const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), max));
  return `${clamp(px - pop.left, pop.width)}px ${clamp(py - pop.top, pop.height)}px`;
}

/**
 * Sets `pop`'s transform-origin from `anchor()` when it opens, in a layout effect: before the first
 * paint, so the entrance never starts from the wrong point. One read of each box, one style write.
 */
export function usePopOrigin(pop: RefObject<HTMLElement | null>, anchor: () => Anchor | null | undefined, open: boolean): void {
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    const a = anchor();
    if (a) el.style.transformOrigin = originFrom(a, el.getBoundingClientRect());
  }, [open]);
}
