import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bug 168: in the Now panel an absent screen ("No screen") filled a ~140 px card with one faint
// line centred in 28 px of padding either side. It is a status, not a picture: it sits as one
// line under the card's heading, left-aligned like every other row in the panel.
const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/app.css", import.meta.url)), "utf8");
const rule = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
};

describe("the empty COMPUTER card (bug 168)", () => {
  it("has no big padding around the absence line in the panel", () => {
    expect(rule(".pcard .screen-thumb:has(.screen-absence)")).toMatch(/padding:\s*0/);
  });
  it("left-aligns the absence line in the panel", () => {
    const r = rule(".pcard .screen-absence.thumb");
    expect(r).toMatch(/align-items:\s*flex-start/);
    expect(r).toMatch(/padding:\s*0/);
  });
});

// Bug 169: `.pcard .routine-row` bled 6 px each side with a negative margin but kept `width: 100%`,
// so it only moved left and its right column ("due", "in 9h") ended 12 px short of the Plan card's.
describe("Scheduled rows in the panel (bug 169)", () => {
  it("widen by what the negative margins take, so both edges line up", () => {
    const r = rule(".pcard .routine-row");
    expect(r).toMatch(/margin:\s*0 -6px/);
    expect(r).toMatch(/width:\s*calc\(100% \+ 12px\)/);
  });
});
