// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flipFrom, measure, play, velocityOf } from "../../src/renderer/flip";
import { MOTION, SPRINGS, SQUASH_MAX, STAGGER_CAP, STAGGER_MS, STRETCH_MAX, springAt, stretchFor } from "../../src/renderer/motion";

// "Ultra liquid" guards for renderer/flip.ts (decisions.md, "ultra liquid"): momentum on interruption,
// capped list cascades, stretch along travel, reduced motion, and no residual fill. jsdom has no
// compositor, so the browser's side is modelled: each fake element reports its layout box PLUS the
// offset its running animation would be rendering at the fake clock's time, which is exactly what a
// real getBoundingClientRect returns mid-flight.

type Fake = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; el: number };
let now = 0;
let reduce = false;
const anims: Fake[] = [];

/** Rendered offset (px) of a fake animation at `now`: its sampled keyframes interpolated in time. */
function renderedY(a: Fake): number {
  const t = now - (Number(a.options.delay) || 0);
  const dur = Number(a.options.duration);
  const ys = a.keyframes.map((k) => ty(k.transform as string));
  if (t <= 0) return ys[0]!;
  if (t >= dur) return 0;
  if (a.keyframes.length === 2) { // the token easing: the from-rest spring
    return springAt(SPRINGS.glide, t / 1000, ys[0]!, 0);
  }
  const f = (t / dur) * (ys.length - 1);
  const i = Math.floor(f);
  return ys[i]! + (ys[i + 1]! - ys[i]!) * (f - i);
}
const ty = (tr: string) => (tr === "none" ? 0 : Number(tr.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\)/)?.[2] ?? NaN));
const tx = (tr: string) => (tr === "none" ? 0 : Number(tr.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\)/)?.[1] ?? NaN));
const sc = (tr: string) => { const m = tr.match(/scale\(([-\d.e]+), ([-\d.e]+)\)/); return m ? [Number(m[1]), Number(m[2])] : [1, 1]; };

function rows(n: number, h = 40): HTMLElement[] {
  document.body.innerHTML = "";
  return Array.from({ length: n }, (_, i) => {
    const el = document.createElement("div");
    let top = i * h;
    let live: Fake | null = null;
    el.getBoundingClientRect = () => new DOMRect(0, top + (live && !live.cancel.mock.calls.length ? renderedY(live) : 0), 200, h);
    (el as unknown as { move: (y: number) => void }).move = (y) => { top = y; };
    el.animate = ((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const a: Fake = { keyframes, options, cancel: vi.fn(), el: i };
      anims.push(a);
      live = a;
      return Object.assign(a, { onfinish: null, addEventListener: () => {} }) as unknown as Animation;
    }) as HTMLElement["animate"];
    document.body.appendChild(el);
    return el;
  });
}
const move = (el: HTMLElement, y: number) => (el as unknown as { move: (y: number) => void }).move(y);
beforeEach(() => {
  now = 0; reduce = false; anims.length = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce") ? reduce : false })) as unknown as typeof window.matchMedia;
});
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("momentum on interruption", () => {
  it("an interrupted move starts from the RENDERED offset and carries the velocity it had", () => {
    const [el] = rows(1);
    flipFrom(el!, new DOMRect(0, 300, 200, 40)); // was at 300, now laid out at 0: glides up
    now = 120; // mid-flight
    const expectedV = (springAt(SPRINGS.glide, 0.121, 300, 0) - springAt(SPRINGS.glide, 0.119, 300, 0)) / 0.002;
    expect(velocityOf(anims[0] as unknown as Animation).y).toBeCloseTo(expectedV, -1);
    const rendered = springAt(SPRINGS.glide, 0.12, 300, 0);
    const snap = measure([el!]);
    move(el!, 600); // redirected: the new layout box is far below
    play(snap);
    const second = anims[1]!;
    expect(anims[0]!.cancel).toHaveBeenCalled();
    expect(ty(second.keyframes[0]!.transform as string), "starts where it was on screen").toBeCloseTo(rendered - 600, 0);
    // The spring is linear, so the new motion = (released from rest at that offset) + (released at the
    // carried velocity from zero offset). The second term is the momentum; it must be exactly there.
    expect(expectedV).toBeLessThan(-500);
    const D = ty(second.keyframes[0]!.transform as string);
    const h = MOTION.glide.duration / (second.keyframes.length - 1) / 1000;
    const fromRest = springAt(SPRINGS.glide, h, D, 0);
    const momentum = ty(second.keyframes[1]!.transform as string) - fromRest;
    expect(momentum, "it keeps travelling up for a moment: the old velocity carried over").toBeCloseTo(springAt(SPRINGS.glide, h, 0, expectedV), 0);
    expect(momentum).toBeLessThan(-5);
    expect(second.keyframes.at(-1)!.transform, "and still ends exactly at rest").toBe("none");
  });

  it("a move that was NOT interrupted starts from rest on the plain token", () => {
    const [el] = rows(1);
    flipFrom(el!, new DOMRect(0, 300, 200, 40));
    expect(anims[0]!.keyframes).toHaveLength(2);
    expect(anims[0]!.options.easing).toBe(MOTION.glide.easing);
  });

  it("carries nothing from a move that already settled, or one still waiting out its stagger", () => {
    const [el] = rows(1);
    const a = flipFrom(el!, new DOMRect(0, 300, 200, 40))!;
    now = MOTION.glide.duration + 5;
    expect(velocityOf(a)).toEqual({ x: 0, y: 0 });
    const els = rows(6);
    const snap = measure(els);
    els.forEach((e, i) => move(e, (5 - i) * 40));
    now = 0;
    play(snap, { stagger: true });
    const last = anims.at(-1)! as unknown as Animation;
    expect(velocityOf(last), "inside its delay it has not started moving").toEqual({ x: 0, y: 0 });
  });
});

describe("list cascades are capped", () => {
  it("rows trail by --stagger and the trail stops growing after the cap", () => {
    const els = rows(30);
    const snap = measure(els);
    els.forEach((e, i) => move(e, (29 - i) * 40));
    play(snap, { stagger: true });
    const delays = anims.map((a) => Number(a.options.delay ?? 0));
    expect(delays.slice(0, 6)).toEqual([0, 40, 80, 120, 160, 160]);
    expect(Math.max(...delays)).toBe(STAGGER_CAP * STAGGER_MS);
    expect(STAGGER_CAP * STAGGER_MS, "a long list never drags").toBeLessThanOrEqual(200);
  });
});

describe("stretch along travel", () => {
  it("stretchFor is bounded: at most 6% along the motion and 3% across, 1:1 at rest", () => {
    expect(stretchFor(0, 0)).toEqual({ sx: 1, sy: 1 });
    const fast = stretchFor(0, 1e6);
    expect(fast.sy).toBeCloseTo(1 + STRETCH_MAX, 6);
    expect(fast.sx).toBeCloseTo(1 - SQUASH_MAX, 6);
    const side = stretchFor(-1e6, 0);
    expect(side.sx).toBeCloseTo(1 + STRETCH_MAX, 6);
    expect(side.sy).toBeCloseTo(1 - SQUASH_MAX, 6);
    expect(STRETCH_MAX).toBeLessThanOrEqual(0.06);
    expect(SQUASH_MAX).toBeLessThanOrEqual(0.03);
  });

  it("a moving indicator stretches along its path mid-flight and relaxes on arrival", () => {
    const [el] = rows(1);
    flipFrom(el!, new DOMRect(0, 400, 200, 40), { stretch: true });
    const kf = anims[0]!.keyframes.map((k) => sc(k.transform as string));
    const maxAlong = Math.max(...kf.map(([, y]) => y!));
    const minAcross = Math.min(...kf.map(([x]) => x!));
    expect(maxAlong, "it visibly stretches").toBeGreaterThan(1.02);
    expect(maxAlong).toBeLessThanOrEqual(1 + STRETCH_MAX + 1e-9);
    expect(minAcross).toBeGreaterThanOrEqual(1 - SQUASH_MAX - 1e-9);
    expect(anims[0]!.keyframes[0]!.transform, "starts unstretched (from rest)").toMatch(/scale\(1, 1\)/);
    expect(anims[0]!.keyframes.at(-1)!.transform).toBe("none");
    for (const k of anims[0]!.keyframes) for (const p of Object.keys(k)) expect(["transform", "transformOrigin", "offset"]).toContain(p);
  });

  it("the stretch is about the box's centre, so the box does not drift sideways", () => {
    const [el] = rows(1);
    flipFrom(el!, new DOMRect(0, 400, 200, 40), { stretch: true });
    for (const k of anims[0]!.keyframes.slice(0, -1)) {
      const [sx] = sc(k.transform as string);
      expect(tx(k.transform as string) + (200 * sx!) / 2).toBeCloseTo(100, 1); // within 0.05px
    }
  });
});

describe("reduced motion and residue", () => {
  it("under reduced motion nothing moves, however it was asked", () => {
    reduce = true;
    const els = rows(5);
    const snap = measure(els);
    els.forEach((e, i) => move(e, (4 - i) * 40));
    play(snap, { stagger: true });
    flipFrom(els[0]!, new DOMRect(0, 400, 200, 40), { stretch: true, velocity: { x: 0, y: 900 } });
    expect(anims).toHaveLength(0);
  });

  it("no FLIP animation holds its end state (no residual transform, no stacking context)", () => {
    const els = rows(8);
    const snap = measure(els);
    els.forEach((e, i) => move(e, (7 - i) * 40));
    play(snap, { stagger: true });
    now = 50;
    play(measure(els.map((e, i) => (move(e, i * 40), e))), { stagger: true });
    flipFrom(els[0]!, new DOMRect(0, 400, 200, 40), { stretch: true });
    for (const a of anims) expect(a.options.fill ?? "none").toMatch(/^(none|backwards)$/);
  });
});

describe("frame budget with the cascade and momentum code", () => {
  it("an INTERRUPTED 200-row pass (momentum keyframes for every row) still fits a 120Hz frame", () => {
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      now = 0;
      const els = rows(200);
      const s1 = measure(els);
      els.forEach((e, i) => move(e, (199 - i) * 40));
      play(s1, { stagger: true });
      now = 90;
      const s2 = measure(els);
      els.forEach((e, i) => move(e, i * 40));
      const t0 = process.hrtime.bigint(); // the real clock: performance.now is the fake one here
      play(s2, { stagger: true });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    expect(times[0]!, `fastest ${times[0]!.toFixed(2)}ms`).toBeLessThan(8.3);
  });
});
