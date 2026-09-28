// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glideScroll, isGliding } from "../../src/renderer/scroll-glide";
import { MOTION, SPRINGS, springAt } from "../../src/renderer/motion";

// "Ultra liquid" scroll (decisions.md): auto-scroll and the new-messages pill land on the GLIDE spring,
// JS-driven, instead of the browser's fixed smooth-scroll curve; a user's own scroll input takes over
// instantly; and a re-glide mid-flight keeps its momentum. Driven on a fake clock and fake frames.

let reduce = false;
let height = 2000;
function scroller(): HTMLElement {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
  document.body.appendChild(el);
  return el;
}
const bottom = (el: HTMLElement) => () => el.scrollHeight - el.clientHeight;
const frames = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  reduce = false; height = 2000;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce") ? reduce : false })) as unknown as typeof window.matchMedia;
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("glideScroll", () => {
  it("follows the glide spring from where it is to the target and lands exactly", () => {
    const el = scroller();
    el.scrollTop = 600;
    glideScroll(el, bottom(el));
    expect(el.scrollTop, "nothing moves until the first frame").toBe(600);
    frames(160);
    const expected = 1600 + springAt(SPRINGS.glide, 0.16, 600 - 1600, 0);
    expect(Math.abs(el.scrollTop - expected)).toBeLessThan(40); // within one frame of the spring
    expect(el.scrollTop).toBeGreaterThan(600);
    expect(el.scrollTop).toBeLessThan(1600);
    expect(isGliding(el)).toBe(true);
    frames(MOTION.glide.duration);
    expect(el.scrollTop).toBe(1600);
    expect(isGliding(el)).toBe(false);
  });

  it("tracks a target that grows mid-glide (a streamed reply, an image decoding)", () => {
    const el = scroller();
    glideScroll(el, bottom(el));
    frames(100);
    height = 2600;
    frames(MOTION.glide.duration);
    expect(el.scrollTop).toBe(2200);
  });

  it("a user's own scroll input takes over at once", () => {
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      const el = scroller();
      glideScroll(el, bottom(el));
      frames(100);
      const at = el.scrollTop;
      el.dispatchEvent(new Event(type));
      expect(isGliding(el), type).toBe(false);
      frames(400);
      expect(el.scrollTop, `${type} cancels the glide`).toBe(at);
    }
  });

  it("re-gliding mid-flight keeps the momentum it had instead of restarting from rest", () => {
    const a = scroller();
    glideScroll(a, bottom(a));
    frames(120);
    const before = a.scrollTop;
    glideScroll(a, bottom(a)); // e.g. a second message arriving
    frames(16);
    const carried = a.scrollTop - before;
    const b = scroller(); // same place, from rest
    b.scrollTop = before;
    glideScroll(b, bottom(b));
    frames(16);
    const fromRest = b.scrollTop - before;
    expect(carried, "still moving at speed").toBeGreaterThan(fromRest + 5);
  });

  it("a re-glide for content that GREW mid-glide continues from where the scroller is, never teleports", () => {
    // Motion check "scroll-jump" (bug log): the target is a live function, so the old momentum formula
    // `carried.x + (prev.target() - to)` read the new bottom twice, cancelled to 0, and every message
    // arriving while the last glide was still settling jumped the transcript straight to the end.
    const el = scroller();
    el.scrollTop = 1000;
    glideScroll(el, bottom(el));
    frames(600); // nearly settled at 1600, still gliding
    const at = el.scrollTop;
    height = 2400; // a new message: the bottom is now 2000
    glideScroll(el, bottom(el));
    frames(16);
    expect(el.scrollTop - at, "one frame of a glide, not the whole 400px").toBeLessThan(80);
    frames(1000);
    expect(el.scrollTop).toBe(2000);
  });

  it("under reduced motion it lands instantly", () => {
    reduce = true;
    const el = scroller();
    glideScroll(el, bottom(el));
    expect(el.scrollTop).toBe(1600);
    expect(isGliding(el)).toBe(false);
  });
});
