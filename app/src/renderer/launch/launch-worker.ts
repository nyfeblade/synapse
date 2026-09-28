/**
 * Draws the launch snap off the main thread (LaunchOverlay.tsx hands it the canvas). The app's own
 * start-up work runs on the main thread in the same second, and a busy main thread skipped frames;
 * here nothing competes, so the snap stays smooth. Time is read against the shared epoch the main
 * thread sent, the same one the click sound is scheduled on, so picture and sound stay together.
 */
import { createLaunchSim, drawLaunch, restFrame, type LaunchView } from "./launch-snap";

export interface StartMessage { type: "start"; canvas: OffscreenCanvas; view: LaunchView; dpr: number; startEpoch: number; dur: number; reduced: boolean }
export type WorkerReply = { type: "first-frame" } | { type: "done" };

const epochNow = () => performance.timeOrigin + performance.now();
let stopped = false;

self.onmessage = (e: MessageEvent<StartMessage | { type: "stop" }>) => {
  if (e.data.type === "stop") { stopped = true; return; }
  const m = e.data;
  const ctx = m.canvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  if (!ctx) { reply({ type: "done" }); return; }
  const sim = createLaunchSim();
  let first = true;
  const frame = () => {
    if (stopped) return;
    const t = Math.max(0, epochNow() - m.startEpoch);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    if (m.reduced) drawLaunch(ctx, restFrame(1 - Math.min(1, t / m.dur)), m.view);
    else { while (sim.t < t && !sim.done) sim.step(Math.min(50, t - sim.t + 0.01)); drawLaunch(ctx, sim.frame(), m.view); }
    if (first) { first = false; reply({ type: "first-frame" }); }
    if (t >= m.dur || (!m.reduced && sim.done)) { reply({ type: "done" }); return; }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
