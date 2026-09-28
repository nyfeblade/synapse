// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";

// Soft 3D in the DOM: the silhouette is its own layer (the face is not scaled by it), the mouth
// foreshortens as a group, each eye leaves at its own limb, the near eye draws last, listening leans
// in, and the flat contact shadow is only drawn at >= 48 px.

let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => { now = 0; queue = []; setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} }); });
afterEach(() => { cleanup(); setAvatarClock(null); });
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const q = (c: HTMLElement, part: string) => c.querySelector(`[data-part=${part}]`)!;

describe("soft 3D layers", () => {
  it("the outline carries the silhouette; the face is its sibling, not inside it; the mouth is one group", () => {
    const html = renderToStaticMarkup(<ShapeAvatar shape="pebble" color="#3472d9" size={36} still />);
    expect(html).toMatch(/data-part="body-d"[^>]*transform="translate\(/);
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} still />);
    expect(q(container, "body-d").contains(q(container, "face"))).toBe(false);
    expect(q(container, "mouth").contains(q(container, "mouth-line"))).toBe(true);
    expect(q(container, "mouth").getAttribute("transform")).toMatch(/scale\(/);
  });

  it("a contact shadow only at >= 48 px: one flat #000 ellipse, faint, no gradient or filter", () => {
    const big = render(<ShapeAvatar shape="pebble" color="#3472d9" size={96} still />);
    const sh = big.container.querySelector("[data-part=shadow]")!;
    expect(sh.tagName.toLowerCase()).toBe("ellipse");
    expect(sh.getAttribute("fill")).toBe("#000");
    expect(Number(sh.getAttribute("opacity"))).toBeLessThanOrEqual(0.12);
    for (const sel of ["radialGradient", "linearGradient", "filter", "mask"]) expect(big.container.querySelector(sel)).toBeNull();
    big.unmount();
    const small = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} still />);
    expect(small.container.querySelector("[data-part=shadow]")).toBeNull();
  });

  it("the twirl: the far eye leaves before the face does, and the face comes back", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={96} seedKey="t" />);
    tick(600);
    fireEvent.click(container.querySelector("svg")!);
    let oneEyeGone = false, faceGone = false;
    tick(2500, () => {
      const face = q(container, "face").getAttribute("visibility") !== "hidden";
      const e0 = q(container, "eye0").getAttribute("visibility") !== "hidden", e1 = q(container, "eye1").getAttribute("visibility") !== "hidden";
      if (face && e0 !== e1) oneEyeGone = true;
      if (!face) faceGone = true;
    });
    expect(oneEyeGone).toBe(true);
    expect(faceGone).toBe(true);
    expect(q(container, "face").getAttribute("visibility")).toBe("visible");
  });

  it("depth order: the near eye is drawn after (over) the far one", () => {
    const { container, rerender } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={96} seedKey="d" />);
    tick(1500);
    const order = () => [...q(container, "eyes").querySelectorAll("rect")].map((r) => r.getAttribute("data-part"));
    expect(order()[1]).toBe("eye0"); // resting turn: eye 0 is near
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={96} seedKey="d" presence="thinking" />);
    tick(2500);
    expect(order()[1]).toBe("eye1"); // turned aside the other way
  });

  it("listening leans in toward the user", () => {
    const { container, rerender } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={96} seedKey="l" />);
    tick(800);
    const lean = () => Number(q(container, "rig").getAttribute("transform")!.match(/scale\(([\d.]+)/)![1]);
    expect(lean()).toBeCloseTo(1, 2);
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={96} seedKey="l" listening />);
    tick(1500);
    expect(lean()).toBeGreaterThan(1.015);
  });
});
