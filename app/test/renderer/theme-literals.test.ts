import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bug 24, THE CLASS — "a colour written for the light theme and never given a dark value".
//
// theme-surfaces.test.ts locked the five elevation tokens that were the reported symptom
// (--shadow-modal / --shadow-pop existing only in `:root`, --scrim too shallow for a #0B0B0B page,
// `.cv-stage`'s hard-coded #EDEDED). That file guards those seven names. This one guards the
// MECHANISM that let them go wrong, so the next light-only colour cannot repeat it:
//
//   1. No renderer stylesheet writes a literal colour at all. Every literal is a value that exists in exactly one
//      theme, because a literal has nowhere to put the other one. Seventeen survived the elevation
//      pass — a near-white #FDF0E6 warning panel, a #070707 splash, #ABABAB / #7A7A7A / #8A8A8A /
//      #6B6B6B inks that were already the light value of a token, a #CFCFCF dashed ring, a #3c82f6
//      usage bar, a #ce383d dictation button that was --danger spelled out — and every one of them
//      painted its light value on a black page. tokens.css is where a literal belongs; it is the one
//      file with three theme blocks to put it in.
//   2. tokens.css's two dark blocks are byte-identical in what they define. They are a copy-paste
//      pair — `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` for "follow
//      the system" and `:root[data-theme="dark"]` for "the user chose dark" — and a token added to
//      one and not the other means the two ways of being in dark mode disagree. Nothing but a test
//      keeps a hand-maintained duplicate honest.
//   3. Every token in `:root` is either given a dark value in BOTH dark blocks, or is named in
//      THEME_INDEPENDENT below with a reason. That list is the whole point: adding a light-only
//      colour token is not forbidden, it is made deliberate. Defect 1 happened because
//      --shadow-modal could be added to one block and nothing said anything.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
/** Blanks comments out in place, so reported line numbers are the file's own. */
const blankComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/** Any literal colour: #rgb / #rrggbb / #rrggbbaa, rgb(), rgba(), hsl(), hsla(). */
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/g;

/** name -> value for one theme block. */
function tokensIn(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

function blocks() {
  const src = stripComments(read("tokens.css"));
  const light = src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1];
  const media = src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  const attr = src.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m)?.[1];
  expect(light, "no `:root` block in tokens.css").toBeTruthy();
  expect(media, "no `@media (prefers-color-scheme: dark)` block in tokens.css").toBeTruthy();
  expect(attr, 'no `:root[data-theme="dark"]` block in tokens.css').toBeTruthy();
  return { light: tokensIn(light!), media: tokensIn(media!), attr: tokensIn(attr!) };
}

/**
 * Tokens that are deliberately declared once, in `:root`, and reach dark mode unchanged. Each needs
 * a stated reason, and adding to this list is the deliberate act the guard exists to force.
 */
const THEME_INDEPENDENT: Record<string, string> = {
  "--font": "a type stack, not a colour",
  "--mono": "a type stack, not a colour",
  "--motion-tap": "a duration + curve (docs/motion-spec.md §1)",
  "--motion-enter": "a duration + curve",
  "--motion-sheet": "a duration + curve",
  "--motion-spring": "a duration + curve",
  "--stagger": "a delay",
  "--loop-slow": "a period",
  "--loop-mid": "a period",
  "--loop-fast": "a period",
  "--dot-stagger": "a delay (the typing dots' 0.15s stagger)",
  "--motion-glide": "a duration + spring curve (decisions.md, liquid motion)",
  "--motion-pop": "a duration + spring curve",
  "--glide-duration": "the glide spring's duration as a longhand (decisions.md, ultra liquid)",
  "--motion-msg-user": "a duration (the smooth pass, Task 9 — the user's message glide-in; pairs with --ease-out)",
  "--motion-msg-bot": "a duration (the smooth pass, Task 9 — the Bot's message glide-in; pairs with --ease-out)",
  "--glide-easing": "the glide spring's curve as a longhand",
  "--motion-dot": "a duration (the sidebar activity dot's fade-in, smooth pass Task 3, docs/sdd 2026-09-23)",
  "--motion-dot-out": "a duration (the same dot's fade-out, fix round 1 — going quiet transitions too, not just lighting up)",
  "--ease-out": "a curve, shared by the dot's fade-in and fade-out transitions, and by the account/context menu's entrance (smooth pass Task 8)",
  "--motion-panel": "a duration (the smooth pass, Task 8 — the right panel's content entrance; the panel's own box snaps and is never themed either way)",
  "--motion-menu": "a duration (the smooth pass, Task 8 — the account/context menu's entrance)",
  "--motion-hover-in": "a duration (the smooth pass, Task 8 — a hover wash lighting up)",
  "--motion-hover-out": "a duration (the smooth pass, Task 8 — a hover wash going quiet, slower so it reads as gliding)",
  "--ease-drawer": "a curve (the smooth pass, Task 8 — the right panel content's own deceleration)",
  // Saturated accents. These are not surfaces or inks: they are the app's few pieces of hue, and
  // each is a 6-24px mark that carries its meaning by hue rather than by sitting in the theme's
  // greyscale ladder. Each is measured against the DARK page below, so "unchanged" stays a claim
  // with a number behind it rather than an omission.
  "--control": "the computer-control amber, a fixed hue in both themes",
  "--cursor-tag": "the Bot's cursor tag on the Computer stage: it sits on the remote screen's own pixels, not on the app theme, so it is black in both",
  "--cursor-tag-ink": "the ink (and outline) of that tag, white in both themes",
  "--danger": "the destructive red, a fixed hue in both themes",
  "--dot-ok": "an approval / presence dot, a fixed hue in both themes",
  "--dot-muted": "an inactive dot, a fixed grey in both themes",
  "--dot-blocked": "the needs-attention marker, a fixed hue in both themes",
  "--ink-on-accent": "the ink painted ON a saturated accent fill, which does not change with the theme",
  "--ink-on-control": "the ink painted ON --control, which does not change with the theme either; the amber is light enough (L 0.325) to need a dark ink where --danger and --glyph-active take the white one",
  "--splash-bg": "the onboarding splash is a dark screen in BOTH themes, by design",
  "--splash-ink": "the ink on that splash",
  "--splash-ink-muted": "the secondary ink on that splash",
  // The Carbon look (decisions.md, "the Carbon Graphite look").
  "--accent": "an alias of --primary, which has its dark value; nothing ever overrides it — the app is neutral",
  "--accent-ink": "an alias of --primary-ink, which has its dark value; nothing ever overrides it",
  "--hairline": "a border width (one device pixel), not a colour; the 2dppx block narrows it",
  "--type-ui": "a font size",
  "--type-body": "a font size",
  "--type-small": "a font size",
  "--type-label": "a font size",
  "--radius-row": "a corner radius",
  "--radius-card": "a corner radius",
  // The Apple pass (decisions.md, "the Apple refinement"). None of these is a colour: they are the
  // ramp, the rhythm and the radius ladder, and a theme does not change any of them.
  "--type-title": "a font size (the chat title, 17px)",
  "--line-body": "a line height (the 15/21 message body)",
  "--track-tight": "letter-spacing, the negative tracking that goes on at 15px and above",
  "--track-label": "letter-spacing, the positive tracking of an 11px section label",
  "--radius-control": "a corner radius",
  "--radius-xs": "a corner radius",
  "--radius-surface": "a corner radius",
  "--chat-inset": "a length (the chat-pane grid)",
  "--bot-indent": "a length (the chat-pane grid)",
  "--bot-col": "a length (the chat-pane grid)",
  "--bar-h": "a bar height",
  "--motion-quick": "a duration (UI polish pass: ⌘K and the Settings section fade)",
  "--motion-chevron": "a duration (UI polish pass: a chevron's turn)",
  "--motion-dropdown": "a duration (UI polish pass: a dropdown opening)",
  "--radius-bubble": "a corner radius",
  "--radius-field": "a corner radius (the smooth pass's fourth rung, docs/sdd 2026-09-23)",
  "--control-h": "a control height (28px), not a colour",
  "--control-h-primary": "a control height (32px, a primary action), not a colour",
  "--focus-ring-soft": "the focus ring at 40%, derived by color-mix from --focus-ring, which HAS its dark value — so this follows the theme without a second declaration to keep in step",
  "--preview-paper": "the paper an imported document is rendered ON, inside an iframe whose content we do not control — a white-page document with transparent regions and its own near-black ink, which a dark backdrop would not theme but obscure (bug 29b)",
};

/** Every renderer stylesheet except the token file itself.
 *  WIDENED from app.css alone (bug 29b): `.preview-frame { background: #fff }` in files.css was the
 *  last hard-coded colour in the renderer and this file could not see it, because it only ever looked
 *  at app.css. Scoping a mechanism guard to the one file where the mechanism was first reported is how
 *  the next instance hides. Every other stylesheet was already literal-free, so the widening cost
 *  nothing and would have caught the one that was not. */
const RENDERER_SHEETS = readdirSync(stylePath("").replace(/[^/]*$/, "")).filter((f) => f.endsWith(".css") && f !== "tokens.css").sort();

describe("bug 24, the class — no renderer stylesheet writes a literal colour", () => {
  it("every colour outside tokens.css comes from a token, so it has somewhere to put its dark value", () => {
    expect(RENDERER_SHEETS.length, "no renderer stylesheets found — the widened scan is looking at nothing").toBeGreaterThan(5);
    expect(RENDERER_SHEETS, "app.css must still be in scope; it is where this bug was reported").toContain("app.css");
    const offenders = RENDERER_SHEETS.flatMap((sheet) =>
      blankComments(read(sheet))
        .split("\n")
        .flatMap((line, i) => [...line.matchAll(LITERAL)].map((m) => `${sheet}:${i + 1}  ${m[0]}  in  ${line.trim().slice(0, 110)}`)));
    expect(offenders, `a literal colour has only one theme's value:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("tokens.css is the one file allowed to hold literals, and it holds them in three blocks", () => {
    const b = blocks();
    expect(b.light.size, "the light block defines no tokens").toBeGreaterThan(40);
    expect(b.media.size, "the dark block defines no tokens").toBeGreaterThan(40);
  });
});

describe("bug 24, the class — the two dark blocks cannot drift apart", () => {
  it('`@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]` define the same token names', () => {
    const { media, attr } = blocks();
    expect([...media.keys()].sort(), "a token added to one dark block and not the other").toEqual([...attr.keys()].sort());
  });

  it("the two dark blocks give every token the same value", () => {
    const { media, attr } = blocks();
    const differ = [...media].filter(([k, v]) => attr.get(k) !== v).map(([k, v]) => `${k}: ${v} vs ${attr.get(k)}`);
    expect(differ, `"follow the system" and "I chose dark" must be the same dark:\n${differ.join("\n")}`).toEqual([]);
  });
});

describe("bug 24, the class — no token is light-only by accident", () => {
  it("every `:root` token is either given a dark value in both dark blocks or declared theme-independent", () => {
    const { light, media, attr } = blocks();
    const lightOnly = [...light.keys()].filter((k) => !media.has(k) || !attr.has(k));
    const undeclared = lightOnly.filter((k) => !(k in THEME_INDEPENDENT));
    expect(undeclared, `light-only and unexplained — this is exactly how --shadow-modal happened:\n${undeclared.join("\n")}`).toEqual([]);
  });

  it("nothing is listed as theme-independent that the dark blocks actually override", () => {
    const { media } = blocks();
    const stale = Object.keys(THEME_INDEPENDENT).filter((k) => media.has(k));
    expect(stale, `these have a dark value, so the exemption is stale: ${stale.join(", ")}`).toEqual([]);
  });
});

// WCAG relative luminance / contrast of a #RRGGBB literal.
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch[0]!) + 0.7152 * f(ch[1]!) + 0.0722 * f(ch[2]!);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

describe("bug 24, the class — a theme-independent accent still has to work on the dark page", () => {
  // The whole failure mode is "this colour was only ever looked at in light". An accent exempted
  // from having a dark value is claiming it needs none; that claim is checked, not taken.
  // 3:1 is WCAG 1.4.11's non-text threshold — these are dots, bars and fills, not body copy.
  // UI polish pass: --dot-unread and --meter-fill left this list — they are themed ink now, not hues
  // — and --glyph-active is gone (the Bot's cursor tag is black-on-white-outline, --cursor-tag).
  const MARKS = ["--dot-ok", "--dot-muted", "--dot-blocked", "--control", "--danger"];
  for (const name of MARKS) {
    it(`${name} is still visible against the dark page`, () => {
      const { light, media } = blocks();
      const value = light.get(name);
      expect(value, `${name} is not defined in :root`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const bg = media.get("--bg-sidebar")!;
      const ratio = contrast(value!, bg);
      expect(ratio, `${name} ${value} on the dark sidebar ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });
  }

  it("the splash's own ink pair works, because the splash is dark in both themes", () => {
    const { light } = blocks();
    const bg = light.get("--splash-bg")!;
    expect(contrast(light.get("--splash-ink")!, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light.get("--splash-ink-muted")!, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("the warning tint is legible in BOTH themes — a near-white panel on a black page is defect 24", () => {
    const { light, media } = blocks();
    for (const [name, b] of [["light", light], ["dark", media]] as const) {
      const soft = b.get("--warn-soft")!;
      const ink = b.get("--warn-ink")!;
      expect(soft, `--warn-soft missing from the ${name} block`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const ratio = contrast(ink, soft);
      expect(ratio, `${name}: --warn-ink ${ink} on --warn-soft ${soft} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    expect(luminance(media.get("--warn-soft")!), "a light warning panel on a #0B0B0B page is the whole bug").toBeLessThan(0.1);
  });
});
