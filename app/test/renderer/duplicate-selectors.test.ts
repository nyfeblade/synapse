import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Duplicate-selector guard.
//
// THE BUG CLASS: two phases each add a control, each writes its own unscoped `.switch { ... }` rule,
// 210 lines apart in the same stylesheet, and neither author ever sees the other. Nothing errors.
// The later rule silently wins on the properties they share and the earlier one keeps every property
// the later one happens not to name — so the control renders as a chimera of both. `.card` and
// `.sheet` were caught one at a time before (app-css.test.ts); this catches the whole class.
//
// THE RULE, stated precisely so it can be trusted and so nobody has to delete it to get work done:
//
//   A top-level rule whose prelude is a SINGLE selector (no comma) is that selector's DEFINITION.
//   Two or more definitions of the same selector in one stylesheet that declare at least one CSS
//   property in common are an accidental redefinition, and fail.
//
// What that deliberately does NOT flag, because all four are legitimate and common here:
//
//   1. State and variant selectors. `.x:hover`, `.x:not(:disabled):active`, `.x.on`, `.x [role=tab]`
//      are different selector strings and are never compared against `.x`. A modifier is how you are
//      supposed to write a variant; only a second rule for the IDENTICAL selector is a collision.
//   2. Grouped rules. `.btn-primary, .btn-outline { ... }` followed by `.btn-outline { ... }` is the
//      shared-base-plus-specific-override pattern the stylesheet is built on (see the big transition
//      and hover groups at the foot of app.css). A comma'd prelude is never treated as a definition.
//   3. Additive repeats that share no property. `.palette-row { layout }` early and
//      `.palette-row { transition: ... }` in the interaction-states section later overwrite nothing —
//      they are two halves of one description, and the stylesheet keeps its interaction rules in one
//      place on purpose. No shared property means no silent fight, so no failure.
//   4. Rules inside @media / @supports / @keyframes. Redefining a selector under a media query is
//      what a media query is for.
//
// Known limit, accepted on purpose: this compares property NAMES, so a shorthand fighting a longhand
// (`padding` vs `padding-left`) slips through. Widening it to expand shorthands would cost far more
// than it catches, and the collisions that actually happened here were all name-for-name.

const STYLE_DIR = fileURLToPath(new URL("../../src/renderer/styles/", import.meta.url));
const STYLESHEETS = readdirSync(STYLE_DIR).filter((f) => f.endsWith(".css")).sort();
const read = (file: string) => readFileSync(STYLE_DIR + file, "utf8");

/** Blank comments out in place so reported line numbers stay true to the file on disk. */
const blankComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

type Rule = { prelude: string; body: string; line: number };

/** Every rule at the top level of a stylesheet — nothing nested inside an at-rule. */
function topLevelRules(src: string): Rule[] {
  const clean = blankComments(src);
  const out: Rule[] = [];
  const stack: { prelude: string; at: number }[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      stack.push({ prelude: buf.trim(), at: i - buf.trimStart().length });
      buf = "";
      depth++;
    } else if (ch === "}") {
      const open = stack.pop();
      depth--;
      if (depth === 0 && open && !open.prelude.startsWith("@")) {
        out.push({ prelude: open.prelude, body: buf, line: clean.slice(0, open.at).split("\n").length });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return out;
}

const normalize = (sel: string) => sel.replace(/\s+/g, " ").trim();
const selectorsOf = (prelude: string) => prelude.split(",").map(normalize).filter(Boolean);
const propertiesOf = (body: string) => new Set([...body.matchAll(/(?:^|;)\s*([-a-zA-Z]+)\s*:/g)].map((m) => m[1]!));

/** Rules that are the sole selector of their prelude, keyed by that selector. */
function definitions(src: string): Map<string, Rule[]> {
  const bySelector = new Map<string, Rule[]>();
  for (const rule of topLevelRules(src)) {
    const sels = selectorsOf(rule.prelude);
    if (sels.length !== 1) continue; // grouped rule — exclusion 2
    const key = sels[0]!;
    if (!bySelector.has(key)) bySelector.set(key, []);
    bySelector.get(key)!.push(rule);
  }
  return bySelector;
}

/** Human-readable report of every accidental redefinition in one stylesheet. */
function redefinitions(file: string): string[] {
  const out: string[] = [];
  for (const [selector, rules] of definitions(read(file))) {
    if (rules.length < 2) continue;
    const props = rules.map((r) => propertiesOf(r.body));
    const shared = new Set<string>();
    for (let a = 0; a < props.length; a++) {
      for (let b = a + 1; b < props.length; b++) {
        for (const p of props[a]!) if (props[b]!.has(p)) shared.add(p);
      }
    }
    if (shared.size === 0) continue; // additive repeat — exclusion 3
    out.push(
      `${file}: \`${selector}\` is defined ${rules.length}x (lines ${rules.map((r) => r.line).join(", ")}) ` +
        `and the copies fight over [${[...shared].sort().join(", ")}]`,
    );
  }
  return out;
}

/**
 * The children of every `<button role="switch">` in a .tsx source. A knob-less switch either
 * self-closes or holds nothing, so every non-empty result is a second knob under the ::after one.
 * The tag end is found by scanning for a `>` at JSX-brace depth 0, because `onClick={() => ...}`
 * puts a `>` inside the attribute list that a `[^>]*` regex would stop at.
 */
function switchChildren(src: string): string[] {
  const out: string[] = [];
  for (const open of src.matchAll(/<button\b/g)) {
    let depth = 0;
    let end = -1;
    for (let i = open.index! + open[0].length; i < src.length; i++) {
      const c = src[i]!;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    if (!/role="switch"/.test(src.slice(open.index!, end + 1))) continue;
    if (src[end - 1] === "/") { out.push(""); continue; } // self-closing: no children at all
    const close = src.indexOf("</button>", end);
    out.push(close < 0 ? "" : src.slice(end + 1, close));
  }
  return out;
}

describe("no selector is accidentally redefined in the same stylesheet", () => {
  for (const file of STYLESHEETS) {
    it(`${file} defines every selector once`, () => {
      expect(redefinitions(file)).toEqual([]);
    });
  }
});

// The .switch invariant this guard was written for. A switch is a track plus a knob; the knob can be
// drawn by a pseudo-element or by a child <span>, and the two ways cannot coexist — the stylesheet
// carried both at once, so any switch whose markup contained a span painted TWO knobs, one placed by
// flexbox and one placed absolutely. The mechanism kept is ::after, because a pseudo-element knob is
// drawn by the same rule that draws the track and so can never drift out of sync with the markup:
// `className="switch"` alone is always a complete switch.
describe(".switch has exactly one knob mechanism", () => {
  const KNOB_SELECTORS = /^\.switch(\.on)?\s*(::?(after|before)|>?\s*span)/;

  it("app.css defines `.switch` and `.switch.on` exactly once each", () => {
    const defs = definitions(read("app.css"));
    expect(defs.get(".switch")?.length ?? 0, "`.switch` must have exactly one definition").toBe(1);
    expect(defs.get(".switch.on")?.length ?? 0, "`.switch.on` must have exactly one definition").toBe(1);
  });

  it("app.css draws the knob one way only — a ::after pseudo-element, never also a child span", () => {
    const knobRules = topLevelRules(read("app.css"))
      .flatMap((r) => selectorsOf(r.prelude))
      .filter((s) => KNOB_SELECTORS.test(s));
    expect(knobRules.length, "no knob rule found for .switch").toBeGreaterThan(0);
    const spanKnobs = knobRules.filter((s) => /span/.test(s));
    expect(spanKnobs, "a span knob and a pseudo-element knob cannot both exist — that paints two knobs").toEqual([]);
  });

  it("no switch in the renderer renders a knob child of its own", () => {
    const offenders: string[] = [];
    const srcDir = fileURLToPath(new URL("../../src/renderer/", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(dir + e.name + "/") : e.name.endsWith(".tsx") ? [dir + e.name] : [],
      );
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, "utf8");
      for (const inner of switchChildren(src)) {
        if (inner.trim()) offenders.push(`${file.slice(srcDir.length)}: <button role="switch"> contains \`${inner.trim()}\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("app.css takes every switch colour from a token — no literal in any .switch rule", () => {
    const rules = topLevelRules(read("app.css")).filter((r) => selectorsOf(r.prelude).some((s) => /^\.switch\b/.test(s)));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.body, `literal colour in \`${r.prelude}\``).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  // WHY THIS VALUE CHANGED. What this assertion is for is that the knob stays ANIMATABLE: the bug it
  // was written against was a span knob positioned with `justify-content`, which cannot be
  // transitioned at all, so the guard pinned the transform transition the ::after knob had at the
  // time — `120ms ease-out`. docs/motion-spec.md §7.1 deliberately moves the knob's transform onto
  // The spring, `cubic-bezier(0.3, 1.3, 0.6, 1)` at 300ms, because a switch is the one control
  // where an overshoot is physically truthful. The guarantee is unchanged and now stricter: the knob
  // must still transition transform, AND its colour must stay on the fast tier — a 320ms colour fade
  // on a 14px dot reads as lag rather than spring. Both halves are named tokens, so neither can drift
  // away from its curve the way a bare duration did three times elsewhere in this stylesheet.
  it("app.css throws the knob on the spring and fades its colour on the fast tier", () => {
    const knob = topLevelRules(read("app.css")).find((r) => normalize(r.prelude) === ".switch::after");
    expect(knob, "no `.switch::after` knob rule").toBeDefined();
    expect(knob!.body, "a knob that cannot transition transform cannot throw").toMatch(/transition:[^;]*\btransform var\(--motion-spring\)/);
    expect(knob!.body, "the knob's colour stays on the fast tier").toMatch(/transition:[^;]*\bbackground-color var\(--motion-tap\)/);
  });

  it("the switch's own tokens are defined in all three theme blocks of tokens.css", () => {
    const src = blankComments(read("tokens.css"));
    const blocks = {
      ":root": src.match(/^:root\s*\{([\s\S]*?)\n\}/m)?.[1],
      "@media dark": src.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s*\}/)?.[1],
      '[data-theme="dark"]': src.match(/^:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/m)?.[1],
    };
    for (const token of ["--switch-knob", "--switch-knob-on"]) {
      for (const [name, block] of Object.entries(blocks)) {
        expect(block, `${name} block not found in tokens.css`).toBeTruthy();
        expect(block!, `${token} missing from the ${name} block`).toMatch(new RegExp(token + ":\\s*[^;]+;"));
      }
    }
  });
});
