// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as shared from "@synapse/shared";
import { AVATAR_COLORS, AVATAR_EDITOR_SHAPES, AVATAR_SHAPES, STR } from "@synapse/shared";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { FACE_FORMS, FORM_OF, formPath, superellipsePath } from "../../src/renderer/avatar/face-forms";
import { EYE_INK } from "../../src/renderer/avatar/face-sim";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { REFERENCE_NAME } from "../../../scripts/public-scan";

// The Synapse avatar in the DOM: the user's pick ("Eyes + mouth"), a superellipse pebble with solid
// black eyes and mouth on every body colour, never cut-outs.

let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => { now = 0; queue = []; setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} }); useUi.setState({ ...initialState() }); });
afterEach(() => { cleanup(); setAvatarClock(null); });
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const PRESENCES = ["idle", "thinking", "working", "sending", "searching", "loading", "orbit"] as const;

/** Every painted face mark: eyes (capsules and arcs) and the mouth (line and fill). */
function inkOf(c: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of c.querySelectorAll(".avatar-eye, .avatar-mouth")) {
    for (const a of ["fill", "stroke"]) { const v = el.getAttribute(a); if (v && v !== "none") out.push(v); }
  }
  return out;
}

describe("solid black ink on every body colour (the user's rule)", () => {
  it("EYE_INK is #111110", () => { expect(EYE_INK).toBe("#111110"); });

  it("every palette colour, in every state, paints its eyes and mouth #111110 — no mask, no cut-out", () => {
    for (const color of [...AVATAR_COLORS, "#000000", "#123456"]) {
      for (const presence of PRESENCES) {
        const { container, unmount } = render(<ShapeAvatar shape="pebble" color={color} size={36} presence={presence} seedKey="k" />);
        tick(400);
        expect(container.querySelector("mask"), `${color} ${presence}`).toBeNull();
        expect(container.querySelector("[mask]"), `${color} ${presence}`).toBeNull();
        expect(container.querySelectorAll(".avatar-eye").length).toBeGreaterThanOrEqual(2);
        expect(container.querySelectorAll(".avatar-mouth").length).toBeGreaterThanOrEqual(1);
        const ink = inkOf(container);
        expect(ink.length).toBeGreaterThan(0);
        expect(new Set(ink), `${color} ${presence}`).toEqual(new Set([EYE_INK]));
        // Task 9 fix round 1: a pure white body paints the --bot-white TOKEN, not the literal, so it
        // repaints itself on a theme change; every other colour is painted as-is.
        const expectedFill = /^#(fff|ffffff)$/i.test(color) ? "var(--bot-white)" : color;
        expect(container.querySelector(".avatar-body")!.getAttribute("fill"), `${color} ${presence}`).toBe(expectedFill);
        unmount();
      }
    }
  });

  it("a white body keeps a hairline edge so it shows on a white page; other colours have none", () => {
    const w = render(<ShapeAvatar shape="pebble" color="#ffffff" size={36} />);
    expect(w.container.querySelector(".avatar-body")!.getAttribute("class")).toContain("avatar-body-white");
    w.unmount();
    const b = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} />);
    expect(b.container.querySelector(".avatar-body")!.getAttribute("class")).not.toContain("avatar-body-white");
  });

  it("is flat: no gradient, filter or material layer", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#ce383d" size={52} />);
    for (const sel of ["radialGradient", "linearGradient", "filter", "mask"]) expect(container.querySelector(sel), sel).toBeNull();
  });
});

describe("bodies: generated superellipses, the pebble by default", () => {
  it("the pebble is the studies' body: a 32, b 30, n 2.4, centred (50, 56)", () => {
    expect(formPath("pebble")).toBe(superellipsePath(50, 56, 32, 30, 2.4));
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={72} still />);
    expect(container.querySelector("svg")!.getAttribute("data-form")).toBe("pebble");
    expect(container.querySelector(".avatar-body")!.getAttribute("d")).toBe(formPath("pebble"));
  });

  it("every stored shape id maps to one of the six forms, deterministically; the editor's six are one each", () => {
    expect(AVATAR_SHAPES).toHaveLength(16);
    for (const s of AVATAR_SHAPES) expect(FACE_FORMS).toContain(FORM_OF[s]);
    expect(AVATAR_EDITOR_SHAPES.map((s) => FORM_OF[s])).toEqual(["pebble", "orb", "tile", "capsule", "dome", "gem"]);
    for (const s of AVATAR_SHAPES) {
      const a = renderToStaticMarkup(<ShapeAvatar shape={s} color="#3472d9" size={36} still />);
      const b = renderToStaticMarkup(<ShapeAvatar shape={s} color="#3472d9" size={36} still />);
      expect(a.match(/ d="([^"]+)"/)![1], s).toBe(b.match(/ d="([^"]+)"/)![1]);
      expect(a).toContain(`data-form="${FORM_OF[s]}"`);
    }
  });

  it("every form keeps the face inside the body (eyes and mouth are on the body, not off it)", () => {
    for (const form of FACE_FORMS) {
      const pts = [...formPath(form).matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      const spanAt = (y: number) => { const xs = pts.filter((p) => Math.abs(p[1] - y) < 3).map((p) => p[0]); return [Math.min(...xs), Math.max(...xs)]; };
      for (const [y, half] of [[45, 17], [52, 17], [59, 17], [70, 7]] as const) {
        const [lo, hi] = spanAt(y);
        expect(lo, `${form} @${y}`).toBeLessThan(50 - half);
        expect(hi, `${form} @${y}`).toBeGreaterThan(50 + half);
      }
      expect(Math.max(...pts.map((p) => p[1])), form).toBeCloseTo(86, 0); // one base line for the squash
    }
  });
});

describe("mouth states in the DOM", () => {
  it("smile at rest, hmm while thinking, speak with a voice level, and the hmm returns to a smile", () => {
    const { container, rerender } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="m" />);
    const mouth = () => container.querySelector("svg")!.getAttribute("data-mouth");
    tick(300);
    expect(mouth()).toBe("smile");
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="m" presence="thinking" />);
    tick(600);
    expect(mouth()).toBe("hmm");
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="m" speakingLevel={0.8} />);
    tick(300);
    expect(mouth()).toBe("speak");
    expect(container.querySelector("[data-part=mouth-fill]")!.getAttribute("d")).toMatch(/A/);
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="m" />);
    tick(600);
    expect(mouth()).toBe("smile");
  });
});

describe("no dot above the head (the user: \"avatar dot fully off\")", () => {
  it("in any state the avatar draws a body, two eyes and a mouth — no circle, no spark part", () => {
    for (const presence of PRESENCES) {
      const { container, unmount } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} presence={presence} seedKey="s" />);
      tick(1200, () => {
        expect(container.querySelector("circle"), presence).toBeNull();
        expect(container.querySelector("[data-part=spark], .avatar-spark"), presence).toBeNull();
      });
      unmount();
    }
  });
  it("no Settings row offers it and no setting stores it", () => {
    expect(Object.keys(STR)).not.toContain("avatarSpark");
    expect(Object.keys(shared)).not.toContain("AVATAR_SPARKS");
  });
});

describe("no competitor-derived code or names remain in the avatar", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  it("the copied reference data, its generator and the modules named after the reference are gone", () => {
    const avatar = fs.readdirSync(path.join(root, "src/renderer/avatar"));
    expect(avatar.filter((f) => REFERENCE_NAME.test(f))).toEqual([]);
    expect(fs.existsSync(path.join(root, "scripts/gen-avatar-data.mjs"))).toBe(false);
  });
  it("the avatar's svg carries the Synapse class", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} />);
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("face-avatar");
  });
});
