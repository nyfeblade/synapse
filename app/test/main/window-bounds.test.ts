import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clampRectToWorkArea, maximizeRect, SIMPLE_FULL_SCREEN } from "../../src/main/window-bounds";

/**
 * Bug: maximized window covers Dock and menu-bar hotspots.
 * Maximize/zoom must fill workArea, never display.bounds, and we never turn on simpleFullScreen.
 */

const WORK = { x: 0, y: 25, width: 1440, height: 847 };
const FRAME = { x: 0, y: 0, width: 1512, height: 982 };

describe("window maximize stays inside workArea", () => {
  it("maximize/zoom fills the work area and never the full framebuffer", () => {
    expect(maximizeRect(WORK)).toEqual(WORK);
    expect(clampRectToWorkArea(FRAME, WORK)).toEqual(WORK);
    const out = clampRectToWorkArea({ x: -20, y: -10, width: 2000, height: 1200 }, WORK);
    expect(out.x).toBe(WORK.x);
    expect(out.y).toBe(WORK.y);
    expect(out.x + out.width).toBeLessThanOrEqual(WORK.x + WORK.width);
    expect(out.y + out.height).toBeLessThanOrEqual(WORK.y + WORK.height);
  });

  it("never turns on simpleFullScreen", () => {
    expect(SIMPLE_FULL_SCREEN).toBe(false);
    const src = readFileSync(fileURLToPath(new URL("../../src/main/index.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/setSimpleFullScreen\s*\(\s*true\s*\)/);
    expect(src).not.toMatch(/simpleFullScreen\s*:\s*true/);
  });
});
