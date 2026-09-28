// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { CallMeter, METER_BARS, METER_ENVELOPE, meterBars, meterFollow } from "../../src/renderer/voice/CallMeter";

// The call's microphone meter: STATIONARY. It used to be a 32-sample history shifted left on every
// level event, with a CSS transition on each bar smearing the scroll — so the waveform travelled
// across the screen. Now a fixed, centred envelope breathes in place with the current level.

let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => { now = 0; queue = []; setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} }); });
afterEach(() => { cleanup(); setAvatarClock(null); });
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const scales = (c: HTMLElement) => [...c.querySelectorAll(".call-wave i")].map((i) => Number((i as HTMLElement).style.transform.match(/scaleY\(([\d.]+)\)/)![1]));

describe("the envelope", () => {
  it("about eleven bars, symmetric around the middle, tallest in the centre", () => {
    expect(METER_BARS).toBe(11);
    expect(METER_ENVELOPE).toHaveLength(11);
    for (let i = 0; i < 11; i++) expect(METER_ENVELOPE[i]).toBeCloseTo(METER_ENVELOPE[10 - i]!, 6);
    for (let i = 0; i < 5; i++) expect(METER_ENVELOPE[i]!).toBeLessThan(METER_ENVELOPE[i + 1]!);
    expect(METER_ENVELOPE[5]).toBe(1);
  });

  it("the bars never travel: every level draws the same shape, only its height changes", () => {
    const norm = (xs: number[]) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (x - lo) / (hi - lo)); };
    const shapes = [0.2, 0.45, 0.7, 1].map((lvl) => norm(meterBars(lvl, false)));
    for (const s of shapes.slice(1)) s.forEach((v, i) => expect(v).toBeCloseTo(shapes[0]![i]!, 6));
    for (const lvl of [0.2, 0.5, 0.9]) {
      const b = meterBars(lvl, false);
      expect(b.indexOf(Math.max(...b))).toBe(5); // the peak is always the centre bar
    }
    const lo = meterBars(0.2, false), hi = meterBars(0.9, false);
    lo.forEach((v, i) => expect(hi[i]!).toBeGreaterThan(v)); // louder is taller everywhere
  });

  it("muted: flat and low", () => {
    const b = meterBars(0.9, true);
    expect(new Set(b).size).toBe(1);
    expect(b[0]!).toBeLessThan(0.15);
  });
});

describe("smoothing: a quick attack (~60 ms), a slower release (~250 ms)", () => {
  it("rises to most of a step within ~3 attack constants, and falls on the release constant", () => {
    let v = 0;
    for (let t = 0; t < 180; t += 1000 / 60) v = meterFollow(v, 1, 1000 / 60);
    expect(v).toBeGreaterThan(0.9);
    let w = 1;
    for (let t = 0; t < 250; t += 1000 / 60) w = meterFollow(w, 0, 1000 / 60);
    expect(w).toBeGreaterThan(0.3);
    expect(w).toBeLessThan(0.45);
    for (let t = 0; t < 1000; t += 1000 / 60) w = meterFollow(w, 0, 1000 / 60);
    expect(w).toBeLessThan(0.02);
  });
});

describe("the meter in the DOM", () => {
  it("keeps role=meter and aria-valuenow, and its bars stay in place between samples", () => {
    const { container, rerender } = render(<CallMeter level={0} muted={false} label="Microphone level" />);
    const meter = container.querySelector("[role=meter]")!;
    expect(meter.getAttribute("aria-label")).toBe("Microphone level");
    const samples = [30, 80, 10, 60, 95, 0];
    for (const lvl of samples) {
      rerender(<CallMeter level={lvl} muted={false} label="Microphone level" />);
      expect(meter.getAttribute("aria-valuenow")).toBe(String(lvl));
      tick(100, () => {
        const s = scales(container);
        expect(s).toHaveLength(11);
        if (Math.max(...s) - Math.min(...s) > 1e-3) expect(s.indexOf(Math.max(...s))).toBe(5); // the peak never moves sideways (flat at silence)
        for (let i = 0; i < 5; i++) expect(Math.abs(s[i]! - s[10 - i]!)).toBeLessThan(0.12); // symmetric (a small per-bar variation)
      });
    }
    // no CSS transition lags the bars: they are driven per frame
    container.querySelectorAll(".call-wave i").forEach((i) => expect((i as HTMLElement).style.transition).toBe(""));
  });

  it("follows the current level: loud is taller than quiet, then it settles back", () => {
    const { container, rerender } = render(<CallMeter level={5} muted={false} label="m" />);
    tick(400);
    const quiet = scales(container)[5]!;
    rerender(<CallMeter level={90} muted={false} label="m" />);
    tick(200);
    const loud = scales(container)[5]!;
    expect(loud).toBeGreaterThan(quiet * 2);
    rerender(<CallMeter level={5} muted={false} label="m" />);
    tick(1500);
    expect(scales(container)[5]!).toBeCloseTo(quiet, 2);
  });

  it("muted: the bars sit flat", () => {
    const { container } = render(<CallMeter level={90} muted label="m" />);
    tick(400);
    expect(new Set(scales(container).map((v) => v.toFixed(3))).size).toBe(1);
    expect(container.querySelector(".call-wave")!.getAttribute("data-muted")).toBe("true");
  });
});
