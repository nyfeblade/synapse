import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../motion";
import { createLaunchSim, drawLaunch, LAUNCH_MS, REDUCED_MS, restFrame, snapClicks, type LaunchView } from "./launch-snap";
import type { StartMessage, WorkerReply } from "./launch-worker";
import { claimLaunch, launchPrefs } from "./prefs";
import { openSnapAudio, scheduleSnapClicks } from "./snap-sound";
import { launchMark } from "./trace";

/**
 * The launch snap, over the app (launch-snap.ts). It never delays the app: pointer events pass
 * straight through it, and any click or key ends it at once. Once per launch; off in Settings →
 * General → Appearance.
 *
 * Smoothness: index.html covers the window from its first paint, so the app never flashes in first;
 * the cover is lifted on the snap's first drawn frame. The snap is drawn on a worker (launch-worker.ts)
 * so the app's own start-up work can't make it skip frames, and falls back to this thread where
 * workers or offscreen canvases aren't available.
 */
const epochNow = () => performance.timeOrigin + performance.now();
/** The worker needs a moment to start; the snap's clock starts this far ahead so it opens on frame one. */
const LEAD_MS = 60;
function liftCover() { const c = document.getElementById("launch-cover"); if (c) { c.remove(); launchMark("cover lifted"); } }

function Snap() {
  const [on, setOn] = useState(claimLaunch);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    launchMark(on ? "snap start" : "snap skipped");
    if (!on) { liftCover(); return; }
    const reduced = prefersReducedMotion();
    const dur = reduced ? REDUCED_MS : LAUNCH_MS;
    let raf = 0, ended = false, silence: (() => void) | null = null, worker: Worker | null = null;
    // Open audio now, not at the snap: a context made at the moment of contact starts late.
    const audio = launchPrefs().sound && !reduced ? openSnapAudio() : null;
    const end = () => {
      if (ended) return;
      ended = true;
      silence?.();
      cancelAnimationFrame(raf); clearTimeout(safety);
      try { worker?.postMessage({ type: "stop" }); worker?.terminate(); } catch { /* already gone */ }
      removeEventListener("keydown", end, true); removeEventListener("pointerdown", end, true);
      liftCover();
      launchMark("snap end");
      setOn(false);
    };
    // However frames are scheduled (a hidden window gets none), the overlay is gone just after the snap.
    let safety = setTimeout(end, LEAD_MS + dur + 150);
    addEventListener("keydown", end, true); addEventListener("pointerdown", end, true);

    const el = canvas.current;
    if (!el) return end;
    const dpr = window.devicePixelRatio || 1, W = window.innerWidth, Hh = window.innerHeight;
    const css = getComputedStyle(document.documentElement);
    const background = css.getPropertyValue("--bg").trim() || "#0C0C0C";
    const light = /^#(f|e)/i.test(background) || background === "white";
    const view: LaunchView = {
      width: W, height: Hh, background, body: css.getPropertyValue("--bot-white").trim() || "#FFFFFF",
      ink: "#111110", edge: light ? "rgba(0,0,0,0.14)" : null, accent: "#ED712E",
    };

    // One clock for picture and sound: an absolute epoch both threads can read.
    const startEpoch = epochNow() + LEAD_MS;
    const scheduleSound = () => {
      if (!audio || ended || silence) return;
      silence = scheduleSnapClicks(audio, epochNow() - startEpoch, snapClicks());
    };
    if (audio) { if (audio.state === "running") scheduleSound(); else void audio.resume().then(scheduleSound, () => {}); }

    const canWorker = typeof Worker !== "undefined" && typeof (el as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === "function";
    if (canWorker) {
      try {
        const off = el.transferControlToOffscreen();
        off.width = Math.round(W * dpr); off.height = Math.round(Hh * dpr);
        worker = new Worker(new URL("./launch-worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<WorkerReply>) => { launchMark(`worker ${e.data.type}`); if (e.data.type === "first-frame") liftCover(); else end(); };
        worker.onerror = () => end();
        const msg: StartMessage = { type: "start", canvas: off, view, dpr, startEpoch, dur, reduced };
        worker.postMessage(msg, [off]);
        return end;
      } catch { return end; } // a canvas already handed over can't be drawn here any more
    }

    // Fallback: draw on this thread.
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = el.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return end;
    el.width = Math.round(W * dpr); el.height = Math.round(Hh * dpr);
    const sim = createLaunchSim(), c = ctx;
    let first = true;
    const frame = () => {
      if (ended) return;
      const t = Math.max(0, epochNow() - startEpoch);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced) drawLaunch(c, restFrame(1 - Math.min(1, t / dur)), view);
      else { while (sim.t < t && !sim.done) sim.step(Math.min(50, t - sim.t + 0.01)); drawLaunch(c, sim.frame(), view); }
      if (first) { first = false; liftCover(); }
      if (t >= dur || (!reduced && sim.done)) end(); else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return end;
  }, [on]);

  return on ? <canvas ref={canvas} className="launch-snap" aria-hidden="true" style={{ pointerEvents: "none" }} /> : null;
}

/** The snap is decoration: if it ever throws, it quietly draws nothing rather than taking the app down. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { liftCover(); return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function LaunchOverlay() {
  return <Quiet><Snap /></Quiet>;
}
