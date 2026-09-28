// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, SseEvent, TranscriptEntry } from "@synapse/shared";
import { BotAvatar } from "../../src/renderer/avatar/BotAvatar";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { livingSweepNow, resetLivingBus, setLivingPointer } from "../../src/renderer/avatar/living-bus";
import { applyLivingEvent, LONG_REPLY_CHARS, readingMs, resetLivingEvents } from "../../src/renderer/avatar/living-events";
import { livingReadingUntil } from "../../src/renderer/avatar/living-bus";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";
import { useUi } from "../../src/renderer/store";

// Living Bots (bug 226), wired: touch never steals or fakes a click, the hand-off orb flies only
// between two visible avatars (once per message), the transcript stream drives stuck / remembering /
// reading, and the bus points a waiting Bot at its button and turns every Bot away from a password.

let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => {
  now = 0; queue = [];
  setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} });
  resetLivingBus(); resetLivingEvents();
  useUi.setState({ activeBotId: null, bots: {} });
});
afterEach(() => { cleanup(); setAvatarClock(null); document.querySelectorAll(".living-orb").forEach((e) => e.remove()); vi.restoreAllMocks(); });
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const NOW = Date.now();
const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: NOW, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: NOW, ...over,
});
const rect = (el: Element, left: number, top: number, size = 28) =>
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ left, top, width: size, height: size, right: left + size, bottom: top + size, x: left, y: top, toJSON: () => ({}) } as DOMRect);
const eyesT = (c: Element) => c.querySelector("[data-part=eyes]")!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!.slice(1).map(Number);
const rigX = (c: Element) => Number(c.querySelector("[data-part=rig]")!.getAttribute("transform")!.match(/^translate\(([-\d.]+)/)![1]);

describe("touch: a poke clicks through, a drag never becomes a click", () => {
  function row() {
    const onRow = vi.fn();
    const r = render(
      <a href="#" className="row" onClick={(e) => { e.preventDefault(); onRow(); }}>
        <span className="avatar-wrap"><ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="r" living="r" /></span>
        <span>Courier</span>
      </a>,
    );
    tick(400);
    return { ...r, onRow, svg: r.container.querySelector("svg")! };
  }
  it("under 6 px of movement: a poke, and the row's click still fires once", () => {
    const { svg, onRow } = row();
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 13, clientY: 12 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 13, clientY: 12 });
    fireEvent.click(svg);
    expect(onRow).toHaveBeenCalledTimes(1);
  });
  it("past 6 px it drags: the avatar follows (a little), springs home, and the click that follows is swallowed", () => {
    const { container, svg, onRow } = row();
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 10 });
    tick(300);
    const x = rigX(container);
    expect(x).toBeGreaterThan(3); // moved…
    expect(x).toBeLessThan((36 * 0.35 * 72) / 36 + 0.5); // …on a rubber band, never far
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 10 });
    fireEvent.click(svg);
    expect(onRow).not.toHaveBeenCalled();
    tick(2500);
    expect(Math.abs(rigX(container))).toBeLessThan(0.1); // home
    // …and the NEXT plain click is a click again.
    fireEvent.click(svg);
    expect(onRow).toHaveBeenCalledTimes(1);
  });
  it("the drag's click-swallow only ever eats a click on its own row, and only for ~300 ms", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onOther = vi.fn();
      const { svg, onRow } = row();
      const other = document.createElement("button");
      other.addEventListener("click", onOther);
      document.body.appendChild(other);
      const drag = () => {
        fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 10 });
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 10 });
      };
      drag();
      fireEvent.click(other); // an unrelated click right after a drag is untouched
      expect(onOther).toHaveBeenCalledTimes(1);
      fireEvent.click(svg);   // the row's own click is still swallowed
      expect(onRow).not.toHaveBeenCalled();
      drag();
      act(() => { vi.advanceTimersByTime(350); }); // expired: the next row click is a click
      fireEvent.click(svg);
      expect(onRow).toHaveBeenCalledTimes(1);
      other.remove();
    } finally { vi.useRealTimers(); }
  });
  it("a press can't get stuck: lostpointercapture or a 5 s safety timer ends it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { container, svg } = row();
      fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 10 });
      tick(200);
      expect(rigX(container)).toBeGreaterThan(3);
      fireEvent(window, Object.assign(new Event("lostpointercapture"), { pointerId: 1 }));
      tick(2500);
      expect(Math.abs(rigX(container))).toBeLessThan(0.1); // released and home
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 10 });
      tick(200);
      expect(Math.abs(rigX(container))).toBeLessThan(0.1); // no longer following
      // The safety timer: a press whose pointerup never arrives.
      fireEvent.pointerDown(svg, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 2, clientX: 40, clientY: 10 });
      tick(200);
      expect(rigX(container)).toBeGreaterThan(3);
      act(() => { vi.advanceTimersByTime(5000); });
      tick(2500);
      expect(Math.abs(rigX(container))).toBeLessThan(0.1);
    } finally { vi.useRealTimers(); }
  });
  it("a picker or a caller that turns touch off gets no drag", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="t" living="t" touch={false} />);
    tick(300);
    const svg = container.querySelector("svg")!;
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 10 });
    tick(300);
    expect(Math.abs(rigX(container))).toBeLessThan(0.1);
    fireEvent.pointerUp(window, { pointerId: 1 });
  });
});

describe("hand-offs: the orb", () => {
  const msg = (from: string, to: string, id = "m1"): SseEvent => ({
    channel: "transcript",
    payload: { botId: from, op: "append", entry: { kind: "message", id, role: "assistant", content: "over to you", chainId: "c", createdAt: 1, toAgent: { id: to, name: to, kind: "delegate" } } as unknown as TranscriptEntry },
  } as SseEvent);
  function pair(visibleTo = true) {
    const r = render(<div>
      <ShapeAvatar shape="pebble" color="#3472d9" size={28} seedKey="a" living="a" />
      <ShapeAvatar shape="pebble" color="#f19d38" size={28} seedKey="b" living="b" />
    </div>);
    const [a, b] = [...r.container.querySelectorAll("svg")];
    rect(a!, 10, 100);
    rect(b!, visibleTo ? 10 : -500, visibleTo ? 160 : -500);
    tick(200);
    return r;
  }
  beforeEach(() => {
    // jsdom has no Web Animations: a stand-in that never finishes until the test says so.
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(function () { return { onfinish: null, oncancel: null }; });
  });
  afterEach(() => { delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; });

  it("arcs from the sender to the receiver in the sender's colour, once per message, and the receiver catches it", () => {
    const { container } = pair();
    applyLivingEvent(msg("a", "b"), null);
    const orbs = document.querySelectorAll<HTMLElement>(".living-orb");
    expect(orbs.length).toBe(1);
    expect(orbs[0]!.style.background).toMatch(/#3472d9|rgb\(52, 114, 217\)/);
    expect(orbs[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(orbs[0]!.style.pointerEvents).toBe("none");
    // The receiver's own copy of the same message is the same hand-off.
    applyLivingEvent({ channel: "transcript", payload: { botId: "b", op: "append", entry: { kind: "message", id: "m2", role: "user", content: "over to you", chainId: "c", createdAt: 1, fromAgent: { id: "a", name: "a", kind: "delegate" } } } } as unknown as SseEvent, null);
    expect(document.querySelectorAll(".living-orb").length).toBe(1);
    // Landing: the orb goes and the receiver squashes (the catch).
    const b = container.querySelectorAll("svg")[1]!;
    const before = b.querySelector("[data-part=body]")!.getAttribute("transform");
    const anim = (HTMLElement.prototype as unknown as { animate: ReturnType<typeof vi.fn> }).animate.mock.results[0]!.value as { onfinish: () => void };
    act(() => anim.onfinish());
    expect(document.querySelectorAll(".living-orb").length).toBe(0);
    let moved = false;
    tick(200, () => { moved ||= b.querySelector("[data-part=body]")!.getAttribute("transform") !== before; });
    expect(moved).toBe(true);
  });
  it("nothing flies when the receiver isn't on screen", () => {
    pair(false);
    applyLivingEvent(msg("a", "b"), null);
    expect(document.querySelectorAll(".living-orb").length).toBe(0);
  });
  it("reduced motion: no flight at all", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    try {
      pair();
      applyLivingEvent(msg("a", "b"), null);
      expect(document.querySelectorAll(".living-orb").length).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("the transcript stream drives stuck, remembering and reading", () => {
  it("a failed tool makes the Bot look stuck, then it goes back to its tool's pose", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const b = bot({ running: true, presence: "working", activity: { tool: "Read", detail: "a.ts" } });
      const { container } = render(<BotAvatar bot={b} size={28} />);
      tick(100);
      expect(container.querySelector("svg")!.getAttribute("data-act")).toBe("read");
      act(() => applyLivingEvent({ channel: "transcript", payload: { botId: "a", op: "update", entry: { kind: "tool-call", id: "t", requestId: "r", segmentId: "s", hidden: false, name: "Read", step: "", icon: "file", metric: null, status: "error", startedAt: 1 } } } as SseEvent, null));
      tick(100);
      expect(container.querySelector("svg")!.getAttribute("data-act")).toBe("stuck");
      act(() => { vi.advanceTimersByTime(2600); });
      tick(100);
      expect(container.querySelector("svg")!.getAttribute("data-act")).toBe("read");
    } finally { vi.useRealTimers(); }
  });
  it("the memory tool running plays remembering", () => {
    const { container } = render(<BotAvatar bot={bot()} size={36} />);
    act(() => applyLivingEvent({ channel: "agent-upserted", payload: { agent: bot({ running: true, activity: { tool: "mcp__bot__update_state", detail: "bot" } }) } } as SseEvent, null));
    tick(100);
    expect(container.querySelector("svg")!.getAttribute("data-act")).toBe("remember");
  });
  it("a long reply in the open chat makes the user a reader (every avatar holds still)", () => {
    const reply = (n: number, botId = "a"): SseEvent => ({ channel: "transcript", payload: { botId, op: "append", entry: { kind: "send-message", id: `s${n}`, requestId: "r", createdAt: 1, message: { type: "text", content: "x".repeat(n) } } } } as SseEvent);
    applyLivingEvent(reply(50), "a");
    expect(livingReadingUntil()).toBe(0);
    applyLivingEvent(reply(LONG_REPLY_CHARS, "b"), "a"); // another chat
    expect(livingReadingUntil()).toBe(0);
    applyLivingEvent(reply(2000), "a");
    expect(livingReadingUntil()).toBeGreaterThan(performance.now() + readingMs(2000) - 1000);
    expect(readingMs(100)).toBe(4000);
    expect(readingMs(1e6)).toBe(25_000);
  });
});

describe("gaze from the app", () => {
  it("a Bot waiting on an approval looks at the card's button", () => {
    useUi.setState({ activeBotId: "a" });
    const b = bot({ awaiting: { tabId: "auto-review", reason: "Delete 3 files", since: 1 } });
    const { container } = render(<div>
      <BotAvatar bot={b} size={30} />
      <section className="card pending"><div className="card-actions"><button type="button" className="btn-primary">Allow once</button></div></section>
    </div>);
    rect(container.querySelector("svg")!, 100, 20, 30);
    rect(container.querySelector(".btn-primary")!, 300, 600, 90);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200);
    act(() => livingSweepNow());
    tick(1500);
    const [x, y] = eyesT(container);
    expect(container.querySelector("svg")!.getAttribute("data-act")).toBe("needs-you");
    expect(y).toBeGreaterThan(0.8); // down, toward the button
    expect(x).toBeGreaterThan(0);   // and to the right
  });
  it("every Bot looks politely away while a password field has focus", () => {
    const { container } = render(<div>
      <ShapeAvatar shape="pebble" color="#3472d9" size={30} seedKey="p" living="p" />
      <input type="password" aria-label="Secret" />
    </div>);
    rect(container.querySelector("svg")!, 100, 100, 30);
    rect(container.querySelector("input")!, 400, 100, 30); // to the right
    const input = container.querySelector("input")!;
    act(() => { input.focus(); livingSweepNow(); });
    tick(1500);
    const [x, y] = eyesT(container);
    expect(x).toBeLessThan(-0.8); // away from the field (to the left)
    expect(y).toBeLessThan(0);    // and a little up
  });
  it("follows the pointer only when it is near", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={30} seedKey="q" living="q" />);
    rect(container.querySelector("svg")!, 100, 100, 30);
    setLivingPointer({ x: 1000, y: 115 }); // far away
    act(() => livingSweepNow());
    tick(1200);
    const far = eyesT(container)[0]!;
    setLivingPointer({ x: 200, y: 115 }); // near, to the right
    act(() => livingSweepNow());
    tick(1200);
    expect(eyesT(container)[0]!).toBeGreaterThan(Math.max(far, 0) + 0.8);
  });
});
