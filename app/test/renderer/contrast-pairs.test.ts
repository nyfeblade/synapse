import { describe, expect, it } from "vitest";

// Bug 41 — "a token proved against the page fails on the card it actually renders on".
//
// PR #36 validated --ink-faint at 4.59:1 and the a11y sweep measured the same ink at 3.84:1. Both
// numbers were right: 4.59:1 is #7A7A7A against the dark PAGE (--bg #0B0B0B), 3.84:1 is the same ink
// against the dark CARD it renders on (--fill-search #1F1F1F). A contrast figure is meaningless
// without the surface it was measured against, so this file measures PAIRS, not tokens.
//
// THE INSTRUMENT IS THE POINT, and it is deliberately narrow. A full ink x surface cross-product was
// tried first and returned 74 light-mode "failures" that were overwhelmingly pairings the app never
// renders (--ink-on-accent on --bg, --ink on --bubble-user, which carries its own ink). That is a
// claim about the pattern, not about the app. What this walks instead is CO-OCCURRENCE: a rule that
// sets BOTH a colour token and a background token is a rule whose author put those two colours on
// the same pixels, so the pair is one the app really paints.
//
// WHAT IT CANNOT SEE, stated rather than hidden, and who does see it:
//   - one colour from one rule, the other from ANOTHER rule on the same element (a hover that only
//     repaints the fill): the cross-rule walk further down this file;
//   - a rule that sets only `color` and takes its background from whatever ancestor is behind it in
//     the DOM, which no static walk of the stylesheet can know: contrast-surfaces.test.tsx renders
//     real surfaces and walks the real tree, and app/e2e/a11y.e2e.ts lets axe do it in Chromium.
//
// EVERY NUMBER BELOW WAS ALSO MEASURED FROM RENDERED PIXELS. Chromium 1.63, real tokens.css +
// app.css linked into a real document, one real element built per selector, getComputedStyle() read
// for color and background-color in both themes. The static walk here reproduced all ten of bug 41's
// failures to the hundredth, by a different route. A token value is not a pixel; this repo has had a
// green stylesheet assertion sitting over a visible defect before (defect 4, the switch knob).

import { bgOf, compounds, contrast, isHex, read, resolve, rules, SHEETS, specificity, splitTop, themeBlocks, threshold, TOKEN, type Rule } from "./contrast-kit";

export { contrast, resolve, rules, threshold };

/** The colour token and the background token a single rule paints together, or null.
 *  A `background` shorthand that carries anything but one token (a gradient, an image, `transparent`,
 *  `none`) is not a flat fill and is deliberately not paired. */
export function pairOf(rule: Rule): { ink: string; fill: string } | null {
  const ink = rule.decls.color?.match(TOKEN)?.[1];
  const fill = bgOf(rule.decls)?.match(TOKEN)?.[1];
  return ink && fill ? { ink, fill } : null;
}

type Measured = { key: string; sheet: string; selector: string; theme: "light" | "dark"; ink: string; fill: string; inkHex: string; fillHex: string; ratio: number; need: number; why: string };

function measureAll(sheets: { name: string; css: string }[] = SHEETS.map((name) => ({ name, css: read(name) }))): Measured[] {
  const blocks = themeBlocks();
  const out: Measured[] = [];
  for (const { name, css } of sheets) {
    for (const rule of rules(name, css)) {
      const pair = pairOf(rule);
      if (!pair) continue;
      const { need, why } = threshold(rule.decls);
      for (const theme of ["light", "dark"] as const) {
        const inkHex = resolve(blocks, theme, pair.ink);
        const fillHex = resolve(blocks, theme, pair.fill);
        if (!/^#[0-9A-Fa-f]{6}$/.test(inkHex) || !/^#[0-9A-Fa-f]{6}$/.test(fillHex)) continue; // rgba scrims etc.
        out.push({
          key: `${rule.selector} [${theme}]`, sheet: name, selector: rule.selector, theme,
          ink: pair.ink, fill: pair.fill, inkHex, fillHex,
          ratio: Math.round(contrast(inkHex, fillHex) * 100) / 100, need, why,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CROSS-RULE PAIRS ON ONE ELEMENT — the half of bug 41 co-occurrence cannot see.
//
// A state or variant rule very often sets ONE of the two colours and inherits the other from the
// base rule of the same element: `.search:not(:disabled):hover` repaints the fill and keeps `.search`'s
// ink; `.chip.error` repaints the ink and keeps `.chip`'s fill. The pair the user sees is split across
// two rules, so the co-occurrence walk above skips it. This walk rebuilds it the way the cascade does:
// for each selector that sets one colour, the other comes from the most specific rule that reaches
// the SAME element (every compound of that rule is contained in the selector's own compounds, subject
// last, ancestors in order). Same element only, never an ancestor: an ancestor's colour reaching a
// descendant through the DOM is what contrast-surfaces.test.tsx measures, against a rendered tree —
// a static guess at it paired `.control-pill`'s ink with the ink-less `.control-pill .dot`.
//
// WHICH FAILURES ARE THIS BUG. Bug 41 is "a token proved against the page fails on the card it
// actually renders on", so a cross-rule pair is reported when its ink PASSES on the page and FAILS
// on the fill it is really painted over. An ink that already fails on the page (light --ink-muted
// 4.29:1, light --ink-faint 3.45:1) is the a11y ledger's recorded page-level debt, a different
// defect with its own ledger entry; the self-test below pins that it is routed there, not lost.
// ---------------------------------------------------------------------------------------------
type CrossPair = Measured & { inkFrom: string; fillFrom: string; onPage: number };

/** Every compound of `rule` is contained in the matching compound of `subject` — subject last,
 *  ancestors as an ordered subsequence. Any element `subject` matches, `rule` matches too. */
export function reaches(rule: string[][], subject: string[][]): boolean {
  const within = (a: string[], b: string[]) => a.every((x) => b.includes(x));
  if (!rule.length || !subject.length || !within(rule[rule.length - 1]!, subject[subject.length - 1]!)) return false;
  let k = subject.length - 2;
  for (let i = rule.length - 2; i >= 0; i--) {
    while (k >= 0 && !within(rule[i]!, subject[k]!)) k--;
    if (k < 0) return false;
    k--;
  }
  return true;
}

export function measureCrossRule(sheets: { name: string; css: string }[] = SHEETS.map((name) => ({ name, css: read(name) }))): CrossPair[] {
  const blocks = themeBlocks();
  const all = sheets.flatMap(({ name, css }) => rules(name, css)).map((r, order) => ({ ...r, order, sels: splitTop(r.selector, ",") }));
  const winner = (subject: string[][], has: (d: Record<string, string>) => string | undefined) => {
    let best: { spec: number; order: number; value: string; from: string } | null = null;
    for (const r of all) {
      const value = has(r.decls);
      if (value === undefined) continue;
      for (const sel of r.sels) {
        if (!reaches(compounds(sel), subject)) continue;
        const spec = specificity(sel);
        if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, value, from: sel };
      }
    }
    return best;
  };
  const out: CrossPair[] = [];
  const seen = new Set<string>();
  for (const r of all) {
    const setsInk = TOKEN.test(r.decls.color ?? "");
    const setsFill = TOKEN.test(bgOf(r.decls) ?? "");
    if (setsInk === setsFill) continue; // both: co-occurrence already measured it; neither: nothing to pair
    for (const sel of r.sels) {
      if (/::/.test(sel)) continue; // a pseudo-element's fill is not its host's; not a same-element pair
      const subject = compounds(sel);
      const ink = winner(subject, (d) => d.color);
      const fill = winner(subject, bgOf);
      const inkT = ink?.value.match(TOKEN)?.[1];
      const fillT = fill?.value.match(TOKEN)?.[1];
      if (!inkT || !fillT || ink!.order === fill!.order) continue; // one rule setting both is co-occurrence's
      const decls: Record<string, string> = {};
      for (const x of all) for (const s of x.sels) if (reaches(compounds(s), subject)) Object.assign(decls, x.decls["font-size"] ? { "font-size": x.decls["font-size"] } : {}, x.decls["font-weight"] ? { "font-weight": x.decls["font-weight"] } : {});
      const { need, why } = threshold(decls);
      for (const theme of ["light", "dark"] as const) {
        const key = `${sel} [${theme}]`;
        if (seen.has(key)) continue;
        seen.add(key);
        const inkHex = resolve(blocks, theme, inkT);
        const fillHex = resolve(blocks, theme, fillT);
        const pageHex = resolve(blocks, theme, "--bg");
        if (!isHex(inkHex) || !isHex(fillHex)) continue;
        out.push({
          key, sheet: r.sheet, selector: sel, theme, ink: inkT, fill: fillT, inkHex, fillHex, need, why,
          ratio: Math.round(contrast(inkHex, fillHex) * 100) / 100, onPage: Math.round(contrast(inkHex, pageHex) * 100) / 100,
          inkFrom: ink!.from, fillFrom: fill!.from,
        });
      }
    }
  }
  return out;
}

/** Bug 41's class exactly: proved on the page, failing on the surface it is really painted over. */
export const provedOnPageFailsOnSurface = (m: { ratio: number; need: number; onPage: number }) => m.ratio < m.need && m.onPage >= m.need;

// ---------------------------------------------------------------------------------------------
// DECLARATIONS — pairs that are below AA on purpose, each with the source that fixes the value and
// the number it actually measures. This is NOT a skip list: a declaration names one selector in one
// theme, carries its measured ratio, and `no declaration is stale` fails if the pair stops failing
// or drifts off its recorded number. Adding one is a decision, the way THEME_INDEPENDENT is in
// theme-literals.test.ts, and the reason has to be a source, not a preference.
//
// WHAT COUNTS AS A REASON, because this list had two entries and lost both.
// `.you-label` (2.80:1) and `.control-pill` (4.30:1) were declared here on the grounds that
// the Computer mockup draws them that way and docs/decisions.md makes the mockups the UI
// implementation target. That was the wrong half of the rule. The mockups are OUR design target, and a
// design at 2.80:1 is one we are free to fix and obliged to. Both are fixed (--ink-on-control 6.75:1,
// --control-ink 4.52:1) and this list is EMPTY today.
//
// So: a declaration's reason must be a documented constraint on the colour itself — not a mockup that
// drew it and not a preference. Anything else is a fix waiting to be done.
// ---------------------------------------------------------------------------------------------
const DECLARATIONS: Record<string, { ratio: number; why: string }> = {};

type Declaration = { ratio: number; why: string };

/** Every way a declaration can have gone stale, as a list of sentences saying what to do about it.
 *  Factored out of the assertion because DECLARATIONS is empty today, and an empty list would
 *  otherwise leave this mechanism asserting nothing at all — the exact shape of a guard that passes
 *  for ever. The self-tests at the bottom of this file drive it with fixtures instead. */
export function staleDeclarations(decls: Record<string, Declaration>, measured: Measured[]): string[] {
  const by = new Map(measured.map((m) => [m.key, m]));
  const wrong: string[] = [];
  for (const [key, { ratio, why }] of Object.entries(decls)) {
    const m = by.get(key);
    if (!m) { wrong.push(`${key} is declared but no rule paints that pair any more — delete the declaration`); continue; }
    if (m.ratio >= m.need) { wrong.push(`${key} now measures ${m.ratio.toFixed(2)}:1 and passes — delete the declaration, the debt is paid`); continue; }
    if (Math.abs(m.ratio - ratio) > 0.05) wrong.push(`${key} measures ${m.ratio.toFixed(2)}:1, not the declared ${ratio}:1 — the colours moved, so re-decide rather than re-record`);
    // A reason is the whole point of a declaration; a one-word one is a skip list with extra steps.
    if (why.length <= 80) wrong.push(`${key} is declared with no real reason — a declaration must cite the original, not a board and not a preference`);
  }
  return wrong;
}

// ---------------------------------------------------------------------------------------------
describe("bug 41 — every colour pair a rule paints together meets its WCAG threshold", () => {
  // The app's undeclared body type. It was a literal 14px and is now --type-ui (13px), the "UI and
  // list rows" rung of the SF ramp the Apple pass put in tokens.css — so this reads the TOKEN and
  // then the token's value, which is a stricter claim than the literal was: it fails both if the
  // body stops using the ramp and if the ramp's own rung moves under it, and `threshold()`'s
  // default (below) is checked against the same number rather than against a copy of it.
  it("the app's body type is the ramp's 13px UI rung, which is what an undeclared rule is measured as", () => {
    const body = rules("app.css", read("app.css")).find((r) => r.selector === "body");
    expect(body?.decls["font-size"], "body's font-size moved; `threshold()`'s default is now wrong").toBe("var(--type-ui)");
    expect(read("tokens.css"), "--type-ui moved; `threshold()`'s default is now wrong").toMatch(/--type-ui:\s*13px/);
  });

  it("no rule paints ink on a fill below its threshold, in either theme", () => {
    const bad = measureAll()
      .filter((m) => m.ratio < m.need && !(m.key in DECLARATIONS))
      .sort((a, b) => a.ratio - b.ratio)
      .map((m) => `${m.ratio.toFixed(2)}:1  ${m.sheet}  ${m.key}  ${m.ink} ${m.inkHex} on ${m.fill} ${m.fillHex}  needs ${m.need} (${m.why})`);
    expect(bad, `a colour pair the app really paints is below AA:\n   ${bad.join("\n   ")}\n`).toEqual([]);
  });

  it("no declaration is stale — a declared pair that now passes, or has drifted, must be re-decided", () => {
    const wrong = staleDeclarations(DECLARATIONS, measureAll());
    expect(wrong, `a declaration has gone stale:\n   ${wrong.join("\n   ")}\n`).toEqual([]);
  });

  it("the sweep reaches the whole renderer, not just app.css", () => {
    const seen = new Set(measureAll().map((m) => m.sheet));
    expect(SHEETS.length, "no renderer stylesheets found").toBeGreaterThan(5);
    expect(seen.has("app.css"), "app.css contributed no pair at all — the walk is broken").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Smoke — the walk finds real rules, and finds the ones this bug was reported against.
// A guard that silently matches nothing passes for ever.
// ---------------------------------------------------------------------------------------------
describe("the walk finds real rules", () => {
  it("finds a substantial number of co-occurring pairs in the real stylesheets", () => {
    const all = measureAll();
    expect(all.length / 2, "the co-occurrence walk found almost nothing — it has stopped parsing").toBeGreaterThan(40);
  });

  it("finds the three rules bug 41 named, with the tokens it named", () => {
    const by = new Map(measureAll().map((m) => [m.key, m]));
    expect(by.get(".search [dark]"), ".search is the rule the a11y sweep and the co-occurrence sweep agreed on").toBeTruthy();
    // The smooth pass (Task 2) repainted .search's fill from --fill-search to --fill-group (the quiet
    // sidebar); contrast-surfaces.test.tsx re-proves the rendered pair still clears AA on the new fill.
    expect(by.get(".search [dark]")!.fill, ".search must still be measured against the CARD, not the page").toBe("--fill-group");
    expect(by.get(".sidebar-error [dark]")!.fill).toBe("--fill-inset");
    expect(by.get(".you-label [light]")!.fill).toBe("--control");
  });

  it("resolves a token that only `:root` defines by falling back to it, the way the cascade does", () => {
    const blocks = themeBlocks();
    expect(resolve(blocks, "dark", "--control"), "--control is theme-independent and must resolve in dark").toBe("#F07A1A");
    expect(resolve(blocks, "dark", "--bg"), "--bg does have a dark value and must not fall back").toBe("#0C0C0C");
  });
});

// ---------------------------------------------------------------------------------------------
// Self-tests. Written against stylesheets defined here, not read from disk, so they keep their
// meaning whatever the app's CSS does next. docs/decisions.md, 2026-09-20: "A guard test must be
// proven RED against the REAL tree, and must carry must-not-fire self-tests for correct code it
// nearly flagged." The near-misses pinned below are the four shapes the cross-product got wrong.
// ---------------------------------------------------------------------------------------------
describe("the guard itself — what it must NOT fire on", () => {
  const measure = (css: string) => measureAll([{ name: "fixture.css", css }]);

  it("never pairs a colour from one rule with a background from another — that is the cross-product", () => {
    // The exact shape that produced 74 impossible light-mode failures: --ink-on-accent is only ever
    // read on a saturated accent, and --bg is only ever behind --ink. Two rules, no pair.
    const m = measure(`.a { color: var(--ink-on-accent); } .b { background: var(--bg); }`);
    expect(m, "a colour and a background in DIFFERENT rules are not a pair the app paints").toEqual([]);
  });

  it("does not pair a bubble's ink with a page it never sits on", () => {
    const m = measure(`.bubble.user { background: var(--bubble-user); color: var(--bubble-user-ink); }`);
    expect(m.map((x) => x.ratio > 4.5), "the user bubble carries its own ink and is legible with it").toEqual([true, true]);
  });

  it("does not treat a gradient, an image or `transparent` as a flat fill", () => {
    expect(measure(`.a { color: var(--ink); background: linear-gradient(var(--bg), var(--fill-soft)); }`), "a gradient has no single fill to measure").toEqual([]);
    expect(measure(`.b { color: var(--ink-icon); background: transparent; }`), "transparent means the fill comes from an ancestor").toEqual([]);
    expect(measure(`.c { color: var(--ink); background: var(--bg) url(x.png); }`), "a shorthand carrying an image is not a flat fill").toEqual([]);
  });

  it("does not flag a pair that passes, and does not flag a literal it cannot resolve", () => {
    expect(measure(`.ok { color: var(--ink); background: var(--bg); }`).every((m) => m.ratio >= m.need), "--ink on --bg is the app's own body pair").toBe(true);
    expect(measure(`.lit { color: #777; background: #fff; }`), "literals are theme-literals.test.ts's job, not this file's").toEqual([]);
  });

  it("does not read a declaration out of a @keyframes block", () => {
    const m = measure(`@keyframes shimmer { from { color: var(--ink-faint); background: var(--bg); } }`);
    expect(m, "a keyframe is an animation step, not a rule that paints a surface").toEqual([]);
  });
});

describe("the guard itself — what it MUST fire on", () => {
  const measure = (css: string) => measureAll([{ name: "fixture.css", css }]);

  it("catches the reported defect's exact shape: an ink proved on the page, used on a card", () => {
    // --ink-faint was validated at 4.59:1 against --bg #0B0B0B and then used on --fill-search #1F1F1F.
    const onPage = measure(`.a { color: var(--ink-faint); background: var(--bg); }`).find((m) => m.theme === "dark")!;
    const onCard = measure(`.b { color: var(--ink-faint); background: var(--fill-search); }`).find((m) => m.theme === "dark")!;
    expect(onPage.ratio, "the number PR #36 reported, against the page").toBeGreaterThanOrEqual(4.5);
    expect(onCard.ratio, "the same ink on the card it renders on — this is the bug").toBeLessThan(onPage.ratio);
  });

  it("catches a pair that fails in only ONE theme, which is how this class hides", () => {
    const m = measure(`.warn { color: var(--ink-on-accent); background: var(--control); }`);
    expect(m.filter((x) => x.ratio < x.need).length, "white on the amber fails in both themes").toBe(2);
    const oneSided = measure(`.x { color: var(--ink-3); background: var(--fill-inset); }`);
    expect(oneSided.length, "both themes are always measured, never just the one in front of you").toBe(2);
  });

  it("uses the 3:1 large-text threshold only when the rule's own type earns it", () => {
    expect(threshold({}).need, "an undeclared rule is body text").toBe(4.5);
    expect(threshold({ "font-size": "13px", "font-weight": "500" }).need, "13px/500 is not large text").toBe(4.5);
    expect(threshold({ "font-size": "24px" }).need, "24px is large text under 1.4.3").toBe(3);
    expect(threshold({ "font-size": "19px", "font-weight": "700" }).need, "18.66px bold is large text under 1.4.3").toBe(3);
    expect(threshold({ "font-size": "19px" }).need, "19px on its own is not — the bold half is required").toBe(4.5);
  });

  it("catches every way a DECLARATION goes stale — the mechanism, which is empty in the app today", () => {
    // This is what deleted `.you-label` and `.control-pill` from DECLARATIONS above: the run that
    // fixed them reported "now measures 7.07:1 and passes — delete the declaration". With the list
    // empty, these fixtures are the only thing keeping that mechanism honest.
    const failing = measureAll([{ name: "f.css", css: `.bad { color: var(--ink-on-accent); background: var(--control); }` }]);
    const reason = "x".repeat(100);
    expect(staleDeclarations({ ".bad [light]": { ratio: 2.8, why: reason } }, failing), "a pair that still fails at its recorded number is NOT stale").toEqual([]);
    expect(staleDeclarations({ ".bad [light]": { ratio: 4.1, why: reason } }, failing)[0], "a pair that drifted off its number must be re-decided").toMatch(/not the declared 4\.1/);
    expect(staleDeclarations({ ".gone [light]": { ratio: 2.8, why: reason } }, failing)[0], "a declaration whose rule was deleted must go too").toMatch(/no rule paints that pair any more/);
    expect(staleDeclarations({ ".bad [light]": { ratio: 2.8, why: "board says so" } }, failing)[0], "a declaration with no real reason is a skip list").toMatch(/no real reason/);
    const passing = measureAll([{ name: "f.css", css: `.bad { color: var(--ink); background: var(--bg); }` }]);
    expect(staleDeclarations({ ".bad [light]": { ratio: 2.8, why: reason } }, passing)[0], "a pair that now passes must be deleted, not left sitting here").toMatch(/passes — delete the declaration/);
  });

  it("reads the background shorthand as well as background-color, or half the app is invisible to it", () => {
    expect(measure(`.a { color: var(--ink-faint); background: var(--fill-search); }`).length).toBe(2);
    expect(measure(`.b { color: var(--ink-faint); background-color: var(--fill-search); }`).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Bug 41, the cross-rule half: a state or variant that sets one colour and inherits the other.
// ---------------------------------------------------------------------------------------------
describe("bug 41 — a colour a state inherits is measured against the fill that state paints", () => {
  it("no ink that passes on the page fails on the fill a state or variant of its own element paints", () => {
    const bad = measureCrossRule()
      .filter(provedOnPageFailsOnSurface)
      .sort((a, b) => a.ratio - b.ratio)
      .map((m) => `${m.ratio.toFixed(2)}:1 (page ${m.onPage.toFixed(2)})  ${m.sheet}  ${m.key}  ${m.ink} ${m.inkHex} from \`${m.inkFrom}\` on ${m.fill} ${m.fillHex} from \`${m.fillFrom}\`  needs ${m.need}`);
    expect(bad, `an ink proved on the page fails on the surface it is painted over:\n   ${bad.join("\n   ")}\n`).toEqual([]);
  });

  it("finds the cross-rule pairs it exists for, in the real stylesheets", () => {
    const all = measureCrossRule();
    const by = new Map(all.map((m) => [m.key, m]));
    const hover = by.get(".search:not(:disabled):hover [dark]");
    expect(hover, "the search field's hover repaints the fill in one rule and its ink in another").toBeTruthy();
    expect(hover!.ink, "the hovered search field's ink is measured, not its resting --ink-icon").toBe("--ink-2");
    expect(hover!.fill, "against the hover fill, not the resting --fill-search").toBe("--fill-selected-hover");
    expect(by.get(".chip.error [light]")?.fillFrom, "a variant's ink sits on its base's fill").toBe(".chip");
    expect(all.length / 2, "the cross-rule walk found almost nothing — it has stopped parsing").toBeGreaterThan(20);
  });
});

describe("the cross-rule walk itself", () => {
  const measure = (css: string) => measureCrossRule([{ name: "fixture.css", css }]);

  it("MUST fire on bug 41's shape split across two rules: a hover fill under the base rule's ink", () => {
    // Carbon: the tertiary ink is the one that is proved on the dark page and short on the pressed fill.
    const m = measure(`.s { color: var(--ink-faint); background: var(--fill-search); } .s:hover { background: var(--fill-selected-press); }`);
    const dark = m.find((x) => x.key === ".s:hover [dark]")!;
    expect(dark.onPage, "--ink-faint is fine on the page").toBeGreaterThanOrEqual(4.5);
    expect(provedOnPageFailsOnSurface(dark), "and fails on the pressed fill it is really painted over").toBe(true);
  });

  it("MUST take the ink from the most specific rule that reaches the element, not the first one", () => {
    const m = measure(`.a { color: var(--ink-faint); } .a.on { color: var(--ink); } .a.on:hover { background: var(--fill-search); }`);
    expect(m.find((x) => x.key === ".a.on:hover [light]")?.ink).toBe("--ink");
  });

  it("must NOT pair an ancestor's ink with a descendant's fill — that is the DOM's job, not the stylesheet's", () => {
    expect(measure(`.pill { color: var(--control-ink); background: var(--control-soft); } .pill .dot { background: var(--control); }`)).toEqual([]);
  });

  it("must NOT pair a rule that reaches a DIFFERENT element", () => {
    expect(measure(`.a { color: var(--ink-faint); } .b:hover { background: var(--fill-press); }`)).toEqual([]);
    expect(measure(`.x .a { color: var(--ink-faint); } .a:hover { background: var(--fill-press); }`).filter((m) => m.selector === ".a:hover"), "`.x .a` does not reach every `.a`").toEqual([]);
  });

  it("must NOT report an ink that already fails on the page as this bug — that is the page-level ledger's", () => {
    // Carbon cleared light --ink-faint on the page, so the disabled ink (never text a user must read) is the page-short one now.
    const m = measure(`.t { color: var(--ink-disabled); } .t:active { background: var(--fill-press); }`).find((x) => x.key === ".t:active [light]")!;
    expect(m.ratio, "light --ink-disabled on the pressed fill really is short").toBeLessThan(4.5);
    expect(m.onPage, "and it is short on the page too").toBeLessThan(4.5);
    expect(provedOnPageFailsOnSurface(m), "so it is routed to the page-level debt, not reported twice").toBe(false);
  });

  it("does not re-measure a rule that sets both colours — co-occurrence owns that", () => {
    expect(measure(`.a { color: var(--ink-faint); background: var(--fill-search); }`)).toEqual([]);
  });
});
