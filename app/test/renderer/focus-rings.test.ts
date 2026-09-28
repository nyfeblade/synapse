import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The audit's defect 10. Four text inputs set `outline: none` in their base rule.
// Two of them have a defensible fallback and two are simply wrong:
//
//   .composer-input   `.composer:focus-within` changes the wrapper's border — the
//                     ring is drawn on the pill around the field. Kept deliberately.
//   .palette-input    the only focusable control in the palette, inside a dialog
//                     that is itself the focused surface. Kept deliberately.
//   .to-input         nothing. New Chat's "To:" field showed NO focus indicator at
//                     all, and it is the first thing ⌘N focuses.
//   .mkt-search input nothing. The Marketplace's search box, likewise.
//
// Contract-level, not jsdom-level: jsdom's getComputedStyle does not match
// :focus-visible, so the only honest place to assert this is the stylesheet.
// ---------------------------------------------------------------------------

const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const paletteCss = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/palette.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the last rule whose selector list contains `sel`. */
function ruleFor(src: string, sel: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let found: string | null = null;
  while ((m = re.exec(src))) {
    if (m[1]!.split(",").some((s) => s.trim() === sel)) found = m[2]!;
  }
  return found;
}

/** Is there any rule that gives `sel:focus-visible` a visible outline? */
function hasRing(src: string, sel: string): boolean {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let ring = false;
  while ((m = re.exec(src))) {
    const hits = m[1]!.split(",").some((s) => s.trim() === `${sel}:focus-visible`);
    if (!hits) continue;
    // The Apple pass made the ring a 3px halo at 40% (--focus-ring-soft) instead of a 2px solid
    // edge; what this function asks is unchanged — that the field restores a VISIBLE ring drawn
    // from the focus token — so it reads the token rather than the width it happened to have.
    ring = /outline:\s*3px solid var\(--focus-ring-soft\)/.test(m[2]!);
  }
  return ring;
}

describe("focus rings on the fields whose base rule kills the outline (defect 10)", () => {
  // UI polish pass (critique 3.4): the To: field follows the composer's exception — the ROW around
  // it carries the focus as a soft fill, rather than a 3px ring boxing the whole header.
  it("New Chat's To: field shows focus — on its row, as a soft fill", () => {
    expect(ruleFor(css, ".to-input")).toMatch(/outline:\s*none/);
    expect(hasRing(css, ".to-input")).toBe(false);
    expect(ruleFor(css, ".to-row:focus-within"), "the To: row is what changes").toMatch(/background:\s*var\(--fill-/);
  });

  it("the Marketplace search box paints a ring", () => {
    expect(ruleFor(css, ".mkt-search input")).toMatch(/outline:\s*none/);
    expect(hasRing(css, ".mkt-search input"), ".mkt-search input must restore the ring at :focus-visible").toBe(true);
  });

  // The two deliberate exceptions, pinned so they stay deliberate rather than drifting back
  // into the same bug. Each is here because the surface around the field carries the indicator.
  it("keeps the composer's ring on the pill around the field, not on the field", () => {
    expect(hasRing(css, ".composer-input")).toBe(false);
    expect(ruleFor(css, ".composer:focus-within"), "the composer pill is what changes").toMatch(/border-color/);
  });

  it("keeps the palette input ringless, because the dialog around it is the focused surface", () => {
    expect(hasRing(paletteCss, ".palette-input input")).toBe(false);
    expect(ruleFor(paletteCss, ".palette-input input:focus-visible")).toMatch(/outline:\s*none/);
  });
});
