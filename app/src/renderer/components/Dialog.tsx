import { useId, useLayoutEffect, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { isTopOverlay, pushOverlay, removeOverlay, setOverlayClose, type OverlayLayer } from "../overlay-stack";
import { captureTrigger } from "../overlay-trigger";

// ---------------------------------------------------------------------------
// The one modal-surface primitive. `VoiceOverlay` was the app's only keyboard-complete overlay and
// it is this primitive's shape: focus moves in on open, Tab cycles inside, Escape closes the topmost
// layer, and focus goes back to whatever opened it. Everything here was previously re-implemented,
// differently and incompletely, in thirteen places.
//
// Two entry points:
//   <Dialog>          scrim + role="dialog" panel + the behaviour, for a surface with no special markup.
//   useOverlayLayer() the behaviour alone, for a surface that draws its own frame (ComputerView has no
//                     scrim; AvatarEditor renders inside another sheet).
// ---------------------------------------------------------------------------

/** Everything the user can reach with Tab inside a surface, in DOM order. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => !el.hasAttribute("disabled") && !el.hasAttribute("hidden") && el.tabIndex >= 0);
}

type PanelRef = RefObject<HTMLElement | null> | MutableRefObject<HTMLElement | null> | { current: HTMLElement | null };

export interface OverlayLayerOptions {
  /** False while the surface is closed but its component stays mounted (MarketplaceModal, the sheets). */
  active?: boolean;
  onClose(): void;
  panelRef: PanelRef;
  /** Move focus into the surface when it opens. Default true. */
  autoFocus?: boolean;
  /** Keep Tab inside the surface while it is the topmost layer. Default true. */
  trap?: boolean;
  /** Hand focus back to the opener when it closes. Default true. */
  restore?: boolean;
  /**
   * How high this surface PAINTS. Default "modal" — the shared `.scrim`, z-index 50. "page" is the
   * full-window computer view at z-index 40, which transient surfaces open over: it joins the stack
   * for ordering and keeps every other part of the contract, but never sorts above a modal.
   */
  layer?: OverlayLayer;
  /**
   * Return false to let this Tab reach the focused control (the live VNC canvas) instead of
   * cycling chrome. Undefined / true keeps the trap. Free design for bug 32 — Tab while in
   * control and focus is inside `.cv-canvas` must go to the remote; F6 returns to the title bar.
   */
  passTab?: (e: KeyboardEvent) => boolean;
}

export function useOverlayLayer(opts: OverlayLayerOptions): { id: string } {
  const id = useId();
  const active = opts.active ?? true;
  const autoFocus = opts.autoFocus ?? true;
  const trap = opts.trap ?? true;
  const restore = opts.restore ?? true;
  const layer = opts.layer ?? "modal";
  // Every caller passes a fresh inline onClose; keying the effects on it would re-push the layer (and
  // re-steal focus) on each parent re-render — several times a second while a Bot streams.
  const closeRef = useRef(opts.onClose);
  closeRef.current = opts.onClose;
  const passTabRef = useRef(opts.passTab);
  passTabRef.current = opts.passTab;

  const trigger = useRef<HTMLElement | null>(null);
  /**
   * Hand focus back to the opener, if this surface still has it.
   *
   * Called twice on the usual route — once when the stack's Escape closes the layer, once when the
   * component unmounts — and the second call is a no-op, because by then focus is on the trigger and
   * no longer "held" here. Both are needed: a surface whose parent unmounts it (every sheet) is
   * covered by the second, and a surface that stays mounted after it is closed (AvatarEditor, which
   * its parent keeps rendered until a state flag flips) by the first. A close handler that
   * deliberately moves focus somewhere else is never overridden, because focus is then not held.
   */
  const handBack = (panel: HTMLElement | null) => {
    const back = trigger.current;
    if (!restore || !back?.isConnected) return;
    const a = document.activeElement;
    const held = !a || a === document.body || !(a instanceof HTMLElement) || !a.isConnected || (panel?.contains(a) ?? false);
    if (held) back.focus();
  };
  const onStackClose = useRef<() => void>(() => {});
  onStackClose.current = () => { closeRef.current(); handBack(opts.panelRef.current); };
  setOverlayClose(id, () => onStackClose.current());

  // useLayoutEffect throughout: it runs in the same commit as the open, so an Escape or a Tab pressed
  // straight after the click that opened the surface is never missed, and the trigger is read before
  // anything else can take focus.
  useLayoutEffect(() => {
    if (!active) return;
    const panel = opts.panelRef.current;
    trigger.current = captureTrigger(panel);
    pushOverlay(id, () => onStackClose.current(), panel, layer);
    // Only the layer that ended up ON TOP takes focus. A surface can open underneath one that is
    // already up — the page-level computer view raised while Settings covers the app — and focusing
    // it would put the caret on a control behind the scrim, which is the WCAG 2.4.11 failure the
    // stack exists to prevent.
    //
    // It does NOT then take focus when that layer closes, and the mechanism is worth stating because
    // the obvious reading is wrong: `restore` sends focus to the CLOSING layer's own trigger, which
    // lands inside this surface only when that is where the user opened it from (the Take-over
    // button). Opened with Cmd+, from the chat pane, Settings hands focus back to the chat pane and
    // the revealed surface never takes it. That is deliberate — the primitive does not steal focus
    // once the user has moved it — but nothing here promises otherwise.
    if (autoFocus && panel && isTopOverlay(id)) (focusables(panel)[0] ?? panel).focus();
    return () => {
      removeOverlay(id);
      // The captured node, not opts.panelRef.current: React has already nulled the ref by now.
      handBack(panel);
      trigger.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelRef is a stable ref box; the rest are read through refs.
  }, [active, id, autoFocus, restore, layer]);

  useLayoutEffect(() => {
    if (!active || !trap) return;
    // Capture phase, so the composer's and the palette's own key handling never sees a Tab meant for
    // this surface. Gated on isTopOverlay, so a stacked surface's trap does not fight the one above it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !isTopOverlay(id)) return;
      if (passTabRef.current?.(e) === false) return;
      const root = opts.panelRef.current;
      if (!root) return;
      e.preventDefault();
      const items = focusables(root);
      if (items.length === 0) { root.focus(); return; }
      // -1 when focus sits on the panel itself, or outside it (something covered stole focus).
      const i = items.indexOf(document.activeElement as HTMLElement);
      (e.shiftKey ? items[(i <= 0 ? items.length : i) - 1]! : items[(i + 1) % items.length]!).focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panelRef is a stable ref box.
  }, [active, trap, id]);

  return { id };
}

export interface DialogProps {
  label: string;
  onClose(): void;
  children: ReactNode;
  /** Class on the role="dialog" panel. */
  className?: string;
  /** Class on the covering surface. Defaults to the app's shared `.scrim`. */
  scrimClassName?: string;
  /** False while the surface is closed but still mounted. */
  active?: boolean;
  /** aria-modal. False for a surface that genuinely does not cover the app. Default true. */
  modal?: boolean;
  /** A mousedown on the scrim closes the surface. Default true. */
  closeOnScrim?: boolean;
  autoFocus?: boolean;
  trap?: boolean;
  restore?: boolean;
  /** Extra attributes for the panel (data-*, aria-describedby…). */
  panelProps?: Record<string, string | undefined>;
}

export function Dialog({ label, onClose, children, className, scrimClassName = "scrim", active = true, modal = true, closeOnScrim = true, autoFocus, trap, restore, panelProps }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayLayer({ active, onClose, panelRef: panel, autoFocus, trap, restore });
  if (!active) return null;
  return (
    <div className={scrimClassName} onMouseDown={(e) => { if (closeOnScrim && e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal={modal ? "true" : undefined} aria-label={label} tabIndex={-1} className={className} {...panelProps}>
        {children}
      </div>
    </div>
  );
}
