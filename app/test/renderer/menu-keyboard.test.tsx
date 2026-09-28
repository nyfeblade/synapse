// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../../src/renderer/components/Dialog";
import { Menu } from "../../src/renderer/components/Menus";
import { overlayDepth, resetOverlayStack } from "../../src/renderer/overlay-stack";
import { resetTriggerHistory } from "../../src/renderer/overlay-trigger";

// ---------------------------------------------------------------------------
// The audit's defect 9: `role="menu"` in Menus.tsx has no arrow-key support at all,
// despite its own doc comment claiming "arrow-key and Esc support (UI-05)". A role
// is a promise to the keyboard: a menu owns Up, Down, Home and End, and Escape both
// closes it and hands focus back to the control that opened it.
//
// A menu is also a layer. It is opened from inside dialogs (the skills manager's
// Import menu, a message's More menu) — so it has to sit on the overlay stack, or
// an Escape meant for the menu would be taken by the dialog underneath it.
// ---------------------------------------------------------------------------

afterEach(() => { cleanup(); act(() => resetOverlayStack()); resetTriggerHistory(); });

const items = (log: string[]) => [
  { label: "Pin", onSelect: () => log.push("Pin") },
  { label: "Duplicate", onSelect: () => log.push("Duplicate") },
  { label: "Delete", onSelect: () => log.push("Delete") },
];

function mount(onClose = vi.fn(), log: string[] = []) {
  render(<Menu label="Bot actions" x={10} y={10} onClose={onClose} items={items(log)} />);
  return { onClose, log, menu: screen.getByRole("menu", { name: "Bot actions" }) };
}
const active = () => (document.activeElement as HTMLElement).textContent;

describe("role=menu owns the arrow keys (defect 9)", () => {
  it("opens with the first item focused", () => {
    mount();
    expect(active()).toBe("Pin");
  });

  it("Down and Up walk the items", () => {
    const { menu } = mount();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("Duplicate");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(active()).toBe("Duplicate");
  });

  it("wraps at both ends, the way a menu does", () => {
    const { menu } = mount();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(active()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("Pin");
  });

  it("Home and End jump to the ends", () => {
    const { menu } = mount();
    fireEvent.keyDown(menu, { key: "End" });
    expect(active()).toBe("Delete");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(active()).toBe("Pin");
  });

  it("skips a disabled item rather than parking focus on it", () => {
    const log: string[] = [];
    render(<Menu label="Bot actions" x={10} y={10} onClose={() => {}} items={[
      { label: "Pin", onSelect: () => log.push("Pin") },
      { label: "Duplicate", disabled: true, onSelect: () => log.push("Duplicate") },
      { label: "Delete", onSelect: () => log.push("Delete") },
    ]} />);
    fireEvent.keyDown(screen.getByRole("menu", { name: "Bot actions" }), { key: "ArrowDown" });
    expect(active()).toBe("Delete");
  });

  it("Escape closes it and hands focus back to the trigger", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (<>
        <button type="button" onClick={() => setOpen(true)}>Account</button>
        {open && <Menu label="Account" x={10} y={10} onClose={() => setOpen(false)} items={items([])} />}
      </>);
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Account" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Account" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement, "Escape must hand the trigger back").toBe(trigger);
  });

  it("is a layer: an Escape meant for a menu inside a dialog does not close the dialog", () => {
    const closed: string[] = [];
    function Host() {
      const [menu, setMenu] = useState(true);
      return (
        <Dialog label="Manage skills" onClose={() => closed.push("dialog")} className="modal">
          <>
            <button type="button">Import skill</button>
            {menu && <Menu label="Import" x={10} y={10} onClose={() => { closed.push("menu"); setMenu(false); }} items={items([])} />}
          </>
        </Dialog>
      );
    }
    render(<Host />);
    expect(overlayDepth(), "the dialog and the menu are both layers").toBe(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["menu"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toEqual(["menu", "dialog"]);
  });

  it("Enter still runs the focused item", () => {
    const log: string[] = [];
    const onClose = vi.fn();
    const { menu } = mount(onClose, log);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.click(document.activeElement!);
    expect(log).toEqual(["Duplicate"]);
    expect(onClose).toHaveBeenCalled();
  });

  // Fix round 1 (docs/sdd, 2026-09-23; controller ruling): a real menu closes exactly as fast as it
  // always did (every assertion above is untouched) — the 120ms opacity-only exit plays on a
  // DETACHED CLONE instead, appended to <body> the instant the real menu unmounts. It carries none of
  // the real menu's role/name (a closed menu must never be announced or operable) and disables every
  // item, and it removes itself once the exit ends — `animationend` in the browser, a 160ms fallback
  // here because jsdom never fires one.
  // Stray clones between these tests are swept by test/setup-exit-clones.ts's global afterEach.
  describe("the exit clone (docs/motion-spec.md §5.4, fix round 1)", () => {
    it("appears the instant the real menu closes, stripped of its role and interactivity", () => {
      function Host() {
        const [open, setOpen] = useState(true);
        return open ? <Menu label="Bot actions" x={10} y={10} onClose={() => setOpen(false)} items={items([])} /> : null;
      }
      render(<Host />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("menu"), "the real menu is gone, not just faded").toBeNull();
      const ghost = document.querySelector(".menu.leaving");
      expect(ghost, "a fading clone was left behind").toBeTruthy();
      expect(ghost!.getAttribute("role")).toBeNull();
      expect(ghost!.getAttribute("aria-hidden")).toBe("true");
      expect(ghost!.querySelectorAll("button:not(:disabled)")).toHaveLength(0);
    });

    it("removes itself once its exit animation ends", () => {
      function Host() {
        const [open, setOpen] = useState(true);
        return open ? <Menu label="Bot actions" x={10} y={10} onClose={() => setOpen(false)} items={items([])} /> : null;
      }
      render(<Host />);
      fireEvent.keyDown(window, { key: "Escape" });
      const ghost = document.querySelector(".menu.leaving")!;
      fireEvent.animationEnd(ghost);
      expect(document.querySelector(".menu.leaving")).toBeNull();
    });

    it("falls back to a timeout when nothing ever fires animationend (jsdom, or a dropped frame)", () => {
      vi.useFakeTimers();
      function Host() {
        const [open, setOpen] = useState(true);
        return open ? <Menu label="Bot actions" x={10} y={10} onClose={() => setOpen(false)} items={items([])} /> : null;
      }
      render(<Host />);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.querySelector(".menu.leaving")).toBeTruthy();
      act(() => { vi.advanceTimersByTime(200); });
      expect(document.querySelector(".menu.leaving")).toBeNull();
      vi.useRealTimers();
    });

    // The bug this whole design exists to dodge: re-opening the SAME slot (a fresh `<Menu>` mount,
    // as every real caller does) while a previous close is still fading must show a fully live menu,
    // not one stuck mid-exit with its items disabled.
    it("re-opening the same slot while the old one fades shows a fully live, fresh menu", () => {
      function Host() {
        const [open, setOpen] = useState<{ n: number } | null>({ n: 1 });
        return (<>
          <button type="button" onClick={() => setOpen({ n: (open?.n ?? 0) + 1 })}>Open</button>
          {open && <Menu key={open.n} label="Bot actions" x={10} y={10} onClose={() => setOpen(null)} items={items([])} />}
        </>);
      }
      render(<Host />);
      fireEvent.keyDown(window, { key: "Escape" }); // closes the first mount, spawns a fading clone
      fireEvent.click(screen.getByRole("button", { name: "Open" })); // a fresh mount, same slot
      const menu = screen.getByRole("menu", { name: "Bot actions" });
      expect(menu.querySelectorAll("button:not(:disabled)").length, "the new menu's items are live").toBeGreaterThan(0);
      expect(document.querySelector(".menu.leaving"), "the old clone is still fading, harmlessly, elsewhere").toBeTruthy();
    });
  });

  // Fix round 1: a separator (the account menu, ahead of Settings) is a hairline, not a control —
  // arrow keys, Home/End and the initial autofocus must all treat it as if it were not there.
  it("a separator is not a stop for the arrow keys, Home/End or the opening autofocus", () => {
    render(<Menu label="Account" x={10} y={10} onClose={() => {}} items={[
      { label: "Marketplace", onSelect: () => {} },
      { separator: true },
      { label: "Settings", onSelect: () => {} },
    ]} />);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(menu.querySelector('[role="separator"]')).toBeTruthy();
    expect(active()).toBe("Marketplace");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("Settings");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("Marketplace");
    fireEvent.keyDown(menu, { key: "End" });
    expect(active()).toBe("Settings");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(active()).toBe("Marketplace");
  });
});
