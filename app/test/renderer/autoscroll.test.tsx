// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, TranscriptEntry } from "@synapse/shared";
import { Transcript } from "../../src/renderer/components/Transcript";
import { usePendingSends } from "../../src/renderer/pending-sends";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Auto-scroll, the way the best chat apps do it (decisions.md, "liquid motion").
//
// jsdom has no layout, so geometry is modelled: every `.msg` is MSG_H tall and the viewport is
// VIEW_H, so scrollHeight really grows as messages arrive — which is exactly the case the old
// post-commit "am I near the bottom?" check got wrong (a tall message arriving while the user sat at
// the bottom measured as "far from the bottom" and the transcript stopped following).

const MSG_H = 200;
const VIEW_H = 300;

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});
const userMsg = (id: string, at: number): TranscriptEntry => ({ kind: "message", id, role: "user", content: `m-${id}`, createdAt: at }) as TranscriptEntry;

let behaviors: (ScrollBehavior | undefined)[] = [];
let reduce = false;
let roCallbacks: (() => void)[] = [];
let extra = 0; // height added by something that is not a message (an image loading, a card expanding)

function model(el: HTMLElement) {
  let top = 0;
  const height = () => el.querySelectorAll(".msg").length * MSG_H + extra;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, height() - VIEW_H)); },
  });
  return {
    toBottom: () => { top = Math.max(0, height() - VIEW_H); },
    scrollTo: (v: number) => { top = v; fireEvent.scroll(el); },
    gap: () => height() - top - VIEW_H,
  };
}

beforeEach(() => {
  behaviors = []; reduce = false; roCallbacks = []; extra = 0;
  window.matchMedia = vi.fn((q: string) => ({
    matches: q.includes("prefers-reduced-motion") ? reduce : false,
    media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // scrollIntoView on the sentinel lands at the bottom, like the real thing.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    behaviors.push(typeof arg === "object" ? arg.behavior : undefined);
    const box = this.closest(".transcript") as HTMLElement | null;
    if (box) box.scrollTop = box.scrollHeight;
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe() { roCallbacks.push(() => this.cb()); }
    unobserve() {}
    disconnect() {}
  };
  useUi.setState({
    ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" },
    bots: { a: bot() }, transcripts: { a: [userMsg("u1", 1), userMsg("u2", 2), userMsg("u3", 3)] },
  });
  usePendingSends.setState({ byBot: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver; });

// "Ultra liquid": a glide is JS-driven on the glide spring (scroll-glide.ts), frame by frame, so it is
// driven here on fake frames. `glide()` fakes the clock; `settle()` runs the spring to its end.
const glide = () => vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
const settle = () => act(() => { vi.advanceTimersByTime(1000); });

const add = (id: string, at: number) =>
  act(() => { useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [...s.transcripts.a!, userMsg(id, at)] } })); });
const mount = () => {
  const { container } = render(<Transcript botId="a" />);
  const el = container.querySelector(".transcript") as HTMLElement;
  const m = model(el);
  m.toBottom();
  return { el, m };
};
const pill = () => screen.queryByRole("button", { name: /new messages/i });

describe("auto-scroll: stick to the bottom", () => {
  it("follows a new message that is taller than the near-bottom threshold", () => {
    glide();
    const { m } = mount();
    behaviors = [];
    add("u4", 4); // +200px: after the commit the user is 200px from the bottom, but they WERE at it
    expect(m.gap(), "it glides down on the spring rather than teleporting").toBe(200);
    expect(behaviors, "no instant jump either").toEqual([]);
    settle();
    expect(m.gap()).toBe(0);
    expect(pill()).toBeNull();
  });

  it("counts a user within ~80px of the bottom as at the bottom", () => {
    const { m } = mount();
    glide();
    m.scrollTo(3 * MSG_H - VIEW_H - 60);
    expect(m.gap()).toBe(60);
    behaviors = [];
    add("u4", 4);
    settle();
    expect(m.gap()).toBe(0);
  });

  it("keeps sticking when content grows without a new message (images, cards, tool steps)", () => {
    const { m } = mount();
    extra = 180;
    act(() => { for (const cb of roCallbacks) cb(); });
    expect(m.gap(), "a ResizeObserver growth while at the bottom must keep the bottom in view").toBe(0);
  });
});

describe("auto-scroll: never yank a reader", () => {
  it("does not follow when the user has scrolled up (> 80px)", () => {
    const { m } = mount();
    m.scrollTo(100); // 900 - 300 - 100 = 500px above the bottom
    behaviors = [];
    add("u4", 4);
    expect(behaviors).toEqual([]);
    expect(m.gap()).toBeGreaterThan(80);
  });

  it("treats 100px above the bottom as reading, not following", () => {
    const { m } = mount();
    m.scrollTo(3 * MSG_H - VIEW_H - 100);
    behaviors = [];
    add("u4", 4);
    expect(behaviors).toEqual([]);
  });

  it("does not follow a ResizeObserver growth while scrolled up", () => {
    const { m } = mount();
    m.scrollTo(50);
    extra = 180;
    act(() => { for (const cb of roCallbacks) cb(); });
    expect(m.gap()).toBeGreaterThan(80);
  });
});

describe("auto-scroll: the new-messages pill", () => {
  it("is absent while following, appears when something arrives below a reader, and glides down on click", () => {
    glide();
    const { m } = mount();
    expect(pill()).toBeNull();
    m.scrollTo(0);
    add("u4", 4);
    const p = pill();
    expect(p, "a reader must be told something arrived below").not.toBeNull();
    behaviors = [];
    fireEvent.click(p!);
    expect(behaviors, "the landing rides the glide spring, not the browser's smooth scroll").toEqual([]);
    expect(pill()).toBeNull();
    act(() => { vi.advanceTimersByTime(160); });
    expect(m.gap(), "mid-glide: moving, not yet landed").toBeGreaterThan(0);
    expect(m.gap()).toBeLessThan(4 * MSG_H - VIEW_H);
    settle();
    expect(m.gap()).toBe(0);
  });

  it("the reader's own scroll input takes over from the glide at once", () => {
    glide();
    const { m, el } = mount();
    m.scrollTo(0);
    add("u4", 4);
    fireEvent.click(pill()!);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.wheel(el);
    const at = m.gap();
    settle();
    expect(m.gap(), "the glide stopped where the user took over").toBe(at);
    expect(at).toBeGreaterThan(0);
  });

  it("jumps instead of gliding under prefers-reduced-motion", () => {
    reduce = true;
    const { m } = mount();
    m.scrollTo(0);
    add("u4", 4);
    behaviors = [];
    fireEvent.click(pill()!);
    expect(behaviors).toEqual(["auto"]);
  });

  it("goes away on its own once the reader scrolls back to the bottom", () => {
    const { m, el } = mount();
    m.scrollTo(0);
    add("u4", 4);
    expect(pill()).not.toBeNull();
    m.scrollTo(el.scrollHeight - VIEW_H);
    expect(pill()).toBeNull();
  });

  it("lives outside the scroller, so it does not scroll away with the history", () => {
    const { m, el } = mount();
    m.scrollTo(0);
    add("u4", 4);
    expect(el.contains(pill())).toBe(false);
  });
});

// Regression: motion check "send", send-jump/scroll-back (fix, this file's Transcript.tsx). A user's
// own optimistic send sits at the very tail of `items` until it reconciles (pending-sends.ts), so a
// reply landing for an EARLIER message while it is still pending is an insertion ahead of on-screen
// content, not a plain append — the still-pending row must glide to its new place, not jump. And a
// second send fired before the first's glide has caught up must not be mistaken for "the reader
// scrolled away": `wasNear` used to read only the raw, momentarily-stale scroll gap.
describe("auto-scroll: growth ahead of a still-pending send", () => {
  it("FLIPs the still-pending row instead of jumping it when a reply lands ahead of it", () => {
    const { el, m } = mount();
    // Real layout for FLIP: every `.msg` row sits at its CURRENT index in the DOM, MSG_H apart, so an
    // insertion ahead of a row really does shift it — unlike flip-perf.test.ts's fixed-index rows,
    // this bug is entirely about a row's index changing under it.
    const restoreRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains("msg")) return new DOMRect(0, 0, 280, MSG_H);
      return new DOMRect(0, [...el.querySelectorAll(".msg")].indexOf(this) * MSG_H, 280, MSG_H);
    };
    const animated = new Set<Element>();
    const restoreAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (this: HTMLElement) {
      animated.add(this);
      return { cancel: () => {}, onfinish: null, addEventListener() {}, removeEventListener() {} } as unknown as Animation;
    };
    try {
      // The user's own second send: optimistic, unreconciled — buildTranscriptItems renders it LAST
      // no matter what lands for an earlier message in the meantime.
      act(() => { usePendingSends.getState().add({ nonce: "n1", botId: "a", text: "second quick", attachments: [], createdAt: 10 }); });
      m.toBottom(); // the send's own glide has landed
      const pendingRow = el.querySelector("#entry-pending-n1");
      expect(pendingRow, "the optimistic row is on screen").not.toBeNull();
      animated.clear();
      // A reply for an earlier message lands: a real entry appended to `entries`, ahead of the still-
      // pending row in the combined list.
      act(() => {
        useUi.setState((s) => ({ transcripts: { ...s.transcripts, a: [...s.transcripts.a!,
          { kind: "send-message", id: "r1", requestId: "rq1", createdAt: 11, message: { type: "text", content: "On it." } } as unknown as TranscriptEntry] } }));
      });
      expect(animated.has(pendingRow!), "the pending row must glide to its new place, not jump").toBe(true);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = restoreRect;
      HTMLElement.prototype.animate = restoreAnimate;
    }
  });

  it("keeps following through a second send fired before the first glide lands", () => {
    glide();
    const { m } = mount();
    add("u4", 4); // +200px: starts a glide toward the new bottom
    act(() => { vi.advanceTimersByTime(80); }); // mid-glide: scrollTop has not caught up yet
    add("u5", 5); // another message lands while the raw gap is still well past NEAR_BOTTOM_PX
    expect(pill(), "a glide already under way must still count as following").toBeNull();
    settle();
    expect(m.gap()).toBe(0);
  });
});
