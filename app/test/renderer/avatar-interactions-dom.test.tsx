// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { BotAvatar } from "../../src/renderer/avatar/BotAvatar";
import { currentActionLabel } from "../../src/renderer/avatar/current-action";
import { avatarInteractions, setAvatarClock, setAvatarInteractions } from "../../src/renderer/avatar/avatar-loop";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";
import { EYE_INK } from "../../src/renderer/avatar/face-sim";

// The designed interactions, wired: the DOM half of avatar-interactions.test.ts. The fake clock
// drives the one shared loop; every assertion reads what the loop actually wrote into the SVG.

let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => {
  now = 0; queue = [];
  setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} });
});
afterEach(() => { cleanup(); setAvatarClock(null); setAvatarInteractions(true); });
/** Advance `ms` of 60 Hz frames, calling `each` after every frame. */
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += 1000 / 60) { now += 1000 / 60; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const headY = (c: HTMLElement) => Number(c.querySelector("[data-part=rig]")!.getAttribute("transform")!.match(/^translate\([-\d.]+ ([-\d.]+)\)/)![1]);
/** The face (eyes and mouth) is round the back of the head during a turn. */
const eyesHidden = (c: HTMLElement) => c.querySelector("[data-part=face]")!.getAttribute("visibility") === "hidden";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

describe("click on the avatar: a twirl that never steals the row's click", () => {
  it("inside a clickable row, the row's click still fires once and the twirl also plays", () => {
    const onRow = vi.fn();
    const { container } = render(
      <a href="#" className="row" onClick={(e) => { e.preventDefault(); onRow(); }}>
        <span className="avatar-wrap"><ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="r" /></span>
        <span>Courier</span>
      </a>,
    );
    tick(400);
    let hid = false;
    tick(200, () => { hid ||= eyesHidden(container); });
    expect(hid).toBe(false); // at rest, no eye is ever round the back
    fireEvent.click(container.querySelector("svg")!);
    expect(onRow).toHaveBeenCalledTimes(1);
    tick(1200, () => { hid ||= eyesHidden(container); });
    expect(hid).toBe(true); // the turn wrap carried an eye round the far side
  });

  it("every body colour keeps solid black, painted eyes through the whole twirl", () => {
    for (const color of ["#ffffff", "#3472d9"]) {
      const { container, unmount } = render(<ShapeAvatar shape="puff" color={color} size={36} seedKey="w" />);
      tick(300);
      fireEvent.click(container.querySelector("svg")!);
      let hid = false;
      tick(1500, () => {
        hid ||= eyesHidden(container);
        expect(container.querySelector("mask")).toBeNull();
        const eyes = container.querySelectorAll("rect.avatar-eye");
        expect(eyes).toHaveLength(2);
        eyes.forEach((e) => expect(e.getAttribute("fill")).toBe(EYE_INK));
      });
      expect(hid, color).toBe(true);
      unmount();
    }
  });
});

describe("hover on the avatar", () => {
  it("hops the head up and lets it back down", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="h" />);
    tick(500);
    const rest = headY(container);
    fireEvent.pointerEnter(container.querySelector("svg")!, { clientX: 18, clientY: 18 });
    let top = rest;
    tick(250, () => { top = Math.min(top, headY(container)); });
    expect(top).toBeLessThan(rest - 1); // > 0.5 px at 36 px (a viewBox unit is 0.5 px)
    tick(1200);
    expect(Math.abs(headY(container) - rest)).toBeLessThan(0.5); // back on the idle sway
  });

  it("the one switch turns every interaction off", () => {
    setAvatarInteractions(false);
    expect(avatarInteractions()).toBe(false);
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} seedKey="h" />);
    tick(500);
    const rest = headY(container);
    fireEvent.pointerEnter(container.querySelector("svg")!);
    fireEvent.click(container.querySelector("svg")!);
    let low = rest, hid = false;
    tick(1200, () => { low = Math.min(low, headY(container)); hid ||= eyesHidden(container); });
    expect(rest - low).toBeLessThan(0.5);
    expect(hid).toBe(false);
  });

  it("wears no control affordance: still aria-hidden, not focusable, no pointer cursor, no hover rule", () => {
    const { container } = render(<ShapeAvatar shape="pebble" color="#3472d9" size={36} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.getAttribute("tabindex")).toBeNull();
    expect(svg.style.cursor).toBe("");
    const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/\.(face-avatar|avatar-head|avatar-body|avatar-eye|avatar-mouth|avatar-spark)[^{,]*:(hover|active|focus)/);
  });
});

describe("bug #55: hovering a Bot's avatar shows its current action (design essay)", () => {
  it("names the current tool step from what the host exposes: presence + activity.detail", () => {
    expect(currentActionLabel(bot({ running: true, presence: "working", activity: { tool: "Read", detail: "notes.md" } }))).toBe("Working · notes.md");
    expect(currentActionLabel(bot({ running: true, presence: "searching", activity: { tool: "WebSearch", detail: "flights to Lisbon" } }))).toBe("Searching · flights to Lisbon");
    expect(currentActionLabel(bot({ running: true, presence: "thinking", activity: { thinking: true } }))).toBe("Thinking");
    expect(currentActionLabel(bot({ running: true, presence: "working", activity: null }))).toBe("Working");
    expect(currentActionLabel(bot({ running: true, presence: "orbit", activity: { tool: "mcp__bot__Task", detail: "" } }))).toBe("Running a task");
  });

  it("a Bot waiting on the user says what it is waiting for; an idle Bot has no action and no tooltip", () => {
    expect(currentActionLabel(bot({ awaiting: { tabId: "auto-review", reason: "Waiting for your approval", since: 1 } }))).toBe("Waiting for your approval");
    expect(currentActionLabel(bot())).toBeNull();
  });

  it("the avatar carries it as its native tooltip, and it follows the Bot live", () => {
    const { container, rerender } = render(<BotAvatar bot={bot({ running: true, presence: "working", activity: { tool: "Edit", detail: "plan.md" } })} size={36} />);
    const title = () => container.querySelector("svg > title")?.textContent ?? null;
    expect(title()).toBe("Working · plan.md");
    rerender(<BotAvatar bot={bot({ running: true, presence: "searching", activity: { tool: "WebFetch", detail: "example.com" } })} size={36} />);
    expect(title()).toBe("Searching · example.com");
    rerender(<BotAvatar bot={bot()} size={36} />);
    expect(title()).toBeNull();
  });
});
