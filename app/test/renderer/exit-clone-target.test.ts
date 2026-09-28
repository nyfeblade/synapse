// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleExitRemoval } from "../../src/renderer/exit-clone";

// The clone's own fade is the only animationend that means "done". A child's animation ending (an
// avatar blink, a spinner, anything still looping inside the snapshot) bubbles up to the clone too,
// and must not tear the clone out of the page mid-fade.
describe("scheduleExitRemoval", () => {
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  it("ignores an animationend that bubbled from a child, and finishes on the clone's own", () => {
    vi.useFakeTimers();
    const clone = document.createElement("div");
    const child = document.createElement("span");
    clone.appendChild(child);
    document.body.appendChild(clone);
    scheduleExitRemoval(clone, 160);
    child.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(clone.isConnected).toBe(true);
    clone.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(clone.isConnected).toBe(false);
  });

  it("still falls back to the timeout when no animationend comes", () => {
    vi.useFakeTimers();
    const clone = document.createElement("div");
    document.body.appendChild(clone);
    scheduleExitRemoval(clone, 160);
    vi.advanceTimersByTime(161);
    expect(clone.isConnected).toBe(false);
  });
});
