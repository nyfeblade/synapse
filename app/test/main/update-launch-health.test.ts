import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchHealth } from "../../src/main/native/updater";

/**
 * Code audit 2026-09-29 §7.2: a new build is healthy once its window is up and the renderer has loaded. It used
 * to wait for the box's host to answer, so a slow box got a good update rolled back after a minute.
 */
describe("launch health after an update", () => {
  it("marks healthy once the window is shown and the renderer loaded, in either order, without the box", () => {
    for (const order of [["shown", "loaded"], ["loaded", "shown"]] as const) {
      const mark = vi.fn(() => ({ rolledBack: false }));
      const h = launchHealth(mark);
      h[order[0] === "shown" ? "windowShown" : "rendererLoaded"]();
      expect(mark).not.toHaveBeenCalled();
      h[order[1] === "shown" ? "windowShown" : "rendererLoaded"]();
      expect(mark).toHaveBeenCalledTimes(1);
    }
  });

  it("marks only once, even when the renderer reloads", () => {
    const mark = vi.fn(() => ({ rolledBack: false }));
    const h = launchHealth(mark);
    h.windowShown(); h.rendererLoaded(); h.rendererLoaded(); h.windowShown();
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it("reports a rollback the swap script left, to a listener added before or after", () => {
    const h = launchHealth(() => ({ rolledBack: true, version: "0.3.0" }));
    const early = vi.fn();
    h.onRolledBack(early);
    h.windowShown(); h.rendererLoaded();
    expect(early).toHaveBeenCalledWith("0.3.0");
    const late = vi.fn();
    h.onRolledBack(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there was no rollback", () => {
    const h = launchHealth(() => ({ rolledBack: false }));
    const cb = vi.fn();
    h.onRolledBack(cb);
    h.windowShown(); h.rendererLoaded();
    h.onRolledBack(cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("main wires the marker to the window and renderer, not to the host's /health", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/main/index.ts"), "utf8");
    const after = src.slice(src.indexOf("const afterConnected"), src.indexOf("const afterConnected") + 1500);
    expect(after).not.toMatch(/markHealthy\(/);
    expect(src).toMatch(/win\.once\("ready-to-show"[^\n]*windowShown\(\)/);
    expect(src).toMatch(/did-finish-load"[^\n]*rendererLoaded\(\)/);
  });

  it("docs/release.md says what health doesn't cover", () => {
    const doc = fs.readFileSync(path.join(__dirname, "../../../docs/release.md"), "utf8");
    expect(doc).toMatch(/a crash after the renderer has loaded isn't rolled back/);
  });
});
