// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loopInView } from "../../src/renderer/ambient-pause";
import { readSrc } from "./read-src";

// Bug #100: every infinite CSS loop animates only opacity/transform, rests while the window is blurred
// or hidden (html.motion-paused), and rests while scrolled out of view (.loop-offscreen).

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const styles = readdirSync(fileURLToPath(new URL("../../src/renderer/" + "styles/", import.meta.url))).filter((f) => f.endsWith(".css"));
/** [selector, animation name] of every rule that runs an infinite animation, outside media blocks' duplicates. */
function infiniteLoops(): [string, string][] {
  const out: [string, string][] = [];
  for (const f of styles) {
    const css = stripComments(readSrc("styles/" + f)).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const a = m[2]!.match(/animation:\s*([\w-]+)[^;]*\binfinite\b/);
      if (a) for (const sel of m[1]!.split(",")) out.push([sel.trim(), a[1]!]);
    }
  }
  return out;
}
const pauseRule = (() => {
  const css = stripComments(readSrc("styles/app.css"));
  const m = [...css.matchAll(/([^{}]+)\{([^{}]*animation-play-state:\s*paused[^{}]*)\}/g)];
  return m.map((x) => x[1]!.split(",").map((s) => s.trim())).flat();
})();

describe("infinite CSS loops rest when nobody can see them", () => {
  it("there are infinite loops to guard (the scan works)", () => {
    expect(infiniteLoops().length).toBeGreaterThanOrEqual(8);
  });

  it("each loop's keyframes animate only opacity and transform", () => {
    const all = styles.map((f) => stripComments(readSrc("styles/" + f))).join("\n");
    for (const [, name] of infiniteLoops()) {
      const kf = all.match(new RegExp(`@keyframes\\s+${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*)[^{}]*\\}`));
      expect(kf, name).not.toBeNull();
      const props = [...kf![1]!.matchAll(/([\w-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) expect(["opacity", "transform"], `${name}: ${p}`).toContain(p);
    }
  });

  it("each loop is paused under html.motion-paused (blurred or hidden window)", () => {
    for (const [sel] of infiniteLoops()) {
      const base = sel.replace(/\.presence-[\w-]+$/, "");
      const hit = pauseRule.some((p) => p.startsWith(".motion-paused ") && (p.slice(15) === sel || p.slice(15).startsWith(base)));
      expect(hit, sel).toBe(true);
    }
  });

  it("an element marked .loop-offscreen is paused, but a one-shot presence beat still plays", () => {
    expect(pauseRule).toContain(".loop-offscreen:not(.presence-ack):not(.presence-settle)");
  });
});

describe("loopInView marks an element off screen while it does not intersect", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("toggles .loop-offscreen from IntersectionObserver entries and cleans up", () => {
    let cb: ((e: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
    const observed = new Set<Element>();
    vi.stubGlobal("IntersectionObserver", class { constructor(f: typeof cb) { cb = f; } observe(el: Element) { observed.add(el); } unobserve(el: Element) { observed.delete(el); } disconnect() {} });
    const { container, unmount } = render(<span ref={loopInView} className="marker working" />);
    const el = container.querySelector(".marker")!;
    expect(observed.has(el)).toBe(true);
    act(() => cb!([{ target: el, isIntersecting: false }]));
    expect(el.classList.contains("loop-offscreen")).toBe(true);
    act(() => cb!([{ target: el, isIntersecting: true }]));
    expect(el.classList.contains("loop-offscreen")).toBe(false);
    unmount();
    expect(observed.has(el)).toBe(false);
  });
});
