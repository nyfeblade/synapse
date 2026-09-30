// The website's Bot drawing moved out of site/build.mjs into shared/src/bot-face.js (so /bot can draw in the
// browser). The output must be byte-for-byte what it was.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { botSvg, botDefs, formPath, FORM_SPECS, FORM_OF, EYE_INK } from "../src/bot-face.js";
// @ts-expect-error plain ESM build script, no types
import * as site from "../../site/build.mjs";
import { AVATAR_SHAPES } from "../src/bots";

const SHAPES = ["pebble", "orb", "tile", "pill", "capsule", "dome", "gem", "puff", "bead", "hex", "diamond", "shield", "crescent", "petal", "stadium", "notch", "wave", "nope"];

describe("bot-face", () => {
  it("draws exactly what site/build.mjs drew before the move", () => {
    const all = SHAPES.map((x) => botSvg(x, "#3674d8", "md")).join("\n") + botDefs();
    expect(crypto.createHash("sha256").update(all).digest("hex")).toBe("69f355e768aefc4a71353ebfd48bd0bfc026280f85e14bd0f2b36f1e53f8df58");
  });
  it("is the one copy the site build uses", () => {
    expect(site.botSvg).toBe(botSvg);
    expect(site.formPath).toBe(formPath);
    expect(site.EYE_INK).toBe(EYE_INK);
  });
  it("maps every app shape to a form it defines", () => {
    for (const s of AVATAR_SHAPES) expect(FORM_SPECS[FORM_OF[s] as keyof typeof FORM_SPECS]).toBeTruthy();
  });
});
