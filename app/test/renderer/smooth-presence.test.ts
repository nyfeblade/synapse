import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8");

/** Body of the base (idle-inclusive) presence-dot rule: `.row[data-presence]:not([data-group])...::after`. */
function baseDotRuleBody(): string {
  const m = css.match(/\.row\[data-presence\]:not\(\[data-group\]\)[^{]*::after\s*\{([^}]*)\}/);
  expect(m, "the base presence-dot rule is missing").not.toBeNull();
  return m![1]!;
}

describe("presence dot (smooth pass)", () => {
  it("is drawn only for busy and call, never for idle", () => {
    expect(css).toMatch(/\.row\[data-presence="busy"\][^{]*::after/);
    expect(css).toMatch(/\.row\[data-presence="call"\][^{]*::after/);
    expect(css).not.toMatch(/\.row\[data-presence\]:not\(\[data-group\]\)[^{]*::after\s*\{[^}]*--dot-muted/);
  });
  it("fades rather than snapping — a transition, not an instant opacity change", () => {
    const body = baseDotRuleBody();
    expect(body).toMatch(/transition:[^;]*opacity var\(--motion-dot-out\) var\(--ease-out\)/);
    expect(body).toMatch(/transition:[^;]*transform var\(--motion-dot-out\) var\(--ease-out\)/);
  });
  it("rings the dot in the row's own fill", () => {
    expect(css).toMatch(/\.row\.active\s*\{[^}]*--marker-ring:\s*var\(--fill-selected\)/);
  });

  // Fix round 1 (docs/sdd, 2026-09-23): the first cut only handled the fade IN. Busy/call -> idle made
  // the ::after stop matching its selector and vanish instantly with the element, which is the one
  // direction the user explicitly asked to be soft too (spec §6, "fades in and out"). The dot now has
  // to exist for every eligible row — including idle — sitting invisible until a state change plays a
  // transition to show or hide it, and it must never sit on top of the row intercepting a click.
  it("the idle dot is present but invisible, transitions rather than vanishing, and never intercepts a click", () => {
    const body = baseDotRuleBody();
    expect(body, "the idle/base rule must still produce content, or there is nothing to transition").toMatch(/content:\s*""/);
    expect(body).toMatch(/opacity:\s*0\b/);
    expect(body).toMatch(/transform:\s*scale\(\.6\)/);
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).toMatch(/transition:[^;]*opacity/);
  });

  // The busy/call state re-selects the identical guarded compound selector (not a lower-specificity
  // shorthand) so it actually wins the cascade over the base rule's own opacity/transform, and it
  // lights up faster than it goes quiet.
  it("busy/call show the dot on a faster transition-duration than the idle default", () => {
    const m = css.match(/\.row\[data-presence="busy"\]:not\(\[data-group\]\)[^{]*::after,\s*\n\.row\[data-presence="call"\]:not\(\[data-group\]\)[^{]*::after\s*\{([^}]*)\}/);
    expect(m, "the busy/call show-state rule is missing or not guarded the same as the base rule").not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/opacity:\s*1\b/);
    expect(body).toMatch(/transform:\s*scale\(1\)/);
    expect(body).toMatch(/transition-duration:\s*var\(--motion-dot\)\s*;/);
  });

  it("reduced motion strips the scale but leaves the fade (opacity) alone", () => {
    const reduce = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reduce).toMatch(/\.row\[data-presence\]::after\s*\{\s*transform:\s*none\s*!important;/);
  });
});
