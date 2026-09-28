import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Layout-fit guard (measured layout audit, 4 viewport widths: 1440 default / 1100 / 1024 floor / 900).
//
// WHY THIS READS CSS INSTEAD OF MEASURING A RENDER: the app's test environment is jsdom, which has no
// layout engine at all — getBoundingClientRect() is all zeros and scrollHeight/clientHeight are always
// 0, so "scrollHeight > clientHeight" is unmeasurable there and a jsdom assertion would pass whether
// the bug is present or not. The defects were measured for real in Chromium (Playwright) at the four
// widths; what this file locks down is the CSS *contract* that those measurements proved is needed, so
// the defect cannot be reintroduced by editing the stylesheet.
//
// Defect 1 — a pill button with a fixed `height` and a wrappable label: inside a flex row the button
//   shrinks below its text width, the label wraps to a second line, and because overflow is visible the
//   extra line paints straight through the pill outline. Measured: "Add folder" (Settings -> Computer)
//   at EVERY width incl. 1440; "Skip this step" / "I'm done, continue" (AttentionBanner) from 1100 down,
//   scrollHeight 42/45 vs clientHeight 24/32.
// Defect 2 — a native <select> sizes to its widest <option> (macOS voice names such as "Bad News Barry"),
//   and `.dropdown`'s `flex-shrink: 0` forbade giving that width back, so #voice painted outside its
//   .settings-row / .settings-card at every width.
// Plus two the audit found that were not in the brief: `.member-row` (width:100% + horizontal padding
//   under content-box sizing) escaping .panel by 4px each side, and `.control-pill` spilling at 900.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bodies of every top-level rule whose selector list contains `sel` exactly. */
function bodiesFor(src: string, sel: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const clean = stripComments(src).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  while ((m = re.exec(clean))) {
    if (m[1]!.split(",").some((s) => s.trim() === sel)) out.push(m[2]!);
  }
  return out;
}

/** The winning declaration of `prop` for `sel` across every rule that names it (last one wins). */
function declFor(src: string, sel: string, prop: string): string | undefined {
  let value: string | undefined;
  for (const body of bodiesFor(src, sel)) {
    const m = body.match(new RegExp("(?:^|;)\\s*" + escapeSel(prop) + "\\s*:\\s*([^;]+)"));
    if (m) value = m[1]!.trim();
  }
  return value;
}

/**
 * Declarations that reach `sel`, including from grouped rules that list it alongside others.
 * `.btn-outline` picks up a shared `.btn-primary, .btn-outline, ... { ... }` rule this way.
 */
function reaching(src: string, sel: string, prop: string): string | undefined {
  let value: string | undefined;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const clean = stripComments(src).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (!m[1]!.split(",").some((s) => s.trim() === sel)) continue;
    const d = m[2]!.match(new RegExp("(?:^|;)\\s*" + escapeSel(prop) + "\\s*:\\s*([^;]+)"));
    if (d) value = d[1]!.trim();
  }
  return value;
}

/** Every top-level selector in a stylesheet (for at-rule / breakpoint questions). */
function preludes(src: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push(m[1]!.trim());
  return out;
}

// The pill-shaped text controls: every one sets a fixed bar height and carries a prose label, so every
// one is one narrow flex row away from the measured defect.
// `.stop-btn` was one of three byte-identical spellings of the 28px bar (bug 35), and the ONLY one of
// the three that was ever listed here — so `.teach-btn` and `.teach-pill` pinned a fixed 28px height
// with no nowrap and no flex-shrink, which is exactly the pairing the rules below forbid. That gap
// was latent rather than live (squeezed to a 150px column the teach bar's text absorbs it and the
// buttons keep their width), but it existed only because one bar was written three times. They are
// now one class, `.btn-compact`, so this row covers all three surfaces rather than one of them.
const PILL_CONTROLS = [".btn-primary", ".btn-outline", ".btn-danger", ".btn-secondary", ".btn-compact", ".control-pill"];

describe("defect 1 — a pill button's label can never wrap out of its own pill", () => {
  for (const sel of PILL_CONTROLS) {
    it(`app.css gives \`${sel}\` white-space: nowrap`, () => {
      expect(reaching(read("app.css"), sel, "white-space")).toBe("nowrap");
    });

    it(`app.css gives \`${sel}\` flex-shrink: 0 so a flex row cannot squeeze it under its label`, () => {
      expect(reaching(read("app.css"), sel, "flex-shrink")).toBe("0");
    });

    it(`app.css lays \`${sel}\` out as a centred inline-flex box`, () => {
      const src = read("app.css");
      expect(reaching(src, sel, "display")).toMatch(/inline-flex|flex/);
      expect(reaching(src, sel, "align-items")).toBe("center");
      expect(reaching(src, sel, "justify-content")).toBe("center");
    });

    // MEASURED: `min-height` in place of `height` was written first and measured back out. A definite
    // height is also what stops a flex row stretching a pill to its tallest sibling, and every action
    // row that does not set `align-items` (.cc-actions, .secret-actions, .card-actions, .rule-actions,
    // .sheet-actions, .teach-actions, .onb-nav, .editor-actions, .panel-tools, .screen-hover-actions)
    // then pulled a 26px `.small` pill and a 24px `.control-pill` up to 32px in Chromium. So the
    // contract is not "no fixed height" — it is "a fixed height only ever paired with nowrap", because
    // nowrap is what makes the height safe: wrapping was the only way the label could outgrow it.
    it(`app.css never lets \`${sel}\` pin a height without the nowrap that makes it safe`, () => {
      const src = read("app.css");
      const height = reaching(src, sel, "height");
      if (height === undefined) return;
      // A literal, or the token that IS the literal. The Apple pass put the standard bar in
      // --control-h so the one number lives in one place; a bar that reads it is still a bar with a
      // definite height, which is the only thing this assertion is about.
      expect(height).toMatch(/^(\d+px|var\(--control-h(-primary)?\))$/);
      expect(reaching(src, sel, "white-space"), `${sel} pins ${height} but its label can still wrap out of it`).toBe("nowrap");
    });

    it(`app.css sizes \`${sel}\` border-box, so its bar height includes its border`, () => {
      expect(reaching(read("app.css"), sel, "box-sizing")).toBe("border-box");
    });
  }

  // ---------------------------------------------------------------------------------------------
  // WHAT THIS ASSERTS NOW, AND WHY IT IS STRONGER THAN THE LIST IT REPLACED.
  //
  // It used to pin five different bar heights and four radii, one per button role, each quoted from
  // the mockup of the screen that role first appeared on. That guard was doing its job — it kept the
  // five from drifting — but the five themselves were the defect: a window in which no two buttons
  // were the same shape, where the shape told you which file a component had been written in.
  //
  // The Apple pass collapsed them to ONE bar, so the claim is now the stronger one: every labelled
  // control is --control-h on --radius-control, with ONE named exception (--control-h's small
  // sibling, for a strip of chrome that is itself short) and the small inline pills. A sixth height
  // cannot be added quietly, because there is no list to append to — a new number simply fails.
  // ---------------------------------------------------------------------------------------------
  it("app.css draws every labelled control on ONE bar — 28px, radius 7 — with the small sizes named", () => {
    const src = read("app.css");
    // Brief 2 (UI polish pass): the PRIMARY action is the one exception to the 28px bar — at least
    // 32 tall and 80 wide, on its own token — so it is findable without being louder in colour.
    expect(reaching(src, ".btn-primary", "height")).toBe("var(--control-h-primary)");
    expect(reaching(src, ".btn-primary", "min-width")).toBe("80px");
    for (const sel of [".btn-outline", ".btn-danger", ".btn-secondary"]) {
      expect(reaching(src, sel, "height"), `${sel} is not on the standard bar`).toBe("var(--control-h)");
    }
    for (const sel of [".btn-primary", ".btn-outline", ".btn-danger", ".btn-secondary"]) {
      expect(reaching(src, sel, "border-radius"), `${sel} is not on the control corner`).toBe("var(--radius-control)");
    }
    // The small sizes, named and bounded: macOS's small control (a short strip of chrome) and the
    // two inline pills. Nothing else in app.css may pin a labelled bar at all.
    expect(reaching(src, ".btn-compact", "height")).toBe("24px");
    // UI polish pass: --radius-row is gone (four radii); the compact bar takes the control corner.
    expect(reaching(src, ".btn-compact", "border-radius")).toBe("var(--radius-control)");
    expect(declFor(src, ".btn-outline.small", "height")).toBe("24px");
    expect(reaching(src, ".control-pill", "height")).toBe("24px");
    // The two names the collapse retired. They are the same button as .btn-primary / .btn-outline
    // now, so keeping them would be bug 30 all over again — this fails if either comes back.
    expect(reaching(src, ".btn-dark", "height"), ".btn-dark is .btn-primary now").toBeUndefined();
    expect(reaching(src, ".btn", "height"), ".btn is .btn-outline now").toBeUndefined();
  });


  // The finding this pins is unchanged: no labelled button may go under 8px of side padding, which
  // is what would actually let a label touch its own outline. The exact values moved with the bar
  // (a 28px bar takes 12px sides where a 32px pill took 14), so what is asserted is the floor and
  // the fact that every one of them still declares a padding at all.
  it("app.css leaves every labelled button at least 8px of side padding", () => {
    const src = read("app.css");
    for (const sel of [".btn-outline", ".btn-outline.small", ".btn-primary", ".btn-danger", ".btn-secondary", ".btn-compact"]) {
      const pad = declFor(src, sel, "padding") ?? reaching(src, sel, "padding");
      expect(pad, `${sel} declares no padding`).toBeDefined();
      const sides = Number(/^0 (\d+)px$/.exec(pad!)?.[1]);
      expect(sides, `${sel} padding is not "0 Npx": ${pad}`).not.toBeNaN();
      expect(sides, `${sel} has ${sides}px of side padding`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("defect 2 — a native <select> can give its intrinsic width back to its row", () => {
  it("app.css lets `select.dropdown` shrink: flex-shrink 1, min-width 0, max-width 100%", () => {
    const src = read("app.css");
    expect(declFor(src, "select.dropdown", "flex-shrink")).toBe("1");
    expect(declFor(src, "select.dropdown", "min-width")).toBe("0");
    expect(declFor(src, "select.dropdown", "max-width")).toBe("100%");
  });

  it("app.css ellipsises the shrunk select rather than clipping a voice name mid-glyph", () => {
    expect(declFor(read("app.css"), "select.dropdown", "text-overflow")).toBe("ellipsis");
  });

  it("app.css keeps `.dropdown` itself unshrinkable — only the native select needed to give width back", () => {
    expect(declFor(read("app.css"), ".dropdown", "flex-shrink")).toBe("0");
  });

  it("app.css keeps the voice select's 160px floor, which still fits the card at 1024", () => {
    expect(declFor(read("app.css"), ".voice-card .dropdown", "min-width")).toBe("160px");
  });
});

describe("audit findings outside the brief", () => {
  it("app.css sizes `.member-row` border-box — width:100% plus 4px side padding escaped .panel by 4px each side", () => {
    const src = read("app.css");
    expect(declFor(src, ".member-row", "width")).toBe("100%");
    expect(reaching(src, ".member-row", "box-sizing")).toBe("border-box");
  });

  // Re-measured in Chromium at the four audit widths. `.attention-title` is the fixed label
  // "Needs your attention": it was being squeezed to 113.9px of its 129.8px text and wrapping to two
  // lines at the 1440 DEFAULT (visible in the audit's attention-1440.png) and to three at 1024.
  it("app.css never wraps the attention banner's own label", () => {
    const src = read("app.css");
    expect(declFor(src, ".attention-title", "white-space")).toBe("nowrap");
    expect(declFor(src, ".attention-title", "flex-shrink")).toBe("0");
  });

  // Fixing defect 1 gives the banner's two buttons their full label width back (89.2 -> 98.5 and
  // 126.5 -> 140.2 at 1440), and that width comes out of the instruction: measured, .attention-text
  // fell from 166px to 56px of its 497px at the 1024 floor, and at 900 the banner escaped the chat
  // column by 68.5px. A defect must not be paid for with another one, so the row wraps instead: the
  // instruction keeps a 200px floor and the buttons drop to a second line when the row is too tight
  // for it. `flex-basis: 0` keeps the instruction from forcing that wrap while there IS room, so the
  // 1440 default stays a single-line banner. Measured after: 1440 397px (was 437), 1024 240px (was
  // 166), 900 256px (was 43) and nothing escapes at any width.
  it("app.css lets the attention row wrap rather than crush its instruction", () => {
    const src = read("app.css");
    expect(declFor(src, ".attention", "flex-wrap")).toBe("wrap");
    expect(declFor(src, ".attention-text", "flex-basis")).toBe("0");
    expect(declFor(src, ".attention-text", "min-width")).toBe("200px");
    expect(declFor(src, ".attention-text", "flex-grow")).toBe("1");
  });
});

describe("defect 3 — width breakpoints", () => {
  // MEASURED DECISION, re-measured in Chromium after defects 1 and 2 were fixed. At the app's own
  // floor (minWidth: 1024, app/src/main/index.ts) the chat column is 1024 - 252 sidebar - 284 panel
  // = 432px (with the wide panel, 376px). .attention-text then shows ~167px of its ~630px scrollWidth.
  // That is a legible-content problem, not a containment one: nothing paints outside its box any more,
  // the banner's own buttons stay whole, and the instruction ellipsises exactly as .attention-text was
  // written to. The brief said not to add a breakpoint speculatively, so this asserts the deliberate
  // absence: the only media query in the renderer stylesheets stays the reduced-motion one.
  // The Carbon look (decisions.md, "the Carbon Graphite look") made the breakpoints deliberate: the
  // three columns collapse from the outside in — the right column under 1180px, the sidebar under
  // 760px. These two and the reduced-motion block are the only media queries app.css may carry.
  it("app.css carries exactly the two column collapses and the reduced-motion block", () => {
    const media = preludes(read("app.css")).filter((p) => p.startsWith("@media"));
    expect(media).toEqual(["@media (max-width: 1180px)", "@media (max-width: 760px)", "@media (prefers-reduced-motion: reduce)"]);
  });

  it("the two fixed-width columns total 568px, and the chat column is the one that shrinks", () => {
    const src = read("app.css");
    expect(declFor(src, ".sidebar", "width")).toBe("248px");
    expect(declFor(src, ".panel", "width")).toBe("320px");
    expect(declFor(src, ".main", "min-width")).toBe("0");
  });
});

describe("pass 3 — containment and hit targets at the four audit widths", () => {
  // MEASURED contract, not a new invention: `.window { overflow: hidden }` is why an escaping child
  // cannot be scrolled to. Combined with `.main { min-width: 0 }` above, the chat column is the only
  // flex item allowed to shrink at 1024 and 900.
  it("app.css keeps `.window` from growing a scrollbar the user cannot use", () => {
    expect(declFor(read("app.css"), ".window", "overflow")).toBe("hidden");
  });

  // 28px is the floor this file already uses for compact chrome. `.icon-btn` is the title-bar and
  // tray hit target; shrinking it under 28px at 900 is how a hairline icon becomes unclickable.
  it("app.css keeps `.icon-btn` a 28×28 hit target", () => {
    const src = read("app.css");
    expect(declFor(src, ".icon-btn", "width")).toBe("28px");
    expect(declFor(src, ".icon-btn", "height")).toBe("28px");
  });

  it("app.css lets a settings row shrink instead of blowing its card at 1024", () => {
    const src = read("app.css");
    expect(declFor(src, ".settings-row", "display")).toBe("flex");
    expect(declFor(src, ".settings-card", "box-sizing") ?? reaching(src, ".settings-card", "box-sizing")).not.toBe("content-box");
  });
});
