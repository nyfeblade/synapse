import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Theme-surface guard (visual audit, 678 screenshots, both themes).
//
// TWO DEFECTS, ONE ROOT CAUSE: a colour written for the light theme and never given a dark value.
//
// Defect 1 — dark mode had no modal surfaces. `--shadow-modal` and `--shadow-pop` were black-alpha
//   and were declared ONLY in the light `:root` block, so in dark they resolved to nothing at all;
//   and a black shadow over a #0B0B0B page cannot produce a halo even when it IS declared, because
//   there is no darker colour for it to darken towards. With `--scrim: rgba(10,10,10,.28)` over that
//   same near-black page, every dialog was held to the page by one 1px hairline and the chat bubble
//   and composer behind it read as the same plane (shots/mk-08-skill-editor-empty.dark.png).
//   THE DECISION: in dark, elevation is LIGHTNESS, not shadow. A modal paints `--surface-raised`,
//   which is --bg in light and a rung above the page in dark; it is edged with `--line-modal`, which
//   is --line-window in light and a visibly brighter line in dark; and the page behind it is taken
//   down by a `--scrim` deep enough to put the sidebar and the bubbles out of the plane. The two
//   shadows are still declared in all three blocks — a shadow that exists in one theme only is how
//   this happened — but in dark they are supporting cast, not the mechanism.
//
// Defect 2 — `.cv-stage { background: #EDEDED }` and `.cv-viewport`'s five-stop light-grey gradient
//   were hard-coded, so the letterbox around the Bot's screen painted near-white directly under a
//   #141414 titlebar inside an otherwise black app and read as a rendering fault
//   (shots/cm-05-computer-view.dark.png). The stage is now `--stage`, a token with a dark value, and
//   the empty viewport is the `--screen` colour the screen thumbnail already uses in both themes.
//
// CONTRACT-LEVEL, all of it: this file asserts the stylesheet's promises, not pixels. jsdom has no
// layout engine, so the rendered result is checked separately by re-capturing both themes in
// Chromium (scratchpad/visual-fix).

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body of the top-level rule whose prelude is exactly `sel`. (Some rules are minified onto one
 *  line, so a rule can begin right after the previous rule's `}` as well as after a newline.) */
function ruleBody(src: string, sel: string): string | null {
  const re = new RegExp("(?:^|\\n|\\})\\s*" + escapeSel(sel) + "\\s*\\{([^{}]*)\\}");
  return stripComments(src).match(re)?.[1] ?? null;
}

const blocks = () => {
  const src = stripComments(read("tokens.css"));
  return {
    ":root": src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1],
    "@media dark": src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)?.[1],
    '[data-theme="dark"]': src.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m)?.[1],
  };
};
const valueOf = (block: string, token: string) => block.match(new RegExp(escapeSel(token) + ":\\s*([^;]+);"))?.[1]?.trim();

/** WCAG relative luminance of a #RRGGBB literal. */
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch[0]!) + 0.7152 * f(ch[1]!) + 0.0722 * f(ch[2]!);
}

/** Every surface that floats above the page: a modal, a sheet, a popover or a floating banner. */
const OVERLAYS: [string, string][] = [
  ["app.css", ".menu"], ["app.css", ".picker"], ["app.css", ".listbox"], ["app.css", ".sheet"],
  ["app.css", ".tpl-sheet"], ["app.css", ".settings-dialog"], ["app.css", ".mkt-dialog"],
  ["app.css", ".avatar-editor"], ["app.css", ".box-banner"], ["app.css", ".cv-status"],
  ["app.css", ".voice-overlay"], ["app.css", ".modal"],
  ["palette.css", ".palette"], ["skill-picker.css", ".skill-picker"],
  ["message-actions.css", ".msg-actions"], ["message-actions.css", ".emoji-pop"],
];

/** Tokens this pass adds or gives a dark value to. */
const SURFACE_TOKENS = ["--surface-raised", "--line-modal", "--surface-nav", "--stage", "--scrim", "--shadow-pop", "--shadow-modal"];

describe("defect 1 — the surface tokens exist in every theme block", () => {
  for (const token of SURFACE_TOKENS) {
    it(`${token} is defined in :root, in the @media dark block and in [data-theme="dark"]`, () => {
      const b = blocks();
      for (const [name, block] of Object.entries(b)) {
        expect(block, `${name} block not found in tokens.css`).toBeTruthy();
        expect(valueOf(block!, token), `${token} missing from the ${name} block`).toBeTruthy();
      }
      expect(valueOf(b['[data-theme="dark"]']!, token), "the two dark blocks must agree").toBe(valueOf(b["@media dark"]!, token));
      expect(valueOf(b[":root"]!, token), `${token} has the same value in both themes, which is how defect 1 happened`)
        .not.toBe(valueOf(b["@media dark"]!, token));
    });
  }
});

describe("defect 1 — a dark modal is a different plane from the page", () => {
  it("--surface-raised is lighter than --bg in dark, so elevation does not depend on a shadow", () => {
    const dark = blocks()["@media dark"]!;
    const bg = valueOf(dark, "--bg")!;
    const surface = valueOf(dark, "--surface-raised")!;
    expect(surface).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(luminance(surface), `--surface-raised ${surface} must sit above --bg ${bg}`).toBeGreaterThan(luminance(bg));
  });

  it("--surface-raised stays below --fill-inset in dark, so a card on a modal still reads as a card", () => {
    const dark = blocks()["@media dark"]!;
    expect(luminance(valueOf(dark, "--surface-raised")!)).toBeLessThan(luminance(valueOf(dark, "--fill-inset")!));
  });

  // CAUGHT BY RE-CAPTURING, not by any assertion above: raising the dialog to #141414 in dark made
  // it exactly --bg-sidebar, which is what `.settings-nav` paints, so the settings dialog's nav pane
  // and its content pane became one flat field separated by a single 1px line. A settings nav is a
  // different material from the pane it drives, in both themes — and in dark that material is
  // RECESSED relative to the raised content, the way macOS System Settings draws it.
  it("the settings dialog's nav pane is a different material from its content, in both themes", () => {
    const body = ruleBody(read("app.css"), ".settings-nav")!;
    expect(body).toMatch(/background:\s*var\(--surface-nav\)/);
    for (const theme of ["@media dark", ":root"] as const) {
      const block = blocks()[theme]!;
      expect(valueOf(block, "--surface-nav"), `${theme}: the nav must not equal the surface it sits in`)
        .not.toBe(valueOf(block, "--surface-raised"));
    }
    const dark = blocks()["@media dark"]!;
    expect(luminance(valueOf(dark, "--surface-nav")!), "in dark the nav is recessed under the raised content")
      .toBeLessThan(luminance(valueOf(dark, "--surface-raised")!));
  });

  it("--line-modal is brighter than --line-window in dark, so the edge is actually drawn", () => {
    const dark = blocks()["@media dark"]!;
    expect(luminance(valueOf(dark, "--line-modal")!)).toBeGreaterThan(luminance(valueOf(dark, "--line-window")!));
  });

  it("the dark scrim is deep enough to put what is behind the modal out of the plane", () => {
    const alpha = (v: string) => Number(v.match(/rgba\([^)]*?,\s*([\d.]+)\s*\)/)?.[1] ?? "0");
    expect(alpha(valueOf(blocks()["@media dark"]!, "--scrim")!)).toBeGreaterThanOrEqual(0.55);
    expect(alpha(valueOf(blocks()[":root"]!, "--scrim")!)).toBeLessThan(0.55); // light is unchanged
  });

  for (const [file, sel] of OVERLAYS) {
    it(`${file} paints \`${sel}\` on --surface-raised with a --line-modal edge and a shadow token`, () => {
      const body = ruleBody(read(file), sel);
      expect(body, `no \`${sel}\` rule in ${file}`).not.toBeNull();
      expect(body!, `${sel} must paint the raised surface`).toMatch(/background(-color)?:\s*var\(--surface-raised\)/);
      expect(body!, `${sel} must be edged with --line-modal`).toMatch(/border:\s*(?:1px|var\(--hairline\)) solid var\(--line-modal\)/);
      expect(body!, `${sel} must take its shadow from a token`).toMatch(/box-shadow:\s*var\(--shadow-(pop|modal)\)/);
    });

    it(`${file} writes no literal colour into \`${sel}\``, () => {
      const body = ruleBody(read(file), sel)!;
      expect(body, `${sel} carries a literal colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });
  }
});

describe("defect 2 — the computer view has no light-only surfaces", () => {
  it(".cv-stage takes the letterbox colour from --stage, not a hard-coded #EDEDED", () => {
    const body = ruleBody(read("app.css"), ".cv-stage")!;
    expect(body).toMatch(/background:\s*var\(--stage\)/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it(".cv-viewport's empty-screen fill is a token, not a five-stop light-grey gradient", () => {
    const body = ruleBody(read("app.css"), ".cv-viewport")!;
    expect(body, "the gradient only ever worked in light").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).toMatch(/background:\s*var\(--screen\)/);
  });

  it("--stage is dark in dark mode — a near-white band under a #141414 titlebar reads as a fault", () => {
    const b = blocks();
    expect(luminance(valueOf(b["@media dark"]!, "--stage")!)).toBeLessThan(0.05);
    expect(luminance(valueOf(b[":root"]!, "--stage")!)).toBeGreaterThan(0.5);
  });
});
