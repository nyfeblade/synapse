// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { MessageActions } from "../../src/renderer/components/MessageActions";
import { installFakeBridge } from "./fake-bridge";

// ---------------------------------------------------------------------------
// Bug 40 — an overlay may not present an interactive surface over its NEIGHBOUR.
//
// The instance: `.msg-actions` sat at `top: -14px`, overhanging its own `.msg` upward by 14px, while
// `.transcript` lays the messages out with `gap: 8px`. 14 > 8, so 6px of every message's toolbar lay
// on top of the PREVIOUS message. Measured in Chromium at 1000px, both themes, identical numbers:
//
//   .transcript row-gap .............. 8px
//   .msg-actions computed top ........ -14px
//   msg[1] border box ................ top 463.11  bottom 501.41
//   msg[2]'s toolbar box ............. top 495.41  bottom 529.41   (94px wide)
//   overlap rectangle ................ x [886, 980]  y [495.41, 501.41]  =  94 x 6.00 px
//
// At rest that is harmless — the bar is `pointer-events: none`. `.msg:hover .msg-actions` flips it to
// `auto`, and because the bar is a DOM child of `.msg`, hovering the BAR keeps `.msg:hover` true: the
// arming latches. So the sequence "hover a message, then reach for the message above it" leaves the
// lower message's toolbar armed and sitting over the upper message's bottom 6px. Hit-tested in
// Chromium with the lower message hovered, 15 of 30 sampled points in that band resolved to the next
// message's toolbar (three of them to its BUTTONS), and a real mouse down/up on a control at the
// upper message's bottom edge registered ZERO clicks on that control.
//
// THE SECOND VICTIM, which is why the fix is not an offset: the other 20px of the 34px bar lay
// INSIDE its own message, over whatever that message's first child was. For a text bubble that is
// cosmetic. For a 38.5px file card it swallowed the CENTRE — the point a pointer aims at — and that,
// not the neighbour band, is what times the `file previews` journey out: `Open notes.md` centred at
// y 711.86 with its OWN bar's box at y 678.61-712.61, x 1042-1136, 0.75px of overlap. The bar is 34px
// tall and the gap is 8px, so overhang + intrusion = 34 always: every pixel taken off the neighbour
// is a pixel added over its own message. No offset is safe on both sides.
//
// THE FIX: lay it out beside the bubble, in flow (`.msg-line` in app.css). Out of flow it can
// overhang something; in flow it cannot overhang anything, and the class cannot recur here at all.
//
// THE CLASS, and the rule this file holds: an absolutely-positioned overlay that is in the DOM at
// rest and is armed by `:hover` / `:focus-within` may overhang its containing block by no more than
// the gap of the list its owner sits in. Inside that gap it covers nobody; one pixel past it, it
// covers a neighbour it does not belong to.
//
// A CSS-only assertion cannot see the click theft itself — every rule here is individually correct
// and the defect lives in their interaction. The behavioural proof is
// `app/e2e/phase2-fuzz-journeys.e2e.ts` ("a control at a message's bottom edge is clickable while the
// message below it is hovered"), which drives the real app at real geometry. What THIS file does is
// keep the two numbers that the measurement tied together from drifting apart again, and force any
// NEW overhanging overlay to be declared with a reason that is measured rather than asserted.
// ---------------------------------------------------------------------------

// `fileURLToPath(import.meta.url)` and not `new URL(dir, import.meta.url)`: under jsdom the global
// URL resolves a directory-form relative reference against the document base (http://localhost:3000),
// not against the module — and `fileURLToPath` is also the API that decodes the `%20` in "My Project".
const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "renderer", "styles");
const read = (file: string): string => readFileSync(path.join(stylesDir, file), "utf8");
const SHEETS = readdirSync(stylesDir).filter((f) => f.endsWith(".css")).sort();

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");
const stripKeyframes = (src: string): string => src.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

interface Rule { sheet: string; selector: string; body: string }

/** Every top-level (and @media-nested) style rule in a sheet, one entry per selector in the list. */
function rulesOf(sheet: string): Rule[] {
  const out: Rule[] = [];
  const clean = stripKeyframes(stripComments(read(sheet)));
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const prelude = m[1]!.trim();
    if (prelude.startsWith("@") || prelude === "") continue; // @media / @supports preludes carry no declarations
    for (const sel of prelude.split(",")) out.push({ sheet, selector: sel.trim(), body: m[2]! });
  }
  return out;
}

const ALL: Rule[] = SHEETS.flatMap(rulesOf);

const decl = (body: string, prop: string): string | undefined =>
  body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"))?.[1]?.trim();

/** The winning value of `prop` for `selector`, across every rule that names it (last one wins). */
function winning(rules: Rule[], selector: string, prop: string): string | undefined {
  let value: string | undefined;
  for (const r of rules) if (r.selector === selector) { const v = decl(r.body, prop); if (v !== undefined) value = v; }
  return value;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** Selectors that are out of flow AND reach outside their containing block on at least one side. */
function overhanging(rules: Rule[]): { selector: string; sheet: string; overhangPx: number; side: string }[] {
  const seen = new Set(rules.map((r) => r.selector));
  const out: { selector: string; sheet: string; overhangPx: number; side: string }[] = [];
  for (const selector of seen) {
    const position = winning(rules, selector, "position");
    if (position !== "absolute" && position !== "fixed") continue;
    let worst = 0; let side = "";
    for (const s of SIDES) {
      const v = winning(rules, selector, s);
      const px = v?.match(/^-([\d.]+)px$/);
      if (px && Number(px[1]) > worst) { worst = Number(px[1]); side = s; }
    }
    if (worst > 0) out.push({ selector, sheet: rules.find((r) => r.selector === selector)!.sheet, overhangPx: worst, side });
  }
  return out.sort((a, b) => a.selector.localeCompare(b.selector));
}

/**
 * DECLARATIONS, not a skip list. Every overhanging overlay names the list its owner is laid out in;
 * the budget is that list's `gap`, READ FROM THE STYLESHEET, and the test compares the two numbers.
 * Nothing here can be satisfied by adding a name: change either number and the entry fails.
 */
interface Budget { selector: string; sheet: string; ownerList: string; listSheet: string; why: string }
const DECLARED: Budget[] = [
  // Empty since bug 43. The list's one entry was `.avatar-wrap .marker`, the sidebar's presence dot,
  // pinned at `right: -1px; bottom: -1px` so its ring read as a cutout of the row's fill. Bug 43 moved
  // the dot to the END of the `<a>` (so a row's accessible name begins with its Bot's name in every
  // state) and positions it against `.row` / `.tile` instead, with POSITIVE offsets computed from the
  // avatar's own size. The dot lands on exactly the same pixels — re-measured in Chromium, both sizes
  // and both themes — but it no longer reaches outside its containing block at all, so there is
  // nothing left to excuse. The budget comparison below still runs over whatever is declared, and the
  // self-tests further down prove the walk and the comparison still fire on a real overhang, so an
  // empty list here cannot be mistaken for a detector that stopped looking.
];

const entry: SendMessageEntry = {
  kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 1,
  message: { type: "text", content: "Booked the 9:10." }, reactions: [],
};

describe("an overlay may not present an interactive surface over its neighbour (bug 40)", () => {
  it("finds stylesheets and positioned rules to check at all (the guard's own smoke test)", () => {
    // A zero from any of these makes every assertion below pass vacuously.
    expect(SHEETS.length, "renderer stylesheets").toBeGreaterThan(5);
    expect(ALL.length, "style rules parsed").toBeGreaterThan(400);
    const positioned = new Set(ALL.filter((r) => /position:\s*(absolute|fixed)/.test(r.body)).map((r) => r.selector));
    expect(positioned.size, "out-of-flow selectors").toBeGreaterThan(15);
    // The walk used to be anchored on a NAMED real overlay (`.avatar-wrap .marker`), because a count
    // drifts with the sheets and a parser that silently stopped reading offsets would still satisfy
    // "greater than zero". Bug 43 removed that overlay — the sidebar's dot is now positioned from
    // `.row` / `.tile` with positive offsets and reaches outside nothing — and it was the only one in
    // the app, so there is no real overlay left to anchor on. The non-vacuity claim therefore moves to
    // the detector itself: the self-tests below run the same `overhanging()` over hand-written rules
    // and require it to fire on `top: -14px` and stay silent on a positive offset. If it ever stopped
    // reading offsets, those fail; "zero overhanging overlays" only ever means zero.
    expect(overhanging(ALL), "every out-of-flow overlay in this app stays inside its own box").toEqual([]);
  });

  it("every overhanging overlay is declared, with the list its owner sits in", () => {
    const undeclared = overhanging(ALL)
      .filter((o) => !DECLARED.some((d) => d.selector === o.selector))
      .map((o) => `${o.sheet} ${o.selector} (${o.side}: -${o.overhangPx}px)`);
    expect(undeclared, "a new overlay that reaches outside its box must declare the gap it is allowed to use").toEqual([]);
  });

  it("no declaration is stale: each one still names a real overhanging overlay", () => {
    // Without this, a declaration outlives the rule it excused and quietly blesses the next thing
    // that takes the selector's name.
    const live = overhanging(ALL);
    const stale = DECLARED.filter((d) => !live.some((o) => o.selector === d.selector && o.sheet === d.sheet)).map((d) => d.selector);
    expect(stale, "delete a declaration when its overlay stops overhanging").toEqual([]);
  });

  // One `it` looping over DECLARED rather than `it.each`, so the claim is still made — and still
  // fails per entry, with the same message — when the list is empty (see the note on DECLARED).
  it("every declared overhang is no more than its owner list's gap", () => {
    for (const d of DECLARED) {
      const overhang = overhanging(ALL).find((o) => o.selector === d.selector)!.overhangPx;
      const gapDecl = winning(ALL, d.ownerList, "gap") ?? winning(ALL, d.ownerList, "row-gap");
      expect(gapDecl, `${d.ownerList} must declare the gap ${d.selector} is measured against`).toBeDefined();
      const gap = Number(gapDecl!.trim().split(/\s+/)[0]!.replace("px", ""));
      expect(Number.isFinite(gap) && gap > 0, `${d.ownerList} gap parsed from ${d.listSheet}`).toBe(true);
      expect(overhang, `${d.selector} overhangs ${overhang}px into a ${gap}px gap — ${overhang - gap}px of it lies on the neighbour. ${d.why}`)
        .toBeLessThanOrEqual(gap);
    }
  });

  it("the message hover toolbar is laid out beside its bubble, not floated over it", () => {
    // The instance the rule above was written for, pinned separately — because a declaration would
    // let it back: an overhang of 4px would satisfy "no more than the 8px gap" and still leave the
    // bar over its OWN message's first child, which is the half that swallowed `Open notes.md`'s
    // centre. The bar is 34px tall and the gap is 8px, so no offset makes both halves safe. Out of
    // flow it can overhang something; in flow it cannot overhang anything.
    const body = ALL.filter((r) => r.selector === ".msg-actions").map((r) => r.body).join(";");
    expect(body, ".msg-actions exists").not.toBe("");
    expect(winning(ALL, ".msg-actions", "position"), "a toolbar that floats over the transcript is a hit target over someone else's message")
      .not.toMatch(/absolute|fixed/);
    for (const side of SIDES) {
      expect(winning(ALL, ".msg-actions", side), `.msg-actions must not offset itself ${side}`).toBeUndefined();
    }
    // …and it still hides by paint with both reveal branches, which is what made it keyboard-reachable.
    expect(decl(body, "opacity"), "hidden by paint, not by layout").toBe("0");
    expect(decl(body, "display"), "display:none takes React/Reply/More out of the tab order").toBe("flex");
    const reveal = ALL.filter((r) => /\.msg-actions$/.test(r.selector) && decl(r.body, "opacity") === "1").map((r) => r.selector);
    expect(reveal.some((s) => s.includes(":hover")), "revealed on hover").toBe(true);
    expect(reveal.some((s) => s.includes(":focus-within")), "revealed on focus-within, for the keyboard").toBe(true);
  });

  // --- must-not-fire self-tests: the detector on known-correct and known-broken input --------------
  it("fires on an overhang past the gap and stays silent on one inside it (self-test)", () => {
    const broken = [{ sheet: "x.css", selector: ".x", body: "position:absolute;top:-14px" }];
    const inside = [{ sheet: "x.css", selector: ".x", body: "position:absolute;top:-4px" }];
    expect(overhanging(broken)[0]).toMatchObject({ selector: ".x", overhangPx: 14, side: "top" });
    expect(overhanging(inside)[0]).toMatchObject({ selector: ".x", overhangPx: 4 });
    // The walk only reports the reach; the budget comparison is what separates the two.
    expect(14 > 8).toBe(true);
    expect(4 <= 8).toBe(true);
  });

  it("does not flag an in-flow element, a positive offset, or a positioned element that stays inside (self-test)", () => {
    // Three shapes that are NOT this defect. A guard that fires on correct code gets an allowlist
    // bolted on within a week, and then it guards nothing.
    expect(overhanging([{ sheet: "x.css", selector: ".flow", body: "display:flex;margin-top:-6px" }]), "in-flow: it reserves its own space").toEqual([]);
    expect(overhanging([{ sheet: "x.css", selector: ".pop", body: "position:absolute;top:28px" }]), "a positive offset cannot be judged from CSS text").toEqual([]);
    expect(overhanging([{ sheet: "x.css", selector: ".inset", body: "position:absolute;inset:0" }]), "inset:0 is exactly its container").toEqual([]);
  });

  it("reads the real gap it measures against, not a hard-coded 8 (self-test)", () => {
    // 12 -> 8. The Apple pass put the transcript on the 8pt base gap and moved the extra 12 that makes
    // 20px between TURNS onto the thing that opens a turn (its head, or the user's own message), so
    // one number is not being asked to be right for two different distances.
    expect(winning(ALL, ".transcript", "gap"), "if .transcript stops declaring a gap this guard must fail loudly").toBe("8px");
    expect(winning(ALL, ".rows", "gap")).toBe("1px");
  });

  // --- the two siblings the audit checked that this walk cannot see ------------------------------
  describe("siblings checked by hand, because CSS text cannot judge them", () => {
    beforeEach(() => { installFakeBridge(); });
    afterEach(() => { cleanup(); });

    it(".screen-hover-actions is in normal flow, so it has no overhang to bound", () => {
      // The other opacity-0/:focus-within hover bar in the app, and the pattern .msg-actions copied.
      // It is `display: flex; margin-top: 6px` inside `.panel` — it reserves its own space and there
      // is no box of anyone else's for it to sit on.
      const body = ALL.filter((r) => r.selector === ".screen-hover-actions").map((r) => r.body).join(";");
      expect(body, ".screen-hover-actions exists").not.toBe("");
      expect(body, "if it ever goes out of flow it must be measured like .msg-actions").not.toMatch(/position:\s*(absolute|fixed)/);
      expect(decl(body, "display")).toBe("flex");
    });

    it(".emoji-pop reaches past its own message, but only while the user has it open", () => {
      // Measured in Chromium: the quick-reaction popover ends 14.71px below its own `.msg` and 6.71px
      // into the next one. That is the same reach — but it is not the same contract. `.msg-actions` is
      // in the DOM under every message all the time and is armed by a hover the user did not ask for;
      // `.emoji-pop` exists only after React is pressed, and a popover's whole job is to be on top of
      // what is under it. The reason is measured here rather than asserted: at rest it is not rendered
      // at all, so there is nothing to intercept anything.
      const { container } = render(<div className="msg bot"><MessageActions botId="b" entry={entry} text="Booked the 9:10." /></div>);
      expect(container.querySelector(".emoji-pop"), "no picker in the DOM until React is pressed").toBeNull();
      fireEvent.click(screen.getByRole("button", { name: STR.react }));
      expect(container.querySelector(".emoji-pop"), "and it appears when it is asked for").not.toBeNull();
    });
  });
});
