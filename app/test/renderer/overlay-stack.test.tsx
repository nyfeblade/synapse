// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, useOverlayLayer } from "../../src/renderer/components/Dialog";
import { isTopOverlay, overlayDepth, overlaysOpen, resetOverlayStack, topOverlay } from "../../src/renderer/overlay-stack";
import { captureTrigger, resetTriggerHistory } from "../../src/renderer/overlay-trigger";

// ---------------------------------------------------------------------------
// The keyboard audit's structural finding, verbatim:
//
//   "This app has thirteen overlays and no dialog. Every surface hand-rolls its
//    own focus behaviour with a bare window.addEventListener('keydown', …) and,
//    if the author remembered, a locally-captured `trigger` ref — and each one
//    independently decides whether it is the topmost layer using an ad-hoc
//    predicate […] Those predicates are pairwise: each knows about the surfaces
//    that existed when it was written and nothing added since."
//
// One <Dialog> primitive plus one overlay stack. The stack gives Escape a single
// owner: the top of the stack handles it and stops. The primitive gives focus-in,
// focus-trap and restore-to-trigger to every surface at once.
//
// Almost everything below is jsdom-level: jsdom implements focus(), activeElement,
// focusin/focusout and event propagation, so these assertions are the same ones
// Playwright made against Chromium. The two exceptions are called out inline.
// ---------------------------------------------------------------------------

afterEach(() => { cleanup(); act(() => resetOverlayStack()); resetTriggerHistory(); });

function Surface({ label, onClose, children }: { label: string; onClose(): void; children?: React.ReactNode }) {
  return <Dialog label={label} onClose={onClose} className="test-surface">{children ?? <button type="button">{label} one</button>}</Dialog>;
}

describe("overlay stack — one owner for Escape", () => {
  it("is empty until a surface mounts, and reports its depth and top", () => {
    expect(overlayDepth()).toBe(0);
    expect(overlaysOpen()).toBe(false);
    expect(topOverlay()).toBeNull();
    render(<Surface label="One" onClose={() => {}} />);
    expect(overlayDepth()).toBe(1);
    expect(overlaysOpen()).toBe(true);
    expect(isTopOverlay(topOverlay()!)).toBe(true);
  });

  it("stacks in mount order and pops in unmount order", () => {
    function Two() {
      const [second, setSecond] = useState(true);
      return (<>
        <Surface label="Under" onClose={() => {}} />
        {second && <Surface label="Over" onClose={() => setSecond(false)} />}
      </>);
    }
    render(<Two />);
    expect(overlayDepth()).toBe(2);
    const over = topOverlay();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(overlayDepth()).toBe(1);
    expect(topOverlay()).not.toBe(over);
  });

  // The audit's defect 6: "One Escape closes two stacked surfaces: ComputerView+palette,
  // and Marketplace+Google sheet."
  it("one Escape closes exactly one surface — the topmost — and the one below never hears it", () => {
    const closed: string[] = [];
    function Two() {
      const [second, setSecond] = useState(true);
      return (<>
        <Surface label="Under" onClose={() => closed.push("under")} />
        {second && <Surface label="Over" onClose={() => { closed.push("over"); setSecond(false); }} />}
      </>);
    }
    render(<Two />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["over"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["over", "under"]);
  });

  // The audit's defect 8: "Escape inside a Settings text input throws away the whole
  // modal and the half-typed rule with it." The innermost handler gets first refusal.
  it("lets a field that handled Escape stop it: the surface does not close underneath the edit", () => {
    const closed: string[] = [];
    render(
      <Dialog label="With a field" onClose={() => closed.push("dialog")} className="test-surface">
        <input aria-label="Rule" onKeyDown={(e) => { if (e.key === "Escape") { closed.push("field"); e.stopPropagation(); } }} />
      </Dialog>,
    );
    const input = screen.getByLabelText("Rule");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(closed).toEqual(["field"]);
  });

  it("still closes the surface when the field did not want the Escape", () => {
    const closed: string[] = [];
    render(
      <Dialog label="With a field" onClose={() => closed.push("dialog")} className="test-surface">
        <input aria-label="Rule" onKeyDown={() => {}} />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByLabelText("Rule"), { key: "Escape" });
    expect(closed).toEqual(["dialog"]);
  });

  // The stack listens on window in the BUBBLE phase, deliberately: a field with a half-typed edit
  // gets first refusal (the test above). Being last, it cannot un-run a handler underneath — so it
  // marks the event, and the screens underneath are guarded by `overlaysOpen()` instead of by the
  // ad-hoc, pairwise predicates the audit found. That one rule is what replaces all five of them.
  it("marks Escape handled, so anything running alongside can tell it was consumed", () => {
    render(<Surface label="One" onClose={() => {}} />);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("gives a screen underneath one predicate to check instead of five", () => {
    const acted: string[] = [];
    // Exactly the shape of NewChat's own Escape handler, which used to fire behind the palette.
    const underneath = (e: KeyboardEvent) => { if (e.key === "Escape" && !overlaysOpen()) acted.push("navigated away"); };
    window.addEventListener("keydown", underneath);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(acted).toEqual(["navigated away"]);
    render(<Surface label="One" onClose={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", underneath);
    expect(acted, "nothing underneath an overlay may act on Escape").toEqual(["navigated away"]);
  });

  it("leaves Escape alone when nothing is open", () => {
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) seen.push("free"); };
    window.addEventListener("keydown", listener);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", listener);
    expect(seen).toEqual(["free"]);
  });
});

describe("Dialog primitive — focus in, trap, restore", () => {
  // The audit's defect 4: "Five surfaces put focus on <body> when they open."
  it("moves focus into the surface when it opens", () => {
    render(<Surface label="One" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "One" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("falls back to the panel itself when the surface has nothing focusable", () => {
    render(<Dialog label="Empty" onClose={() => {}} className="test-surface"><p>nothing to press</p></Dialog>);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Empty" }));
  });

  // The audit's defects 3 and 5: the palette had no trap (the FIRST Tab left it), and
  // Marketplace/ComputerView never trapped — Tab walked the whole app behind the modal.
  it("keeps Tab inside: focus never reaches a control behind the surface", () => {
    render(<>
      <button type="button">Behind</button>
      <Dialog label="Trapped" onClose={() => {}} className="test-surface">
        <button type="button">First</button><button type="button">Second</button>
      </Dialog>
    </>);
    const dialog = screen.getByRole("dialog", { name: "Trapped" });
    const behind = screen.getByRole("button", { name: "Behind" });
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(document.activeElement ?? window, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(behind);
    }
  });

  it("wraps at both edges", () => {
    render(<Dialog label="Trapped" onClose={() => {}} className="test-surface">
      <button type="button">First</button><button type="button">Second</button>
    </Dialog>);
    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it("pulls focus back in if a covered control steals it", () => {
    render(<>
      <button type="button">Behind</button>
      <Dialog label="Trapped" onClose={() => {}} className="test-surface"><button type="button">First</button></Dialog>
    </>);
    const behind = screen.getByRole("button", { name: "Behind" });
    behind.focus();
    fireEvent.keyDown(behind, { key: "Tab" });
    expect(screen.getByRole("dialog", { name: "Trapped" }).contains(document.activeElement)).toBe(true);
  });

  it("only the topmost surface traps: the one underneath keeps its hands off Tab", () => {
    render(<>
      <Dialog label="Under" onClose={() => {}} className="test-surface"><button type="button">Under one</button></Dialog>
      <Dialog label="Over" onClose={() => {}} className="test-surface"><button type="button">Over one</button><button type="button">Over two</button></Dialog>
    </>);
    const over = screen.getByRole("dialog", { name: "Over" });
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(document.activeElement ?? window, { key: "Tab" });
      expect(over.contains(document.activeElement)).toBe(true);
    }
  });

  it("hands focus back to the control that opened it", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (<>
        <button type="button" onClick={() => setOpen(true)}>Open it</button>
        {open && <Surface label="One" onClose={() => setOpen(false)} />}
      </>);
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "One" }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  // The audit's defect 7, and the detail it flagged as CRITICAL: two existing "restore the
  // trigger" idioms read document.activeElement inside a useEffect, by which time the opener
  // (a menu item) has already unmounted — the saved trigger is a detached node and .focus()
  // is a silent no-op. This is the menu-opened route, reproduced.
  it("restores the real opener when the control that was clicked has already unmounted", () => {
    function Host() {
      const [menu, setMenu] = useState(false);
      const [open, setOpen] = useState(false);
      return (<>
        <button type="button" onClick={() => setMenu(true)}>Account</button>
        {menu && <div role="menu" aria-label="Account">
          <button type="button" role="menuitem" onClick={() => { setOpen(true); setMenu(false); }}>Settings</button>
        </div>}
        {open && <Surface label="Settings" onClose={() => setOpen(false)} />}
      </>);
    }
    render(<Host />);
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.click(account);
    const item = screen.getByRole("menuitem", { name: "Settings" });
    item.focus();
    fireEvent.click(item); // the menu item unmounts in the same commit the dialog mounts in
    expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement, "a detached menu item is not a trigger — the account button is").toBe(account);
  });

  it("does not steal focus back if the user has already moved it somewhere else", () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (<>
        <button type="button" onClick={() => setOpen(false)}>Elsewhere</button>
        {open && <Surface label="One" onClose={() => setOpen(false)} />}
      </>);
    }
    render(<Host />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.click(elsewhere);
    expect(document.activeElement).toBe(elsewhere);
  });
});

// Proven with a probe against this very commit: on the menu route, `document.activeElement` at the
// dialog's useLayoutEffect is `BODY` — "layout: BODY/Account/connected=true". That is the audit's
// defect 7 exactly, and it is why reading activeElement at effect time cannot work on its own.
describe("captureTrigger — the detached-trigger problem", () => {
  it("prefers whatever holds focus right now", () => {
    const btn = document.createElement("button");
    document.body.append(btn);
    btn.focus();
    expect(captureTrigger()).toBe(btn);
    btn.remove();
  });

  it("falls back past a node that has already left the document to the one behind it", () => {
    const account = document.createElement("button");
    const item = document.createElement("button");
    document.body.append(account, item);
    account.focus();
    item.focus();
    item.remove(); // the menu item unmounts in the same commit the dialog mounts in
    expect(document.activeElement === document.body || !(document.activeElement as HTMLElement).isConnected).toBe(true);
    expect(captureTrigger(), "a detached node is not a trigger").toBe(account);
    account.remove();
  });
});

describe("useOverlayLayer — the same behaviour without the primitive's markup", () => {
  it("joins the stack, owns Escape and restores the trigger for a surface that draws itself", () => {
    const events: string[] = [];
    function Bare({ onClose }: { onClose(): void }) {
      const panel = { current: null as HTMLElement | null };
      const ref = (el: HTMLElement | null) => { panel.current = el; };
      useOverlayLayer({ onClose, panelRef: panel });
      return <div ref={ref} role="dialog" aria-label="Bare" tabIndex={-1}><button type="button">Bare one</button></div>;
    }
    function Host() {
      const [open, setOpen] = useState(false);
      return (<>
        <button type="button" onClick={() => setOpen(true)}>Open bare</button>
        {open && <Bare onClose={() => { events.push("close"); setOpen(false); }} />}
      </>);
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open bare" });
    opener.focus();
    fireEvent.click(opener);
    expect(overlayDepth()).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(events).toEqual(["close"]);
    expect(document.activeElement).toBe(opener);
  });

  it("stays out of the stack while it is inactive", () => {
    function Bare({ active }: { active: boolean }) {
      const panel = { current: null as HTMLElement | null };
      useOverlayLayer({ active, onClose: () => {}, panelRef: panel });
      return active ? <div ref={(el) => { panel.current = el; }} role="dialog" aria-label="Bare" tabIndex={-1} /> : null;
    }
    const view = render(<Bare active={false} />);
    expect(overlayDepth()).toBe(0);
    view.rerender(<Bare active />);
    expect(overlayDepth()).toBe(1);
    view.rerender(<Bare active={false} />);
    expect(overlayDepth()).toBe(0);
  });
});
