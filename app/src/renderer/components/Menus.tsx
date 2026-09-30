import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { sanitizeExitClone, scheduleExitRemoval } from "../exit-clone";
import { useOverlayLayer } from "./Dialog";
import { CheckIcon, ChevronRightIcon } from "./Icons";

export type MenuItem =
  /** `checked`: one of a set of choices (a small picker); drawn as a menuitemradio with a check on the chosen one. */
  | { label: string; danger?: boolean; disabled?: boolean; title?: string; checked?: boolean; submenu?: boolean; /** A short tag after the label (a model's badge). */ badge?: string; onSelect(): void }
  /** A hairline divider between two groups of items (the account menu, Marketplace ahead of Settings).
   *  Not a button: it carries no label and no onSelect, so it is invisible to `enabled()`'s roving
   *  focus below and to `focusables()` (Dialog.tsx) — arrow keys, Tab and autofocus all skip it the
   *  same way they skip a disabled item, without any extra code here. */
  | { separator: true };

/**
 * Fix round 1 (docs/sdd, 2026-09-23; controller ruling — "nothing snaps" reaches a menu's exit too).
 * Runs the 120ms opacity-only exit on a DETACHED CLONE, appended to `<body>` at the instant the real
 * menu unmounts, instead of delaying the real unmount itself. Delaying the real unmount was the first
 * shape this took, and it broke on its own foundation: the account/context menu is remounted by its
 * caller (`{state && <Menu .../>}`, every call site) rather than toggled by a prop, so re-opening the
 * SAME slot while a previous close was still "pending" landed on the SAME component instance, stuck
 * mid-exit with its interactive content already stripped — `role="menuitem"` items rendered
 * `disabled` and invisible to the very "click More again" a real caller does (message-actions.test.tsx
 * caught this exactly). A clone sidesteps it completely: the real `<Menu>` closes exactly as fast as
 * it always did — same tick, same overlay-stack/focus-return timing (menu-keyboard.test.tsx is
 * unchanged) — so a re-open is a fresh mount with no memory of the old one, and the fading ghost is a
 * second, disconnected element nobody queries by role because it no longer has one.
 *
 * Fix round 2: a menu's own items carry no ids today, but `sanitizeExitClone` strips them (and
 * `for`/`aria-labelledby`/`aria-describedby`/`aria-controls`, plus sets `inert`) regardless — the
 * same helper DetailsPanel.tsx's clone uses, so neither call site can drift out of sync with the
 * other on what "a safe, inert snapshot" means.
 */
function beginMenuExit(node: HTMLDivElement | null): void {
  if (!node || !node.isConnected) return;
  const clone = node.cloneNode(true) as HTMLDivElement;
  // A closed menu must never be announced or operable: drop the role/name and disable every item,
  // rather than deleting them — deleting them would collapse the box to its padding mid-fade.
  clone.removeAttribute("role");
  clone.removeAttribute("aria-label");
  clone.classList.add("leaving");
  sanitizeExitClone(clone);
  for (const el of clone.querySelectorAll<HTMLButtonElement>("button")) { el.disabled = true; el.tabIndex = -1; }
  document.body.appendChild(clone);
  scheduleExitRemoval(clone, 160);
}

/**
 * Small popover menu with arrow-key and Esc support (UI-05).
 *
 * That sentence used to be a claim rather than a fact: `role="menu"` sat on the element and nothing
 * handled Up, Down, Home or End, so the role promised the keyboard something the component did not
 * deliver. Escape closed the menu and left focus on <body>, because the item that had focus was the
 * thing being unmounted.
 *
 * A menu is a layer, not a detail of whatever rendered it. Menus open from inside dialogs — the
 * skills manager's Import menu, a message's More menu — so this goes on the overlay stack: Escape
 * reaches the menu and stops there instead of being taken by the dialog underneath, and focus goes
 * back to the trigger when it closes. Tab closes it too, which is what a menu does: hand the trigger
 * back and let the browser carry on from there.
 */
/** `anchor: "bottom"` treats `y` as the menu's BOTTOM edge, so a menu opened from a row at the foot
 *  of the window grows upward from just above it instead of covering it (the account menu). */
export function Menu({ items, x, y, label, onClose, anchor = "top" }: { items: MenuItem[]; x: number; y: number; label: string; onClose(): void; anchor?: "top" | "bottom" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Keep the whole menu on screen (the composer's + menu opens at the window's bottom edge).
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const m = 8;
    const top = anchor === "bottom" ? y - r.height : y;
    setPos({ left: Math.max(m, Math.min(x, window.innerWidth - r.width - m)), top: Math.max(m, Math.min(top, window.innerHeight - r.height - m)) });
  }, [x, y, items.length, anchor]);
  // Focus-in (the first item), Escape and the hand-back all come from the layer. `trap: false`,
  // because Tab out of a menu is a real gesture — handled below — not something to swallow.
  useOverlayLayer({ onClose, panelRef: ref, trap: false });

  // Fix round 1: play the exit on a clone of whatever this node looked like right before React tears
  // it down for real. An unmount-only effect (empty deps): its cleanup runs once, synchronously, as
  // part of the same commit that removes this component — before the DOM node itself is detached, so
  // there is still something connected to clone.
  useLayoutEffect(() => () => beginMenuExit(ref.current), []);

  const enabled = (): HTMLButtonElement[] => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem], [role=menuitemradio]") ?? [])].filter((b) => !b.disabled);
  const move = (delta: number, to?: "first" | "last") => {
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = to === "first" ? 0 : to === "last" ? list.length - 1 : ((at < 0 ? -1 : at) + delta + list.length) % list.length;
    list[next]!.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); move(0, "first"); }
    else if (e.key === "End") { e.preventDefault(); move(0, "last"); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };

  // Every caller passes a fresh inline `onClose`, so keying this on it would re-install the listener
  // on each parent re-render — several times a second while a Bot streams.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    // UI-controls pass (2026-09-29): the menu is placed once, in window coordinates, when it opens. A
    // window resized under it (dragged, zoomed, the 1024 floor) left it at the old coordinates — measured
    // wholly outside a 1024x680 window after opening at 1440x900. A macOS menu closes when its window
    // resizes; so does this one, which keeps every open menu inside the window it belongs to.
    const onResize = () => closeRef.current();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("resize", onResize); };
  }, []);

  return (
    <div ref={ref} role="menu" aria-label={label} className="menu" style={{ left: pos.left, top: pos.top, transformOrigin: anchor === "bottom" ? `${x - pos.left}px 100%` : `${x - pos.left}px ${y - pos.top}px` }} onKeyDown={onKeyDown}>
      {items.map((it, i) => "separator" in it
        ? <div key={`separator-${i}`} role="separator" className="menu-separator" />
        : (
          <button key={it.label} type="button" role={it.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.checked} aria-haspopup={it.submenu ? "menu" : undefined} disabled={it.disabled} title={it.title} className={it.danger ? "menu-item danger" : "menu-item"} onClick={() => { if (it.disabled) return; it.onSelect(); onClose(); }}>
            {it.label}{it.badge && <span className="model-badge">{it.badge}</span>}{it.checked && <CheckIcon className="menu-check" />}{it.submenu && <ChevronRightIcon size={12} className="menu-check" />}
          </button>
        ))}
    </div>
  );
}
