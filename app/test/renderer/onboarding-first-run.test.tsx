// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "../../src/renderer/onboarding/Onboarding";

// First-run guard (fix-ui-onboarding). A visual audit of 678 Chromium screenshots found that a new
// user CANNOT COMPLETE ONBOARDING: on the "Create your own Bot" step `main.onb` measured 4380px wide
// in a 1440px viewport, and every control below the suggestion carousel — the heading, the 120px
// avatar, the colour swatches, the shape picker, the Name field and the Get started button — was
// centred inside that 4380px, i.e. at x≈2100, roughly 700px past the right edge of the window.
// `.window { overflow: hidden }` means there is no scrollbar and no way to pan to them.
//
// CONTRACT-LEVEL ASSERTIONS. The app's test environment is jsdom, which has no layout engine:
// getBoundingClientRect() is all zeros, so "main.onb is 4380px wide" is literally unmeasurable here
// and a jsdom assertion would pass whether the bug is present or not (see the same note at the head
// of layout-fit.test.ts). Every test in the "contract" describes below therefore reads app.css and
// asserts the DECLARATIONS that cause or cure the measured defect. The widths themselves were
// measured for real in Chromium at 1440 and at the app's 1024 floor (main/index.ts minWidth), before
// and after, and the numbers are recorded in each comment.
//
// The DOM assertions (the "markup" describe) are real renders and are not contract-level.

const stylePath = (file: string) => fileURLToPath(new URL("../../src/renderer/styles/" + file, import.meta.url));
const read = (file: string) => readFileSync(stylePath(file), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const escapeSel = (sel: string) => sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bodies of every top-level rule whose selector list contains `sel` exactly. */
function bodiesFor(src: string, sel: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const clean = stripComments(src).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  let m: RegExpExecArray | null;
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

/** Every rule prelude in a stylesheet, comments removed. */
function preludes(src: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripComments(src)))) out.push(m[1]!.trim());
  return out;
}

const hasRule = (src: string, re: RegExp) => preludes(src).some((p) => re.test(p));

describe("contract — defect 1: the suggestion carousel can never set the width of the first-run screen", () => {
  // MEASURED in Chromium, before: main.onb 4380x900 at a 1440 viewport (and 4380x680 at the 1024
  // floor) — `.carousel` holds 22 non-shrinking 200px `.starter-card`s, and as a flex item with the
  // default `min-width: auto` it forced its parent `.onb` to its own min-content width. `.onb` is in
  // turn a `flex-grow: 1` item of `.window`, and its own `min-width: auto` handed that 4380px
  // straight up. `.onb { align-items: center }` then centred everything below the carousel inside
  // 4380px. AFTER: 1440x900 and 1024x680 — the viewport, exactly.
  it("app.css gives `.onb` min-width: 0, so no child's min-content width can become the screen's width", () => {
    expect(declFor(read("app.css"), ".onb", "min-width")).toBe("0");
  });

  it("app.css keeps `.carousel` a scroller and stops it demanding its max-content width", () => {
    const src = read("app.css");
    expect(declFor(src, ".carousel", "min-width"), ".carousel must be able to shrink below its 4300px content").toBe("0");
    expect(declFor(src, ".carousel", "align-self"), ".carousel must span .onb's content box, not fit-content it").toBe("stretch");
    expect(declFor(src, ".carousel", "overflow-x"), "the cards are reached by scrolling the row").toBe("auto");
  });

  // At the 1024x680 floor the new-bot step's column (carousel 173 + heading + 120px avatar + swatches
  // + shape picker + label + field + button + 8 x 14px gaps + 80px padding) is ~730px tall against a
  // 680px window, and `.window { overflow: hidden }` clipped it with no scrollbar. `safe center`
  // rather than `center` because a centred column that overflows its container overflows BOTH ends,
  // and the top half is then unreachable even with a scrollbar.
  it("app.css lets a too-tall first-run column scroll instead of being clipped by .window", () => {
    const src = read("app.css");
    expect(declFor(src, ".onb", "overflow-y")).toBe("auto");
    expect(declFor(src, ".onb", "justify-content"), "plain `center` overflows the unreachable top edge").toBe("safe center");
  });

  // FOUND BY EYE in the re-capture, not by the original audit: with the column now scrolling at the
  // 1024x680 floor, the default `flex-shrink: 1` took the overflow out of whatever would give — the
  // Name field MEASURED 168x17px against its declared 30px bar, a visibly crushed text box. A column
  // that scrolls must not also squash; the scrollbar is the whole point.
  it("app.css never lets .onb pay for its overflow by squashing a child", () => {
    expect(declFor(read("app.css"), ".onb > *", "flex-shrink")).toBe("0");
  });
});

describe("contract — defect 2: Get started is a button, not a slab", () => {
  // MEASURED: 92x240px. `.btn-secondary, .btn-dark { ... flex-grow: 1 }` existed for the avatar
  // editor's horizontal `.editor-actions` row; in `.onb`'s VERTICAL flex column the same declaration
  // made the last button absorb every remaining pixel of height. It is the last button of first-run.
  //
  // This used to be pinned as `.onb .btn-dark { flex-grow: 0 }` — an override cancelling the class's
  // own default in this one place. Bug 30 moved the grow onto `.editor-actions > *`, the row that
  // actually wanted it, so there is no default left to cancel. The two assertions below are what that
  // override was really protecting, and they are strictly stronger: the first holds in EVERY column
  // in the app rather than in `.onb` alone, and the second keeps the avatar editor's row working.
  it("app.css gives .btn-dark no flex-grow of its own, so no column anywhere can stretch it", () => {
    const growing = bodiesFor(read("app.css"), ".btn-dark").filter((b) => /flex-grow:\s*[1-9]/.test(b));
    expect(growing, "a .btn-dark that grows is a .btn-dark that becomes a slab in a vertical column").toEqual([]);
    expect(declFor(read("app.css"), ".onb .btn-dark", "flex-grow"), "and the .onb override is no longer needed").toBeUndefined();
  });

  // The avatar editor's Cancel / Set avatar row still splits its width between the two buttons —
  // The New Bot mockup gives `flex-grow: 1` to exactly those two and to no other 30px
  // button on the same board. MEASURED unchanged across the move: 136.3px and 155.7px in a 300px row.
  it("app.css keeps the avatar editor's row sharing its width, from the row rather than the button", () => {
    expect(declFor(read("app.css"), ".editor-actions > *", "flex-grow")).toBe("1");
  });
});

describe("contract — defect 3: the shape picker and the tool grid are not raw OS controls", () => {
  // MEASURED: eight raw <button>s at appearance: auto, border-radius: 0, background rgb(239,239,239).
  // Rest, hover and press were indistinguishable and there was NO SELECTED STATE AT ALL — the markup
  // carries aria-checked and no CSS read it. In dark they were mid-grey OS slabs.
  it("app.css draws `.onb-shape` itself instead of letting the OS draw it", () => {
    const src = read("app.css");
    expect(declFor(src, ".onb-shape", "appearance")).toBe("none");
    expect(declFor(src, ".onb-shape", "background")).toMatch(/transparent|var\(--/);
    expect(declFor(src, ".onb-shape", "border-radius")).toMatch(/^(\d+px|var\(--radius-[a-z]+\))$/);
    expect(declFor(src, ".onb-shape", "box-sizing")).toBe("border-box");
  });

  it("app.css gives the shape picker the selected state it never had", () => {
    const src = read("app.css");
    const body = bodiesFor(src, '.onb-shape[aria-checked="true"]').join(";");
    expect(body, "aria-checked must be readable by eye, not only by a screen reader").not.toBe("");
    expect(body).toMatch(/border-color:\s*var\(--/);
    expect(body).toMatch(/background(-color)?:\s*var\(--/);
  });

  it("app.css separates rest, hover and press on the shape picker, disabled-gated", () => {
    const src = read("app.css");
    expect(hasRule(src, /\.onb-shape:not\(:disabled\):hover/)).toBe(true);
    expect(hasRule(src, /\.onb-shape:not\(:disabled\):active/)).toBe(true);
    expect(hasRule(src, /\.onb-shape\[aria-checked="true"\]:not\(:disabled\):hover/)).toBe(true);
    expect(hasRule(src, /\.onb-shape\[aria-checked="true"\]:not\(:disabled\):active/)).toBe(true);
  });

  // The onboarding tool grid used native <input type=checkbox>: macOS SYSTEM BLUE ticks, the only
  // saturated blue in a monochrome product, and a light chrome box on a black screen in dark mode.
  it("app.css takes the system blue out of the tool grid's checkboxes", () => {
    expect(declFor(read("app.css"), '.tool-cell input[type="checkbox"]', "accent-color")).toBe("var(--ink)");
  });
});

describe("contract — defect 4: the setup terminal is a themed surface, not a hard-coded slab", () => {
  // MEASURED: `background: #111; color: #e6e6e6`. In light a heavy black slab in an otherwise white
  // minimal screen; in dark #111 on #0B0B0B — about 1.05:1, locatable only by the mono text in it.
  it("app.css paints `.terminal` from tokens in both themes", () => {
    const src = read("app.css");
    expect(declFor(src, ".terminal", "background")).toMatch(/^var\(--[\w-]+\)$/);
    expect(declFor(src, ".terminal", "color")).toMatch(/^var\(--[\w-]+\)$/);
    expect(declFor(src, ".terminal", "border"), "a 1.05:1 panel needs an edge to be findable at all").toMatch(/var\(--/);
  });

  it("app.css lets the 560px terminal fit the 1024 floor", () => {
    const src = read("app.css");
    expect(declFor(src, ".terminal", "max-width")).toBe("100%");
    expect(declFor(src, ".terminal", "box-sizing")).toBe("border-box");
  });
});

describe("contract — the onboarding surfaces take every colour from a token", () => {
  // Exactly the selectors this branch owns. Deliberately NOT the splash's own family (.onb.splash,
  // .onb-logo, .onb-foot, .wordmark, .pill-light): the splash is a full-bleed near-black brand moment
  // in BOTH themes, so its literals are the one place here where a theme token would be wrong.
  const OWNED = [".onb", ".onb-shape", ".onb-swatch", ".onb-suggest", ".carousel", ".starter-card", ".shapes", ".tool-cell", ".terminal"];
  const owns = (sel: string) => OWNED.some((o) => sel === o || sel.startsWith(o + ":") || sel.startsWith(o + "[") || sel.startsWith(o + " ") || sel.startsWith(o + "."));

  it("app.css uses no literal colour in any onboarding rule this branch owns", () => {
    const src = stripComments(read("app.css"));
    const offenders: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const sels = m[1]!.split(",").map((s) => s.trim());
      if (!sels.some((s) => owns(s) && !s.startsWith(".onb.splash"))) continue;
      if (sels.some((s) => s.startsWith(".onb.splash"))) continue;
      if (/#[0-9a-fA-F]{3,8}\b/.test(m[2]!)) offenders.push(`${m[1]!.trim()} { ${m[2]!.trim()} }`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("markup — first run renders reachable controls (real DOM, not contract-level)", () => {
  beforeEach(() => {
    const results: Record<string, unknown> = {
      getOnboarding: { hasSeenOnboarding: false, tokenConfigured: true },
      listStarterTemplates: { starters: [{ id: "s1", name: "Chief of Staff", title: "t", blurb: "b", avatarShape: "gem", avatarColor: "#3472d9", tools: ["Gmail"] }] },
      createAgent: { id: "new-bot" },
    };
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (c: string) => ({ ok: true, result: results[c] ?? {} })),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {},
      appInfo: async () => ({ userName: "u" }),
      native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
    };
  });
  afterEach(cleanup);

  // MEASURED: the <h2> sat INSIDE the carousel's flex row, so it rendered as a ~100x138px three-line
  // column wedged between the left edge of the screen and the first card.
  it('"Meet a future teammate" is a heading above the row, not an item inside it', async () => {
    render(<Onboarding onDone={vi.fn()} initialStep="new-bot" />);
    const h2 = await screen.findByRole("heading", { level: 2 });
    expect(h2.parentElement?.classList.contains("carousel"), "the heading must not be a flex item of the scrolling row").toBe(false);
    expect(h2.closest(".carousel"), "the heading must not sit inside the scroller at all").toBeNull();
  });

  // The region keeps its accessible name so the Async failure state still reports inside it
  // (blank-surfaces.test.tsx searches `within(getByRole("region", { name: /suggestion/i }))`).
  it("the suggestions region still owns both the heading and the scrolling row", async () => {
    render(<Onboarding onDone={vi.fn()} initialStep="new-bot" />);
    const region = await screen.findByRole("region", { name: /suggestion/i });
    expect(region.querySelector("h2")).not.toBeNull();
    expect(region.querySelector(".carousel")).not.toBeNull();
  });

  it("every shape radio carries the class the stylesheet draws, so none is left as an OS button", async () => {
    render(<Onboarding onDone={vi.fn()} initialStep="new-bot" />);
    const shapes = await screen.findAllByRole("radio", { name: /shape$/ });
    // the six forms, in the app grid's order
    expect(shapes.map((s) => s.getAttribute("aria-label"))).toEqual(["Pebble shape", "Orb shape", "Tile shape", "Pill shape", "Dome shape", "Gem shape"]);
    for (const s of shapes) expect(s.className.split(/\s+/), `${s.getAttribute("aria-label")} is an unstyled <button>`).toContain("onb-shape");
  });
});
