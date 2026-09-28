// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialState } from "../../src/renderer/reducer";

// Smooth pass, Task 5: the right panel starts closed, and what it draws inside (Now: Computer, Plan,
// Scheduled) is sections by space, not a column of cards.
// The two-piece string (not one literal) keeps Vite's import-analysis from treating this as a static
// asset URL under the jsdom environment, where that rewrite produces a non-file: URL and fileURLToPath
// throws (see smooth-sidebar.test.tsx, the existing working precedent for this exact pattern).
const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8");
const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); return i < 0 ? "" : css.slice(i, css.indexOf("}", i)); };

describe("smooth right panel", () => {
  it("starts closed", () => { expect(initialState().panel).toBe("closed"); });
  it("draws sections by space, not cards", () => {
    expect(rule(".pcard")).not.toMatch(/border:/);
    expect(rule(".pcard")).toMatch(/background:\s*transparent/);
  });
  it("labels sections in sentence case", () => {
    expect(rule(".pcard-head")).not.toMatch(/uppercase/);
  });
});
