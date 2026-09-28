// @vitest-environment jsdom
// launch-animation: the snap plays once per app launch, over an app that is already usable, and
// gets out of the way at once: pointer events pass through it, and any click or key ends it.
import fs from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchOverlay } from "../../src/renderer/launch/LaunchOverlay";
import { launchPrefs, setLaunchPref } from "../../src/renderer/launch/prefs";
import { LAUNCH_MS, REDUCED_MS } from "../../src/renderer/launch/launch-snap";

const overlay = () => document.querySelector<HTMLCanvasElement>("canvas.launch-snap");
let reduced = false;
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); reduced = false;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce") && reduced, media: q, addEventListener() {}, removeEventListener() {} })) as never;
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("launch overlay", () => {
  it("plays on the first mount of a launch, never blocks the pointer, and not again in the same launch", () => {
    const first = render(<LaunchOverlay />);
    expect(overlay()).not.toBeNull();
    expect(getComputedStyle(overlay()!).pointerEvents === "none" || overlay()!.style.pointerEvents === "none").toBe(true);
    first.unmount();
    render(<LaunchOverlay />);
    expect(overlay()).toBeNull();
  });

  it("removes itself once the snap is over", () => {
    render(<LaunchOverlay />);
    act(() => { vi.advanceTimersByTime(LAUNCH_MS + 400); });
    expect(overlay()).toBeNull();
  });

  it("ends at once on a key press or a click", () => {
    render(<LaunchOverlay />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    expect(overlay()).toBeNull();
    sessionStorage.clear(); cleanup();
    render(<LaunchOverlay />);
    act(() => { window.dispatchEvent(new Event("pointerdown")); });
    expect(overlay()).toBeNull();
  });

  it("is a short fade with Reduce Motion on", () => {
    reduced = true;
    render(<LaunchOverlay />);
    act(() => { vi.advanceTimersByTime(REDUCED_MS + 250); }); // + the worker's 60 ms warm-up
    expect(overlay()).toBeNull();
  });

  it("stays off when the setting is off, and the sound setting is remembered", () => {
    expect(launchPrefs()).toEqual({ animation: true, sound: true });
    setLaunchPref("animation", false); setLaunchPref("sound", false);
    expect(launchPrefs()).toEqual({ animation: false, sound: false });
    render(<LaunchOverlay />);
    expect(overlay()).toBeNull();
  });

  it("the window is covered from its first paint, and uncovered at once when the snap won't play", () => {
    const html = fs.readFileSync(path.join(__dirname, "../../src/renderer/index.html"), "utf8");
    expect(html).toMatch(/id="launch-cover"/);
    // The backstop is its own plain script (it runs even if the bundle fails), loaded right after the
    // cover, and its 2 s count starts at the first frame, not at page load.
    expect(html).toMatch(/id="launch-cover"[^>]*><\/div>\s*<script src="\.\/launch-cover\.js"><\/script>/);
    const backstop = fs.readFileSync(path.join(__dirname, "../../src/renderer/public/launch-cover.js"), "utf8");
    expect(backstop).toMatch(/requestAnimationFrame\(function \(\) \{\s*setTimeout\(/);
    document.body.insertAdjacentHTML("beforeend", '<div id="launch-cover"></div>');
    setLaunchPref("animation", false);
    render(<LaunchOverlay />);
    expect(document.getElementById("launch-cover")).toBeNull();
  });

  it("draws on a worker when it can, so the app starting up can't make it stutter", () => {
    document.body.insertAdjacentHTML("beforeend", '<div id="launch-cover"></div>');
    const posted: { msg: { type: string; startEpoch: number }; transfer: unknown[] }[] = [];
    let worker: { onmessage: ((e: { data: unknown }) => void) | null; terminate: () => void } | null = null;
    class FakeWorker { onmessage: ((e: { data: unknown }) => void) | null = null; onerror = null; constructor() { worker = this; } postMessage(msg: never, transfer: unknown[]) { posted.push({ msg, transfer }); } terminate() {} }
    vi.stubGlobal("Worker", FakeWorker);
    (HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen: () => object }).transferControlToOffscreen = () => ({ width: 0, height: 0 });
    try {
      render(<LaunchOverlay />);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.msg.type).toBe("start");
      expect(posted[0]!.transfer).toHaveLength(1);
      expect(document.getElementById("launch-cover")).not.toBeNull();
      act(() => { worker!.onmessage!({ data: { type: "first-frame" } }); });
      expect(document.getElementById("launch-cover")).toBeNull();
      expect(overlay()).not.toBeNull();
      act(() => { worker!.onmessage!({ data: { type: "done" } }); });
      expect(overlay()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      delete (HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: unknown }).transferControlToOffscreen;
    }
  });
});
