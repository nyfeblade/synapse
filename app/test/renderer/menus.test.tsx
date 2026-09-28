// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu } from "../../src/renderer/components/Menus";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Task 39 fuzz: the composer's + menu opened at the button (bottom of the window) and grew downward,
// so "Use a skill ▸" and "Teach a task" were outside the viewport and could not be clicked.
describe("Menu stays inside the viewport", () => {
  it("shifts up and left when it would overflow the bottom or right edge", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 680 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: 200, height: 160, top: 0, left: 0, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    render(<Menu label="Attach file" x={900} y={640} onClose={() => {}} items={[{ label: "A", onSelect: () => {} }, { label: "B", onSelect: () => {} }]} />);
    const m = screen.getByRole("menu", { name: "Attach file" });
    expect(parseFloat(m.style.top)).toBe(680 - 160 - 8);
    expect(parseFloat(m.style.left)).toBe(1024 - 200 - 8);
  });

  it("keeps the requested spot when it fits", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 680 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 200, height: 160, top: 0, left: 0, right: 200, bottom: 160, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    render(<Menu label="More" x={100} y={120} onClose={() => {}} items={[{ label: "A", onSelect: () => {} }]} />);
    const m = screen.getByRole("menu", { name: "More" });
    expect(parseFloat(m.style.top)).toBe(120);
    expect(parseFloat(m.style.left)).toBe(100);
  });
});
