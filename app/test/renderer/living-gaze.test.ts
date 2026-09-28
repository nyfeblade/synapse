import { describe, expect, it } from "vitest";
import { DRAG_SLOP_PX, dragOffset, gazeAt, handoffPair, isDrag, isSecretField, lookAway, noticeRadius, orbBow, orbPoint, pointerNear, seatGlance } from "../../src/renderer/avatar/living-gaze";
import { chooseLook } from "../../src/renderer/avatar/living-bus";

// Living Bots (bug 226): the geometry of gaze, touch, the call's glances and the hand-off orb.

const box = { left: 100, top: 100, width: 30, height: 30 }; // centre (115, 115)

describe("gaze math", () => {
  it("looks toward the point: proportional nearby, full reach (a direction) further away", () => {
    const near = gazeAt(box, 115 + 15, 115);
    expect(near.nx).toBeCloseTo(0.5, 5);
    expect(near.ny).toBeCloseTo(0, 5);
    const far = gazeAt(box, 115, 115 + 600); // a button far below
    expect(far.nx).toBeCloseTo(0, 5);
    expect(far.ny).toBeCloseTo(1, 5);
    const diag = gazeAt(box, 115 - 300, 115 - 300);
    expect(Math.hypot(diag.nx, diag.ny)).toBeCloseTo(1, 5);
    expect(diag.nx).toBeLessThan(0);
    expect(diag.ny).toBeLessThan(0);
  });
  it("never leaves -1..1, and a point on the centre is straight ahead", () => {
    expect(gazeAt(box, 115, 115)).toEqual({ nx: 0, ny: 0 });
    for (const [x, y] of [[-1e6, 0], [1e6, 1e6], [115, -1e9]]) {
      const g = gazeAt(box, x!, y!);
      expect(Math.abs(g.nx)).toBeLessThanOrEqual(1);
      expect(Math.abs(g.ny)).toBeLessThanOrEqual(1);
    }
  });
  it("only notices a pointer within its radius", () => {
    expect(noticeRadius(28)).toBe(140);
    expect(noticeRadius(120)).toBe(480);
    expect(pointerNear(box, 115, 115)).toBe(true);
    expect(pointerNear(box, 130 + 139, 115)).toBe(true);
    expect(pointerNear(box, 130 + 141, 115)).toBe(false);
  });
  it("looks politely away from a secret field (the other side, a little up)", () => {
    expect(lookAway({ nx: 0.8, ny: 0.5 })).toEqual({ nx: -0.9, ny: -0.55 });
    expect(lookAway({ nx: -0.8, ny: 0.5 })).toEqual({ nx: 0.9, ny: -0.55 });
    expect(isSecretField({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(isSecretField({ tagName: "INPUT", type: "text", autocomplete: "one-time-code" })).toBe(true);
    expect(isSecretField({ tagName: "TEXTAREA", dataset: { secret: "" } })).toBe(true);
    expect(isSecretField({ tagName: "TEXTAREA", type: "textarea" })).toBe(false);
    expect(isSecretField(null)).toBe(false);
  });
  it("the bus's priority: a secret field, then the pointer nearby, then typing (open Bot), then the waiting button, then the caller's look", () => {
    const base = { nx: 0.2, ny: 0 };
    const ctx = { pointer: null, secret: null, composer: null, typing: false, isActive: true, waiting: false, button: null, base };
    expect(chooseLook(box, ctx)).toBe(base);
    const btn = { left: 400, top: 700, width: 80, height: 30 };
    expect(chooseLook(box, { ...ctx, waiting: true, button: btn })!.ny).toBeGreaterThan(0.8);
    expect(chooseLook(box, { ...ctx, waiting: true, button: btn, isActive: false })).toBe(base); // another chat's card
    const composer = { left: 300, top: 800, width: 600, height: 40 };
    expect(chooseLook(box, { ...ctx, typing: true, composer })!.ny).toBeGreaterThan(0.5);
    expect(chooseLook(box, { ...ctx, typing: true, composer, isActive: false })).toBe(base);
    const secret = { left: 500, top: 100, width: 200, height: 30 }; // to the right
    expect(chooseLook(box, { ...ctx, typing: true, composer, secret })).toEqual({ nx: -0.9, ny: -0.55 });
    expect(chooseLook(box, { ...ctx, pointer: { x: 90, y: 115 } })!.nx).toBeLessThan(0); // the pointer nearby, to the left
    // …but a focused password wins even over a pointer right on the avatar: it always looks away.
    expect(chooseLook(box, { ...ctx, secret, pointer: { x: 115, y: 115 } })).toEqual({ nx: -0.9, ny: -0.55 });
  });
});

describe("the call screen: listeners glance at the speaker's seat", () => {
  const order = ["l", "m", "r"];
  it("sideways toward the speaker, stronger for a far seat; nothing for the speaker itself", () => {
    expect(seatGlance(order, "r", "l")!.nx).toBeCloseTo(0.85, 5);
    expect(seatGlance(order, "r", "m")!.nx).toBeCloseTo(0.7, 5);
    expect(seatGlance(order, "l", "m")!.nx).toBeCloseTo(-0.7, 5);
    expect(seatGlance(order, "m", "m")).toBeNull();
    expect(seatGlance(order, null, "m")).toBeNull();
    expect(seatGlance(order, "x", "m")).toBeNull();
  });
});

describe("touch threshold", () => {
  it("about 6 px of movement before a press is a drag", () => {
    expect(DRAG_SLOP_PX).toBe(6);
    expect(isDrag(3, 3)).toBe(false);
    expect(isDrag(4, 4)).toBe(false);
    expect(isDrag(6, 0)).toBe(true);
    expect(isDrag(-5, 4)).toBe(true);
  });
  it("the drag follows, then gives like a rubber band: never past ~0.35 of the avatar's size", () => {
    const small = dragOffset(2, 0, 28);
    expect(small.x).toBeCloseTo(2, 0);
    const big = dragOffset(500, 0, 28);
    expect(big.x).toBeLessThanOrEqual(28 * 0.35 + 1e-9);
    expect(big.x).toBeGreaterThan(9);
    const diag = dragOffset(-300, 300, 64);
    expect(Math.hypot(diag.x, diag.y)).toBeLessThanOrEqual(64 * 0.35 + 1e-9);
    expect(dragOffset(0, 0, 36)).toEqual({ x: 0, y: 0 });
  });
});

describe("hand-off geometry", () => {
  const at = (left: number, top: number) => ({ box: { left, top, width: 28, height: 28 } });
  it("picks the closest visible pair (the call row's, not the sidebar's)", () => {
    const from = [at(10, 100), at(600, 300)];   // sidebar, call screen
    const to = [at(10, 140), at(700, 300)];
    expect(handoffPair(from, to)).toEqual([from[0], to[0]]);
    const toCall = [at(700, 300)];
    expect(handoffPair([from[1]!], toCall)).toEqual([from[1], toCall[0]]);
    expect(handoffPair([], to)).toBeNull();
    expect(handoffPair(from, [])).toBeNull();
  });
  it("the orb's arc starts and ends on the avatars and lifts in the middle", () => {
    expect(orbPoint(0, 100, 200, 100, 0, 50)).toEqual({ x: 0, y: 100 });
    const end = orbPoint(0, 100, 200, 100, 1, 50);
    expect(end.x).toBeCloseTo(200, 6);
    expect(end.y).toBeCloseTo(100, 6);
    const mid = orbPoint(0, 100, 200, 100, 0.5, 50);
    expect(mid.x).toBeCloseTo(100, 6);
    expect(mid.y).toBeCloseTo(50, 6);
  });
  it("a row-to-row hop (mostly vertical) bows sideways into the list, so the lift can't cancel the travel", () => {
    expect(orbBow(38, 140, 38, 315)).toEqual({ nx: 1, ny: 0 });
    expect(orbBow(0, 100, 200, 120)).toEqual({ nx: 0, ny: -1 });
    const mid = orbPoint(38, 140, 38, 315, 0.5, 60, orbBow(38, 140, 38, 315));
    expect(mid.x).toBeCloseTo(98, 6);
    expect(mid.y).toBeCloseTo(227.5, 6);
  });
});
