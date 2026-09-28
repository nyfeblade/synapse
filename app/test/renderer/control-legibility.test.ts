import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Two legibility defects the visual audit found on ordinary controls.
//
// Defect 4 — the switch. An earlier fix made dark OFF clear and left light OFF at a #FFFFFF knob on
//   a #DADADA track: MEASURED FROM PIXELS at 1.40:1, separated only by a drop shadow, sitting on a
//   --fill-inset card directly beside an ON switch that is a bold black pill. Dark OFF measures
//   10.79:1. The asymmetry simply moved theme. THE FIX: the knob inverts against its track in BOTH
//   themes, which is what dark already did — light's OFF knob goes dark on the light track, light's
//   ON knob stays white on the black track. Nothing about dark changes.
//
// Defect 5 — three disabled treatments, one invisible and one that looked enabled.
//   `.btn-dark:disabled` repainted itself --fill-search over an --fill-inset card: #EDEDED on
//   #F5F5F5 with #ABABAB text, i.e. NO BUTTON FOOTPRINT AT ALL ("Add Rule", "Set avatar",
//   "Generate"), and it popped from nothing into a solid black slab the moment it enabled.
//   `.btn:disabled` only moved the ink, so `.btn.primary`'s solid background stayed FULL BLACK while
//   disabled — the transcript form card's Send looked enabled and was not. `.btn-primary:disabled`'s
//   `opacity: .5` was the one that was right: a legible ghost of the real control, same footprint,
//   obviously inert. That is now the only disabled treatment in app.css.
//
// CONTRACT-LEVEL: these assert the stylesheet's promises. The switch's four contrast figures are
// ALSO measured from rendered pixels in Chromium (scratchpad/visual-fix/measure.spec.ts), because a
// token value is not a pixel and this exact assertion class has been green over a visible defect
// before.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

const themeBlocks = () => {
  const src = stripComments(read("tokens.css"));
  return {
    light: src.match(/^:root\s*\{([\s\S]*?)\n\}/m)![1]!,
    dark: src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)![1]!,
  };
};
/** Resolves a token to a hex literal, following one level of `var(--other)` indirection. */
function token(block: string, name: string): string {
  const raw = block.match(new RegExp(escapeSel(name) + ":\\s*([^;]+);"))?.[1]?.trim();
  if (!raw) throw new Error(`${name} is not defined in this theme block`);
  const indirect = raw.match(/^var\((--[\w-]+)\)$/);
  return indirect ? token(block, indirect[1]!) : raw;
}

describe("defect 4 — the switch reads as off and as on, in both themes", () => {
  // Rest, hover and press, from app.css: off track --line-button -> --line-button-hover ->
  // --fill-selected-press; on track --primary -> --primary-hover -> --primary-press.
  const TRACKS = {
    off: ["--line-button", "--line-button-hover", "--fill-selected-press"],
    on: ["--primary", "--primary-hover", "--primary-press"],
  };
  const KNOB = { off: "--switch-knob", on: "--switch-knob-on" };

  for (const theme of ["light", "dark"] as const) {
    for (const state of ["off", "on"] as const) {
      for (const track of TRACKS[state]) {
        it(`${theme} ${state}: the knob is legible against ${track}`, () => {
          const block = themeBlocks()[theme];
          const ratio = contrast(token(block, KNOB[state]), token(block, track));
          expect(ratio, `${theme} ${state} on ${track} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }

  it("dark is not re-broken: its off knob and track are exactly what the previous fix left", () => {
    const dark = themeBlocks().dark;
    expect(token(dark, "--switch-knob")).toBe("#EDEDED");
    expect(token(dark, "--line-button")).toBe("#333333");
  });

  it("the knob inverts against its track in both themes, which is the rule that was broken", () => {
    for (const theme of ["light", "dark"] as const) {
      const b = themeBlocks()[theme];
      const offKnobDarkerThanTrack = luminance(token(b, "--switch-knob")) < luminance(token(b, "--line-button"));
      const onKnobDarkerThanTrack = luminance(token(b, "--switch-knob-on")) < luminance(token(b, "--primary"));
      expect(offKnobDarkerThanTrack, `${theme}: the off knob must contrast its own track`).toBe(theme === "light");
      expect(onKnobDarkerThanTrack, `${theme}: the on knob must contrast its own track`).toBe(theme === "dark");
    }
  });
});

describe("defect 5 — one disabled treatment, applied consistently", () => {
  /** Every top-level rule in app.css whose prelude mentions :disabled. */
  function disabledRules(): { prelude: string; body: string }[] {
    const out: { prelude: string; body: string }[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    const clean = stripComments(read("app.css")).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      const prelude = m[1]!.trim();
      if (!/:disabled/.test(prelude)) continue;
      if (/:hover|:active|:focus/.test(prelude)) continue; // those are :not(:disabled) gates, not disabled rules
      out.push({ prelude, body: m[2]! });
    }
    return out;
  }

  it("no disabled rule in app.css repaints a background or an ink — that is how a button vanished", () => {
    for (const { prelude, body } of disabledRules()) {
      const props = [...body.matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((m) => m[1]!);
      expect(props.filter((p) => !["opacity", "cursor"].includes(p)), `\`${prelude}\` uses a second disabled treatment`).toEqual([]);
    }
  });

  it("every disabled control in app.css fades to the same ghost", () => {
    const withOpacity = disabledRules().filter(({ body }) => /opacity:\s*0?\.5/.test(body));
    expect(withOpacity.length, "no :disabled rule sets the shared opacity").toBeGreaterThan(0);
    for (const { prelude, body } of disabledRules()) {
      if (/cursor/.test(body) && !/opacity/.test(body)) continue; // the bare `button:disabled { cursor }` reset
      expect(body, `\`${prelude}\` does not use the one treatment`).toMatch(/opacity:\s*0?\.5/);
    }
  });

  it("the three named offenders are gone", () => {
    const src = stripComments(read("app.css"));
    expect(src, ".btn-dark:disabled repainted itself invisible on an inset card").not.toMatch(/\.btn-dark:disabled\s*\{[^}]*background/);
    expect(src, ".btn:disabled only moved the ink, so .btn.primary stayed full black").not.toMatch(/(^|[,\s]).btn:disabled\s*\{[^}]*color:/m);
    expect(src, ".cv-pill:disabled was a fourth treatment").not.toMatch(/\.cv-pill:disabled\s*\{[^}]*color:/);
  });

  it("widgets.css's answered option keeps its own look rather than fading with the rest", () => {
    // `.btn-outline.chosen:disabled` is the option the user PICKED: a record of a decision, not an
    // unavailable action, so it is the one deliberate exception and it is stated as one.
    const body = stripComments(read("widgets.css")).match(/\.btn-outline\.chosen:disabled\s*\{([^}]*)\}/)?.[1];
    expect(body, "no .btn-outline.chosen:disabled rule").toBeTruthy();
    expect(body!).toMatch(/opacity:\s*1/);
  });
});
