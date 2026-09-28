// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { addTicker, avatarNow, loopRunning, setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { createFaceSim, faceBusy, facePointer, faceTwirl, setFaceForm, setFacePresence, stepFace } from "../../src/renderer/avatar/face-sim";
import { formPath } from "../../src/renderer/avatar/face-forms";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";

// Bug #100: idle CPU. Ten visible avatars re-rendered every display frame (120 Hz on ProMotion) cost
// ~48% of a core with nothing happening. The ambient motion (sway, breathing, drift) now ticks at
// <= 30 fps, transitions and the hovered avatar at the display rate, unchanged values are never
// rewritten, and the ambient motion rests while the window is blurred or hidden.

const HZ = 120;
let now = 0;
let queue: (() => void)[] = [];
const useFakeClock = () => { now = 0; queue = []; setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return queue.length; }, caf: () => { queue.length = 0; } }); };
/** Advance `ms` of display frames at `hz`. */
function frames(ms: number, hz = HZ): void {
  for (let t = 0; t < ms; t += 1000 / hz) { now += 1000 / hz; const cb = queue.shift(); if (cb) act(() => cb()); }
}
function blur(): void { act(() => { window.dispatchEvent(new Event("blur")); }); }
function focus(): void { act(() => { window.dispatchEvent(new Event("focus")); }); }
afterEach(() => { focus(); cleanup(); setAvatarClock(null); });

describe("the avatar loop's cadence", () => {
  it("an ambient ticker runs at <= 30 fps on a 120 Hz display; a busy one at the display rate", () => {
    useFakeClock();
    let calm = 0, busy = 0;
    const offA = addTicker(() => { calm++; return false; }, null);
    const offB = addTicker(() => { busy++; return true; }, null);
    frames(1000);
    expect(busy).toBeGreaterThanOrEqual(HZ - 1);
    expect(calm).toBeLessThanOrEqual(31);
    expect(calm).toBeGreaterThanOrEqual(25); // still alive: the ambient motion keeps moving
    offA(); offB();
  });

  it("between ambient frames the loop sleeps on a timer: <= 31 vsync callbacks a second, not 120", () => {
    now = 0; queue = [];
    const timers: { at: number; cb: () => void; id: number }[] = [];
    let nextId = 1, rafs = 0;
    setAvatarClock({
      now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => { queue.length = 0; },
      timeout: (cb, ms) => { const id = nextId++; timers.push({ at: now + ms, cb, id }); return id; },
      clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    });
    let calm = 0;
    const off = addTicker(() => { calm++; return false; }, null);
    for (let t = 0; t < 1000; t += 1000 / HZ) {
      now += 1000 / HZ;
      for (const tm of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(tm), 1); tm.cb(); }
      const cb = queue.shift(); if (cb) { rafs++; act(() => cb()); }
    }
    expect(rafs).toBeLessThanOrEqual(31);
    expect(calm).toBeGreaterThanOrEqual(25);
    off();
  });

  it("a ticker that asks for full rate gets it again the frame it becomes busy (wake)", () => {
    useFakeClock();
    let n = 0, hot = false;
    const reg = addTicker(() => { n++; return hot; }, null);
    frames(500);
    const before = n;
    hot = true; reg.wake();
    frames(250);
    expect(n - before).toBeGreaterThanOrEqual(29); // 250 ms at 120 Hz
    reg();
  });
});

describe("blur and hidden pause the ambient motion", () => {
  it("while blurred, ambient tickers stop and the loop goes quiet; a busy one still runs; focus resumes", () => {
    useFakeClock();
    let calm = 0, busyLeft = 20;
    const offA = addTicker(() => { calm++; return false; }, null);
    const offB = addTicker(() => busyLeft-- > 0, null);
    frames(100);
    blur();
    expect(document.documentElement.classList.contains("motion-paused")).toBe(true);
    const c0 = calm;
    frames(1000);
    expect(calm).toBe(c0);
    expect(busyLeft).toBeLessThan(0); // the busy one finished its transition while blurred
    expect(loopRunning()).toBe(false);
    focus();
    expect(document.documentElement.classList.contains("motion-paused")).toBe(false);
    frames(500);
    expect(calm).toBeGreaterThan(c0);
    offA(); offB();
  });

  it("a presence change while blurred still renders: thinking turns the smile into the hmm", () => {
    useFakeClock();
    const { container, rerender } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="x" />);
    frames(2500);
    blur();
    frames(500);
    rerender(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="x" presence="thinking" />);
    frames(1500);
    expect(container.querySelector("svg")!.dataset.mouth).toBe("hmm");
  });
});

describe("the sim says when it needs the full frame rate", () => {
  const make = () => createFaceSim({ form: "pebble", presence: "idle", seed: 7, sizePx: 36, reducedMotion: false, startMs: 0 });
  it("busy on entry, calm once idle has settled between events", () => {
    const sim = make();
    stepFace(sim, 0);
    expect(faceBusy(sim, 0)).toBe(true);
    let calm = 0, total = 0;
    for (let t = 3000; t < 20000; t += 1000 / 30) { stepFace(sim, t); total++; if (!faceBusy(sim, t)) calm++; }
    expect(calm / total).toBeGreaterThan(0.6);
  });
  it("busy while hovered or twirling, and after a presence change until it has settled", () => {
    const sim = make();
    for (let t = 0; t < 3000; t += 1000 / 60) stepFace(sim, t);
    expect(faceBusy(sim, 3000)).toBe(false);
    facePointer(sim, true, 0, 0, 3000);
    expect(faceBusy(sim, 3000)).toBe(true);
    facePointer(sim, false, 0, 0, 3000);
    for (let t = 3000; t < 5000; t += 1000 / 60) stepFace(sim, t);
    faceTwirl(sim, 5000);
    stepFace(sim, 5020);
    expect(faceBusy(sim, 5020)).toBe(true);
    for (let t = 5020; t < 8000; t += 1000 / 60) stepFace(sim, t);
    setFacePresence(sim, "thinking");
    expect(faceBusy(sim, 8000)).toBe(true);
    for (let t = 8000; t < 11000; t += 1000 / 60) stepFace(sim, t);
    expect(faceBusy(sim, 11000)).toBe(false);
  });
  it("a form change draws the new form's generated path", () => {
    const sim = make();
    for (let t = 0; t < 1000; t += 1000 / 60) stepFace(sim, t);
    setFaceForm(sim, "gem");
    expect(stepFace(sim, 1020).bodyD).toBe(formPath("gem"));
  });
  it("an idle blink is ambient: it does not pull the loop to the display rate", () => {
    const sim = make();
    let blinkFrames = 0, busyBlinkFrames = 0;
    for (let t = 2000; t < 30000; t += 1000 / 30) {
      const f = stepFace(sim, t);
      if (f.eyes[0].h < 6) { blinkFrames++; if (faceBusy(sim, t)) busyBlinkFrames++; }
    }
    expect(blinkFrames).toBeGreaterThan(0);
    expect(busyBlinkFrames).toBe(0);
  });
});

describe("a calm avatar costs almost nothing", () => {
  it("twelve idle avatars write far fewer attributes than one full render per display frame", () => {
    useFakeClock();
    render(<>{Array.from({ length: 12 }, (_, i) => <ShapeAvatar key={i} shape="pebble" color="#3472d9" size={36} seedKey={`b${i}`} />)}</>);
    frames(3000);
    const orig = Element.prototype.setAttribute;
    let writes = 0;
    Element.prototype.setAttribute = function (this: Element, n: string, v: string) { writes++; return orig.call(this, n, v); };
    try { frames(2000); } finally { Element.prototype.setAttribute = orig; }
    // One full render is ~60 attribute writes; per frame at 120 Hz that is ~7200 per avatar-second.
    const perAvatarSecond = writes / 12 / 2;
    expect(perAvatarSecond).toBeLessThan(100); // measured ~19 (bug #100); ~7700 before
  });

  it("an identical frame writes nothing", () => {
    useFakeClock();
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="z" />);
    frames(3000);
    const svg = container.querySelector("svg")!;
    fireEvent.pointerEnter(svg, { clientX: 0, clientY: 0 }); // hovered: full rate
    frames(1500);
    const orig = Element.prototype.setAttribute;
    let writes = 0;
    Element.prototype.setAttribute = function (this: Element, n: string, v: string) { writes++; return orig.call(this, n, v); };
    try { for (let i = 0; i < 5; i++) { const cb = queue.shift(); if (cb) act(() => cb()); } } finally { Element.prototype.setAttribute = orig; } // time frozen
    expect(writes).toBe(0);
  });
});

describe("tests never read the real clock (the flaky-blink seam)", () => {
  it("with no clock installed, an avatar stays on its first frame however much real time passes", async () => {
    setAvatarClock(null);
    const t0 = avatarNow();
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="real" />);
    const first = container.innerHTML;
    await new Promise((r) => setTimeout(r, 120));
    expect(avatarNow()).toBe(t0);
    expect(container.innerHTML).toBe(first);
  });
});
