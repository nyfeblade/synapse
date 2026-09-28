import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// "I can't drag the Synapse window." The window is frameless (titleBarStyle hiddenInset), so the ONLY
// places a person can grab it are rules that declare `-webkit-app-region: drag`. Before this, that was
// a 22px strip above the sidebar; the header across the main pane, where people reach for a Mac
// window, was not draggable. Every top bar is a drag region, and every control inside one is carved
// out as no-drag so it still takes clicks.

const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rules(selectorPart: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (m[1]!.includes(selectorPart)) out.push(`${m[1]!.trim()} { ${m[2]!.trim()} }`);
  return out;
}
const declares = (selectorPart: string, value: "drag" | "no-drag") =>
  rules(selectorPart).some((r) => new RegExp(`-webkit-app-region:\\s*${value}\\b`).test(r));

describe("the window can be dragged by its top bars", () => {
  for (const bar of [".sidebar-top", ".chat-header"]) {
    it(`${bar} is a drag region`, () => {
      expect(rules(bar).some((r) => r.startsWith(`${bar} {`) && /-webkit-app-region:\s*drag\b/.test(r))).toBe(true);
    });
    it(`controls inside ${bar} still take clicks (no-drag)`, () => {
      const carve = rules(bar).filter((r) => /-webkit-app-region:\s*no-drag\b/.test(r)).join("\n");
      for (const control of ["button", "input", "select", "a"]) expect(carve).toContain(control);
    });
  }
  it("the 2px top edge stays no-drag so a fullscreen window can still reveal the menu bar (UI-01)", () => {
    expect(declares(".sidebar-top::before", "no-drag")).toBe(true);
    expect(declares(".chat-header::before", "no-drag")).toBe(true);
  });
});
