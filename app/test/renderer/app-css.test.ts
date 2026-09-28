import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssPath = fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url));
const css = () => readFileSync(cssPath, "utf8");
const tokensPath = fileURLToPath(new URL("../../src/renderer/styles/tokens.css", import.meta.url));
const tokens = () => readFileSync(tokensPath, "utf8");

// Very small top-level rule splitter: good enough for app.css, which has no nested @media/@supports
// blocks wrapping ".card" (only @keyframes, which this filters out).
function topLevelSelectors(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const noKeyframes = noComments.replace(/@keyframes\s+[\w-]+\s*\{[^{}]*\{[^{}]*\}[^{}]*\}/g, "");
  const selectors: string[] = [];
  const ruleRe = /([^{}]+)\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(noKeyframes))) {
    for (const sel of m[1]!.split(",")) selectors.push(sel.trim());
  }
  return selectors;
}

describe("app.css — ApprovalCard vs shared .card primitive (fix round 1, finding 2)", () => {
  it("declares the bare .card selector exactly once (ApprovalCard's rule is the only owner of it)", () => {
    const bareCardCount = topLevelSelectors(css()).filter((s) => s === ".card").length;
    expect(bareCardCount).toBe(1);
  });

  // The Carbon look's card: 12px x 14px padding on the 12px card radius (--radius-card).
  it("keeps ApprovalCard's pending-card padding/border-radius intact (12px 14px / --radius-card)", () => {
    const m = css().match(/\.card\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/padding:\s*12px 14px/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
  });

  it("gives the Decision 8 shared card primitive its own, non-colliding selector", () => {
    const m = css().match(/\.card-primitive\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/max-width:\s*640px/);
    expect(body).toMatch(/padding:\s*12px 14px/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-card\)/);
  });
});

describe("app.css — presence dots (grey working marker, on-avatar ring)", () => {
  // Smooth-pass spec §6: a dot is grey while a Bot works and green only on a call. The working marker
  // used --dot-ok (green), which read as "on a call"; it is --dot-busy, the sidebar's own busy grey,
  // and keeps its pulse.
  it("colors .marker.working with the --dot-busy token (grey), never green --dot-ok, and keeps its pulse", () => {
    const m = css().match(/\.marker\.working\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/background:\s*var\(--dot-busy\)/);
    expect(body).not.toMatch(/--dot-ok/);
    expect(body).not.toMatch(/--ink-faint/);
    expect(body).toMatch(/animation:\s*pulse\b/);
  });

  it("keeps .marker.unread blue and .marker.blocked orange (unchanged)", () => {
    // The same two colours and the same strength of claim: they moved out of app.css into tokens.css
    // under bug 24's "app.css writes no literal colour" rule, so the hex is pinned where it now lives.
    expect(css()).toMatch(/\.marker\.blocked\s*\{[^}]*background:\s*var\(--dot-blocked\)/);
    expect(css()).toMatch(/\.marker\.unread\s*\{[^}]*background:\s*var\(--dot-unread\)/);
    expect(tokens()).toMatch(/--dot-blocked:\s*#ed712e/i);
    // UI polish pass (2026-09-24): unread is ink, not blue — the app is neutral.
    expect(tokens()).toMatch(/--dot-unread:\s*#111111/i);
  });

  it("defines a ring token for the on-avatar marker in all three theme blocks of tokens.css", () => {
    const t = tokens();
    const rootBlock = t.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const darkMediaBlock = t.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/)?.[1] ?? "";
    const darkAttrBlock = t.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rootBlock).toMatch(/--marker-ring:/);
    expect(darkMediaBlock).toMatch(/--marker-ring:/);
    expect(darkAttrBlock).toMatch(/--marker-ring:/);
  });
});

describe("app.css — FullRequestSheet vs Task 20 template sheets (fix round 1, finding 2)", () => {
  it("declares the bare .sheet selector exactly once (FullRequestSheet's rule is the only owner of it)", () => {
    const bareSheetCount = topLevelSelectors(css()).filter((s) => s === ".sheet").length;
    expect(bareSheetCount).toBe(1);
  });

  it("keeps FullRequestSheet's original sizing intact (560px / 16px padding / the window corner / --shadow-modal)", () => {
    const m = css().match(/\.sheet\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/width:\s*560px/);
    expect(body).toMatch(/padding:\s*16px/);
    // 12px -> --radius-window (10px). The Apple pass gave the app ONE window corner and put it in a
    // token, so a sheet, a modal and the window itself cannot drift to three different radii; the
    // claim this line makes — the sheet declares a definite corner, from the app's own ladder — is
    // unchanged and now cannot be satisfied by a stray literal.
    expect(body).toMatch(/border-radius:\s*var\(--radius-surface\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-modal\)/);
  });

  it("gives the Task 20 template sheets their own, non-colliding selector", () => {
    const m = css().match(/\.tpl-sheet\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/width:\s*520px/);
    expect(body).toMatch(/padding:\s*22px 24px/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-surface\)/);
    expect(body).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
  });
});
