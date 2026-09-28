// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";
import { EYE_INK } from "../../src/renderer/avatar/face-sim";
import { setAvatarClock, tickerCount } from "../../src/renderer/avatar/avatar-loop";
import { resolve, themeBlocks } from "./contrast-kit";

afterEach(() => { cleanup(); setAvatarClock(null); });

describe("eyes are painted, never holes", () => {
  it("the static markup (pickers, first paint) already has two black eyes and a black mouth, no mask", () => {
    for (const color of ["#3472d9", "#ffffff", "#ce383d"]) {
      const html = renderToStaticMarkup(<ShapeAvatar shape="pebble" color={color} size={36} still />);
      expect(html).not.toContain("<mask");
      expect(html.match(/class="avatar-eye"[^>]*fill="#111110"/g) ?? [], color).toHaveLength(2);
      expect(html).toMatch(/class="avatar-mouth"[^>]*stroke="#111110"/);
      expect(EYE_INK).toBe("#111110");
    }
  });
});

// Task 9 fix round 1 (docs/sdd, 2026-09-23; controller ruling): the first cut resolved a pure
// #FFFFFF Bot colour to #E6E6E6 at RENDER TIME (a JS matchMedia/data-theme read), so an
// already-mounted white avatar never repainted when the user toggled Appearance or the OS flipped
// scheme — every other themed colour in the app is a CSS custom property and needs no such read.
// The fix: ShapeAvatar paints a pure-white Bot colour as `fill="var(--bot-white)"`, a token
// tokens.css themes normally (light #FFFFFF, both dark blocks #E6E6E6), so the SVG repaints itself
// the instant `data-theme` changes or the OS scheme flips, with no JS in the loop at all.
describe("white Bots paint the --bot-white token (Task 9 fix round 1)", () => {
  it("a pure white Bot's body fill is var(--bot-white); other colours are untouched", () => {
    const white = renderToStaticMarkup(<ShapeAvatar shape="pebble" color="#ffffff" size={36} still />);
    expect(white).toMatch(/class="avatar-body avatar-body-white"[^>]*fill="var\(--bot-white\)"/);
    const other = renderToStaticMarkup(<ShapeAvatar shape="pebble" color="#3472d9" size={36} still />);
    expect(other).toContain('fill="#3472d9"');
    expect(other).not.toContain("avatar-body-white");
  });

  it("matches #fff and #FFFFFF alike (case-insensitive, any of the two spellings)", () => {
    for (const c of ["#fff", "#FFF", "#ffffff", "#FFFFFF"]) {
      expect(renderToStaticMarkup(<ShapeAvatar shape="pebble" color={c} size={36} still />)).toMatch(/fill="var\(--bot-white\)"/);
    }
  });

  it("--bot-white resolves to #FFFFFF in light and #E6E6E6 in both dark blocks", () => {
    const blocks = themeBlocks();
    expect(resolve(blocks, "light", "--bot-white")).toBe("#FFFFFF");
    expect(resolve(blocks, "dark", "--bot-white")).toBe("#E6E6E6");
  });

  it("keeps the white hairline stroke rule for a white body", () => {
    const html = renderToStaticMarkup(<ShapeAvatar shape="pebble" color="#ffffff" size={36} still />);
    expect(html).toMatch(/class="avatar-body avatar-body-white"/);
  });
});

describe("one shared loop drives every avatar", () => {
  it("many avatars register one rAF callback per frame, and the loop writes each avatar's frame", () => {
    let now = 0;
    const queue: (() => void)[] = [];
    setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return queue.length; }, caf: () => {} });
    const { container } = render(<>{Array.from({ length: 12 }, (_, i) => <ShapeAvatar key={i} shape="pebble" color="#3472d9" size={36} seedKey={`b${i}`} />)}</>);
    expect(tickerCount()).toBe(12);
    expect(queue).toHaveLength(1); // one callback for twelve avatars
    const first = container.querySelector("[data-part=eyes]")!.getAttribute("transform");
    for (let f = 0; f < 240; f++) { now += 1000 / 60; const cb = queue.shift()!; act(() => cb()); expect(queue).toHaveLength(1); }
    expect(container.querySelector("[data-part=eyes]")!.getAttribute("transform")).not.toBe(first); // the idle gaze drifts
    cleanup();
    expect(tickerCount()).toBe(0);
  });

  it("a presence change reaches the running avatar: thinking turns the smile into the hmm", () => {
    let now = 0;
    const queue: (() => void)[] = [];
    setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} });
    const { container, rerender } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="x" />);
    const tick = (ms: number) => { for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); } };
    tick(500);
    expect(container.querySelector("svg")!.dataset.mouth).toBe("smile");
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="x" presence="thinking" />);
    tick(1500);
    expect(container.querySelector("svg")!.dataset.mouth).toBe("hmm");
  });

  it("stops the loop while the window is hidden", () => {
    let now = 0;
    const queue: (() => void)[] = [];
    setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => { queue.length = 0; } });
    render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} />);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(queue).toHaveLength(1);
    now += 16;
  });
});
