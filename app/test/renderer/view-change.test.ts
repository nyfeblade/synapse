// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withViewChange } from "../../src/renderer/view-transition";

// Motion glitch fix (decisions.md, "motion glitches"; bug log). A View Transition put an overlay over
// the whole window for its 680ms, and Chromium hit-tests that overlay to <html> even with
// `pointer-events: none`: every click during a Bot switch was swallowed (the motion check's
// "redirect" glitch). The Bot morph riding it left the header blank for ~650ms. A view change is
// now the new main pane ARRIVING (Web Animations on `.main`, compositor-only), with no overlay.

let reduce = false;
let calls: { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; anim: { cancel: ReturnType<typeof vi.fn> } }[] = [];
const svt = vi.fn();

beforeEach(() => {
  reduce = false; calls = [];
  document.body.innerHTML = `<main class="main">A</main>`;
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce") ? reduce : false })) as unknown as typeof window.matchMedia;
  (document as unknown as { startViewTransition: unknown }).startViewTransition = svt;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const anim = { cancel: vi.fn(), addEventListener: vi.fn(), playState: "running" };
    calls.push({ el: this, frames, opts, anim });
    return anim;
  };
  svt.mockClear();
});
afterEach(() => { delete (document as unknown as { startViewTransition?: unknown }).startViewTransition; document.body.innerHTML = ""; });

describe("a view change", () => {
  it("never starts a View Transition, so no overlay can swallow the next click", () => {
    withViewChange(() => { document.querySelector(".main")!.textContent = "B"; });
    expect(svt).not.toHaveBeenCalled();
    expect(document.querySelector(".main")!.textContent).toBe("B"); // applied synchronously
  });

  it("animates only transform and opacity on the main pane, and never from fully blank", () => {
    withViewChange(() => {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.el.className).toBe("main");
    for (const f of calls[0]!.frames) for (const k of Object.keys(f)) expect(["opacity", "transform", "offset", "easing"]).toContain(k);
    expect(Number(calls[0]!.frames[0]!.opacity)).toBeGreaterThan(0.2);
  });

  it("a second change mid-flight cancels the first instead of stacking two entrances", () => {
    withViewChange(() => {});
    withViewChange(() => {});
    expect(calls).toHaveLength(2);
    expect(calls[0]!.anim.cancel).toHaveBeenCalled();
  });

  it("reduced motion: the update lands with no animation at all", () => {
    reduce = true;
    let ran = false;
    withViewChange(() => { ran = true; });
    expect(ran).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("no element is ever given a view-transition-name (no shared-element morph to go blank)", () => {
    withViewChange(() => {});
    for (const el of document.querySelectorAll<HTMLElement>("*")) expect(el.style.viewTransitionName).toBe("");
  });
});
