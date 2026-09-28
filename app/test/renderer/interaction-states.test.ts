import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Interaction-state guard. CSS can't be unit-tested by rendering, so this reads the stylesheets and
// asserts the contract: every interactive surface has a :hover rule, keyboard focus is :focus-visible
// only (never bare :focus), disabled controls are excluded from hover, transitions never target a
// layout property, and the new interaction tokens exist in all three token blocks of tokens.css.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every rule prelude (selector list / at-rule head) in a stylesheet, comments removed. */
function preludes(src: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push(m[1]!.trim());
  return out;
}

/** A selector has a hover rule if some prelude carries `<sel>[:not(...)]*:hover`. */
function hasHover(src: string, sel: string): boolean {
  const re = new RegExp(escapeSel(sel) + "(:not\\([^)]*\\))*:hover");
  return preludes(src).some((p) => re.test(p));
}

/** Selectors that must gain a :hover rule, per stylesheet. */
const HOVER: Record<string, string[]> = {
  "app.css": [
    ".icon-btn", ".round-btn", ".round-btn.dark", ".btn-primary", ".btn-outline",
    ".btn-secondary", ".btn-danger", ".btn-compact", ".btn-compact.btn-compact-primary",
    ".link-btn", ".inline-link", ".card-link",
    ".danger-btn", ".title-btn", ".avatar-btn", ".chip-x", ".activity-rows", ".event-row.as-button",
    ".row", ".row.active", ".tile", ".tile.active", ".sidebar-foot", ".search", ".menu-item",
    ".pick", ".pick.selected", ".opt", ".nav-item", ".nav-item.current", ".tab", ".tab.active",
    ".tabs [role=\"tab\"]", ".dropdown", ".select", ".switch", ".pill", ".copy-field", ".routine-row",
    ".member-row", ".screen-thumb", ".cv-pill", ".cv-monitor", ".cv-monitor.current",
    ".shape-btn", ".swatch", ".onb-swatch", ".tool-cell", ".starter-card", ".pill-light",
    ".mkt-row-main", ".mkt-card", ".mkt-installed",
  ],
  "files.css": [".file-main"],
  "message-actions.css": [".reaction", ".reaction.mine", ".reply-header"],
  "palette.css": [".palette-row", ".palette-row.selected"],
  "skill-picker.css": [".skill-picker-row", ".skill-picker-row.selected"],
  "skills.css": [".modal.market .tab", ".modal.market .tab.selected", ".file-btn"],
  "widgets.css": [".link-card"],
};

/** Controls that can be disabled: their hover must be gated behind :not(:disabled). */
const DISABLED_GATED = [
  ".icon-btn", ".round-btn", ".btn-primary", ".btn-outline", ".btn-secondary",
  ".btn-danger", ".btn-compact", ".btn-compact.btn-compact-primary", ".link-btn", ".pill", ".cv-pill",
  ".switch",
];

/** Stylesheets that own interactive controls and therefore must define keyboard focus rings. */
const FOCUS_FILES = [
  "app.css", "files.css", "message-actions.css", "palette.css", "skill-picker.css", "skills.css", "widgets.css",
];

const ALL_FILES = [
  "app.css", "bot-admin.css", "files.css", "google.css", "message-actions.css", "palette.css",
  "skill-picker.css", "skills.css", "tokens.css", "widgets.css",
];

/** Tokens this pass introduces; each must exist in the light :root block and in BOTH dark blocks. */
const NEW_TOKENS = [
  "--fill-hover", "--fill-press", "--fill-selected-hover", "--fill-selected-press",
  "--primary-hover", "--primary-press", "--line-button-hover", "--focus-ring",
];

const LAYOUT_PROPS = /\b(width|height|padding|margin|top|left|right|bottom|inset|all)\b/;

describe("interaction states — hover", () => {
  for (const [file, selectors] of Object.entries(HOVER)) {
    for (const sel of selectors) {
      it(`${file} gives \`${sel}\` a :hover rule`, () => {
        expect(hasHover(read(file), sel)).toBe(true);
      });
    }
  }
});

describe("interaction states — pressed", () => {
  const PRESS = [".icon-btn", ".btn-primary", ".btn-outline", ".btn-secondary", ".row", ".tile", ".menu-item", ".nav-item", ".pill"];
  for (const sel of PRESS) {
    it(`app.css gives \`${sel}\` an :active rule`, () => {
      const re = new RegExp(escapeSel(sel) + "(:not\\([^)]*\\))*:active");
      expect(preludes(read("app.css")).some((p) => re.test(p))).toBe(true);
    });
  }
});

describe("interaction states — disabled controls get no hover", () => {
  for (const sel of DISABLED_GATED) {
    it(`app.css gates \`${sel}\` hover behind :not(:disabled)`, () => {
      const re = new RegExp(escapeSel(sel) + ":not\\(:disabled\\):hover");
      expect(preludes(read("app.css")).some((p) => re.test(p))).toBe(true);
    });
  }
});

describe("interaction states — keyboard focus", () => {
  for (const file of FOCUS_FILES) {
    // 3px AT 40%, not 2px solid. A 2px solid outline in the ink was indistinguishable from a
    // heavier border — on a control that already carries a hairline it read as a second edge drawn
    // ON the control rather than a ring around it, which is the one thing a focus indicator must
    // not do. macOS draws a halo: wider, and transparent enough that the control's own shape still
    // reads through it. --focus-ring-soft is --focus-ring at 40%, so the ring still follows the
    // theme from the same token and there is still exactly one place to change it.
    it(`${file} defines a :focus-visible ring as a 3px --focus-ring-soft halo at 2px offset`, () => {
      const src = stripComments(read(file));
      expect(src).toMatch(/:focus-visible/);
      expect(src).toMatch(/outline:\s*3px solid var\(--focus-ring-soft\)/);
      expect(src).toMatch(/outline-offset:\s*2px/);
      expect(src, "a 2px solid ring is the treatment this replaced").not.toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
    });
  }

  for (const file of ALL_FILES) {
    it(`${file} introduces no bare :focus rule`, () => {
      const bare = preludes(read(file)).filter((p) => /:focus(?![-\w])/.test(p));
      expect(bare).toEqual([]);
    });
  }
});

/** Every `@keyframes NAME { ... }` block in a stylesheet, as [name, body]. */
function keyframeBlocks(src: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push([m[1]!, m[2]!]);
  return out;
}

describe("interaction states — transitions", () => {
  for (const file of ALL_FILES) {
    it(`${file} never transitions a layout property`, () => {
      const decls = stripComments(read(file)).match(/transition(-property)?\s*:[^;}]*/g) ?? [];
      expect(decls.filter((d) => LAYOUT_PROPS.test(d))).toEqual([]);
    });
  }

  // THE GAP THIS CLOSES: the rule above reads `transition` declarations and nothing else, so
  // `@keyframes type { from { width: 0 } to { width: 100% } }` sat in app.css animating a layout
  // property on every frame of a 3s loop and passed this file cleanly. A keyframe is a transition
  // with extra steps; the ban has to cover both or it only covers the half somebody happened to
  // write first. Property NAMES only: a value like `transform-origin: left top` is not a layout
  // animation, and flagging it would be the kind of false positive that gets a guard deleted.
  for (const file of ALL_FILES) {
    it(`${file} never keyframes a layout property either`, () => {
      const offenders: string[] = [];
      for (const [name, body] of keyframeBlocks(read(file))) {
        for (const m of body.matchAll(/(?:^|[;{])\s*([-a-zA-Z]+)\s*:/g)) {
          if (LAYOUT_PROPS.test(m[1]!)) offenders.push(`@keyframes ${name} animates \`${m[1]}\``);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  // The synthetic cursor's glide used to ride `left`/`top`, which are layout properties. Its
  // position is set by an inline style in CursorOverlay.tsx, so the position moved to `transform`
  // there and `.bot-cursor` is pinned at left/top 0 — `left:0;top:0` + `translate(x,y)` places the
  // box exactly where `left:x;top:y` did. These two assertions keep the glide from regressing back
  // onto layout properties the next time someone touches it.
  it("app.css glides .bot-cursor on transform, never on left/top", () => {
    const rule = stripComments(read("app.css")).match(/\n\.bot-cursor\s*\{([^}]*)\}/);
    expect(rule, "no .bot-cursor rule in app.css").not.toBeNull();
    const body = rule![1]!;
    expect(body, ".bot-cursor must transition transform").toMatch(/transition:[^;]*\btransform\b/);
    expect(body, ".bot-cursor must not transition left/top").not.toMatch(/transition:[^;]*\b(left|top)\b/);
    expect(body, ".bot-cursor needs left:0/top:0 so translate() starts at the containing block origin").toMatch(/left:\s*0/);
    expect(body).toMatch(/top:\s*0/);
  });

  it("CursorOverlay positions the cursor with transform, not left/top", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/renderer/components/CursorOverlay.tsx", import.meta.url)), "utf8");
    const tag = src.match(/<span className=\{`bot-cursor[^>]*>/);
    expect(tag, "no .bot-cursor span in CursorOverlay.tsx").not.toBeNull();
    expect(tag![0]!, "the cursor must be placed with a transform").toMatch(/style=\{\{\s*transform:/);
    expect(tag![0]!, "left/top would put the glide back on layout properties").not.toMatch(/\b(left|top):/);
  });

  it("app.css cuts motion under prefers-reduced-motion", () => {
    const src = stripComments(read("app.css"));
    const m = src.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(m, "no prefers-reduced-motion block in app.css").not.toBeNull();
    const body = m![1]!;
    expect(body).toMatch(/\*\s*,/); // universal selector, so pulse/shimmer/breathe/typing/flash/type are covered
    // Brief 2 (UI polish pass): 0ms, not 0.01ms — nothing moves at all under Reduce Motion.
    expect(body).toMatch(/animation-duration:\s*0ms/);
    expect(body).toMatch(/transition-duration:\s*0ms/);
    expect(body).toMatch(/animation-iteration-count:\s*1/);
  });
});

describe("interaction tokens are defined in all three token blocks", () => {
  const src = stripComments(read("tokens.css"));
  const light = src.match(/^:root\s*\{([\s\S]*?)\n\}/m);
  const mediaDark = src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/);
  const attrDark = src.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m);

  it("tokens.css still has all three blocks", () => {
    expect(light).not.toBeNull();
    expect(mediaDark).not.toBeNull();
    expect(attrDark).not.toBeNull();
  });

  const valueOf = (block: string, token: string) => block.match(new RegExp(escapeSel(token) + ":\\s*([^;]+);"))?.[1]?.trim();

  for (const token of NEW_TOKENS) {
    it(`${token} is defined in :root, in the prefers-color-scheme dark block and in [data-theme="dark"]`, () => {
      const lightValue = valueOf(light![1]!, token);
      const mediaValue = valueOf(mediaDark![1]!, token);
      const attrValue = valueOf(attrDark![1]!, token);
      expect(lightValue, `${token} missing from :root`).toBeTruthy();
      expect(mediaValue, `${token} missing from @media dark block`).toBeTruthy();
      expect(attrValue, `${token} missing from [data-theme="dark"]`).toBeTruthy();
      expect(attrValue, "the two dark blocks must agree").toBe(mediaValue);
      // WHAT THIS ASSERTS, AND WHY IT IS NOT "light and dark must differ" any more.
      //
      // The original claim was that an interaction token RESOLVES differently in the two themes, and
      // it checked that by comparing the two declarations byte for byte. That is only the same claim
      // while every value is a hex literal. The Apple pass made --fill-hover / --fill-press a wash of
      // the page's own ink — `color-mix(in srgb, var(--ink) 4%, transparent)` — which is the SAME text
      // in all three blocks and a different colour in each, because --ink inverts. A byte comparison
      // reads that as "light and dark are the same" and fails a token that is more correct than the
      // pair of literals it replaced: one declaration that also composites over whatever surface the
      // control is resting on, instead of a solid grey that was right on the page and wrong on a card.
      //
      // So the contract is the one that was always meant: EVERY interaction token has to change with
      // the theme, by one of exactly two mechanisms — a declaration per theme, or a derivation from a
      // token that itself has a dark value. An identical literal in both blocks is still a failure.
      if (lightValue === mediaValue) {
        expect(lightValue, `${token} is declared identically in light and dark, so it must derive from a token that inverts`).toMatch(/var\(--(ink|primary|focus-ring|bg)[\w-]*\)/);
      }
    });
  }

  it("component stylesheets reference the interaction tokens by var(), never a literal colour", () => {
    for (const file of ALL_FILES.filter((f) => f !== "tokens.css")) {
      const src2 = stripComments(read(file));
      const hoverRules = src2.split(/\n/).filter((l) => /:hover|:active|:focus-visible/.test(l));
      for (const line of hoverRules) {
        expect(line, `${file}: literal colour in an interaction-state rule — ${line.trim()}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      }
    }
  });
});
