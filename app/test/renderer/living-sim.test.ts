import { describe, expect, it } from "vitest";
import {
  createFaceSim, faceBusy, faceCatch, faceDrag, faceNod, facePoke, facePointer, faceRelease, setFaceAct, setFaceLead, setFaceLook, setFaceQuiet,
  stepFace, SUPPORT_AMP, TAP_EVERY_MS, type FaceFrame, type FaceSim,
} from "../../src/renderer/avatar/face-sim";
import type { LivingAct } from "../../src/renderer/avatar/living-pose";

// Living Bots (bug 226) in the pure face sim: every work pose reads as a pose, its loops respect the
// one-lead rule and the user reading, touch squashes and springs home, and reduced motion swaps each
// state for a still pose and gaze (no hops, springs or orbits).

const FRAME = 1000 / 60;
const make = (o: { rm?: boolean; size?: number } = {}) => createFaceSim({ form: "pebble", presence: "idle", seed: 3, sizePx: o.size ?? 48, reducedMotion: o.rm ?? false, startMs: 0 });
function run(s: FaceSim, from: number, to: number, each: (f: FaceFrame, t: number) => void = () => {}): FaceFrame {
  let f = stepFace(s, from);
  for (let t = from + FRAME; t <= to; t += FRAME) { f = stepFace(s, t); each(f, t); }
  return f;
}
function inAct(act: LivingAct, o: { rm?: boolean; size?: number; lead?: boolean; quiet?: boolean } = {}) {
  const s = make(o);
  run(s, 0, 600);
  if (o.lead === false) setFaceLead(s, false);
  if (o.quiet) setFaceQuiet(s, true);
  setFaceAct(s, act, 600);
  return s;
}
const eyeH = (f: FaceFrame) => f.eyes[0].h;
const range = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

describe("work poses", () => {
  it("reading scans line by line: the gaze sweeps left to right and drops a row each pass", () => {
    const s = inAct("read");
    const gx: number[] = [], gy: number[] = [];
    run(s, 600, 600 + 3300, (f) => { gx.push(f.debug.gaze[0]); gy.push(f.debug.gaze[1]); });
    expect(range(gx)).toBeGreaterThan(3);
    expect(Math.max(...gy.slice(-40))).toBeGreaterThan(Math.max(...gy.slice(40, 80)) + 0.3); // a lower row later
  });
  it("writing looks down with a type bounce; running narrows the eyes and hums; browsing turns aside", () => {
    const w = inAct("write"); const qs: number[] = [];
    const fw = run(w, 600, 2600, (f) => qs.push(f.debug.squash));
    expect(fw.debug.gaze[1]).toBeGreaterThan(2);
    expect(range(qs.slice(-60))).toBeGreaterThan(0.01);
    const r = inAct("run"); const ys: number[] = [];
    const fr = run(r, 600, 2600, (f) => ys.push(f.debug.yaw));
    expect(fr.debug.lid).toBeLessThan(0.9);
    expect(range(ys.slice(-60))).toBeGreaterThan(0.01);
    const b = inAct("browse");
    expect(run(b, 600, 2600).debug.yaw).toBeGreaterThan(0.25);
  });
  it("thinking looks up and aside; stuck droops and shakes (no colour change); resting shuts its eyes", () => {
    const t = inAct("think");
    const ft = run(t, 600, 2600);
    expect(ft.debug.gaze[1]).toBeLessThan(-2);
    const st = inAct("stuck"); const tilts: number[] = [];
    const fs = run(st, 600, 2600, (f, time) => { if (time < 1500) tilts.push(f.debug.tilt); });
    expect(fs.debug.pitch).toBeGreaterThan(0.1);
    expect(Math.min(...tilts)).toBeLessThan(-1); // the shake goes both ways
    expect(Math.max(...tilts)).toBeGreaterThan(3);
    const rest = inAct("rest");
    const fr = run(rest, 600, 2600);
    expect(eyeH(fr)).toBeLessThan(2); // shut to a line
  });
  it("resting wakes on hover", () => {
    const s = inAct("rest");
    run(s, 600, 2600);
    facePointer(s, true, 0, 0, 2600);
    const f = run(s, 2600, 3400);
    expect(f.debug.act).toBe("idle");
    expect(eyeH(f)).toBeGreaterThan(8);
  });
  it("needs-you faces out and taps its foot every 1.4 s — the lead only", () => {
    const s = inAct("needs-you");
    const hops: number[] = [];
    run(s, 600, 600 + TAP_EVERY_MS * 3 + 100, (f, t) => { if (f.debug.hop < -0.1 && (hops.length === 0 || t - hops[hops.length - 1]! > 500)) hops.push(t); });
    expect(hops.length).toBe(3);
    expect(hops[1]! - hops[0]!).toBeCloseTo(TAP_EVERY_MS, -2);
    const quietOne = inAct("needs-you", { lead: false });
    let hopped = false;
    run(quietOne, 600, 600 + TAP_EVERY_MS * 3, (f) => { hopped ||= f.debug.hop < -0.1; });
    expect(hopped).toBe(false);
  });
  it("remembering: the dots circle, settle into a row and fade (and only at >= 30 px)", () => {
    const s = inAct("remember", { size: 64 });
    const early = run(s, 600, 900);
    expect(early.dots).not.toBe("");
    expect(early.dotsOp).toBe(1);
    const late = run(s, 900, 600 + 2500);
    expect(late.dots).toBe("");
    const small = inAct("remember", { size: 22 });
    expect(run(small, 600, 900).dots).toBe("");
  });
  it("a non-lead plays its loops small", () => {
    const lead = inAct("read"), side = inAct("read", { lead: false });
    const a: number[] = [], b: number[] = [];
    run(lead, 600, 3000, (f) => a.push(f.debug.gaze[0]));
    run(side, 600, 3000, (f) => b.push(f.debug.gaze[0]));
    expect(range(b)).toBeLessThan(range(a));
    expect(SUPPORT_AMP).toBeLessThan(1);
  });
  it("while the user reads, the pose holds still: no scan, no breathing, no drift", () => {
    const s = inAct("read", { quiet: true });
    const gx: number[] = [], sil: string[] = [];
    run(s, 600, 5000, (f, t) => { if (t > 3000) { gx.push(f.debug.gaze[0]); sil.push(f.sil); } });
    expect(range(gx)).toBeLessThan(0.05);
    expect(new Set(sil).size).toBe(1);
  });
  it("a pose's loops are ambient (not busy) once it has settled", () => {
    const s = inAct("run");
    run(s, 600, 3000);
    expect(faceBusy(s, 3000)).toBe(false);
  });
});

describe("outside gaze", () => {
  it("follows a look target; the pointer's own hover wins; a reading Bot keeps its eyes on its work", () => {
    const s = make(); run(s, 0, 600);
    setFaceLook(s, { nx: 1, ny: 0.5 });
    expect(run(s, 600, 1800).debug.gaze[0]).toBeGreaterThan(2.5);
    facePointer(s, true, -1, 0, 1800);
    expect(run(s, 1800, 3000).debug.gaze[0]).toBeLessThan(-2.5);
    const r = inAct("read"); setFaceLook(r, { nx: 1, ny: -1 });
    const ys: number[] = []; run(r, 600, 2600, (f) => ys.push(f.debug.gaze[1]));
    expect(Math.min(...ys.slice(-30))).toBeGreaterThan(1); // still looking down at the page
  });
});

describe("touch", () => {
  it("a poke squashes and squints, then settles", () => {
    const s = make(); run(s, 0, 1200);
    facePoke(s, 1200);
    let minLid = 1, maxQ = 0;
    run(s, 1200, 1500, (f) => { minLid = Math.min(minLid, f.debug.lid); maxQ = Math.max(maxQ, Math.abs(f.debug.squash)); });
    expect(minLid).toBeLessThan(0.3);
    expect(maxQ).toBeGreaterThan(0.03);
    const f = run(s, 1500, 3500);
    expect(f.debug.lid).toBeCloseTo(1, 2);
  });
  it("a drag follows, and on release springs home past the rest point (a wobble)", () => {
    const s = make(); run(s, 0, 1000);
    faceDrag(s, 8, -4);
    expect(faceBusy(s, 1000)).toBe(true);
    const held = run(s, 1000, 1400);
    expect(held.debug.x).toBeCloseTo(8, 0);
    faceRelease(s, 1400);
    let minX = Infinity;
    const back = run(s, 1400, 3400, (f) => { minX = Math.min(minX, f.debug.x); });
    expect(minX).toBeLessThan(-0.5); // overshoot: jelly, not a snap
    expect(Math.abs(back.debug.x)).toBeLessThan(0.05);
  });
  it("the hand-off catch squashes; the call's nod dips the head", () => {
    const s = make(); run(s, 0, 1000);
    faceCatch(s, 1000);
    let q = 0; run(s, 1000, 1300, (f) => { q = Math.max(q, Math.abs(f.debug.squash)); });
    expect(q).toBeGreaterThan(0.03);
    const n = make(); run(n, 0, 1000);
    const p0 = stepFace(n, 1000).debug.pitch;
    faceNod(n);
    let p = p0; run(n, 1000, 1300, (f) => { p = Math.max(p, f.debug.pitch); });
    expect(p - p0).toBeGreaterThan(0.04);
  });
});

describe("reduced motion: still poses, no hops, springs or orbits", () => {
  it("each state swaps in place: the gaze and eyelids say it, the head and body hold still", () => {
    for (const act of ["read", "write", "browse", "run", "needs-you", "stuck", "rest", "think"] as LivingAct[]) {
      const s = inAct(act, { rm: true });
      const frames: FaceFrame[] = [];
      run(s, 600, 600 + TAP_EVERY_MS * 2 + 50, (f) => frames.push(f));
      const last = frames[frames.length - 1]!;
      expect(new Set(frames.map((f) => f.rig)).size, act).toBe(1);
      expect(new Set(frames.map((f) => f.body)).size, act).toBe(1);
      expect(new Set(frames.map((f) => `${f.debug.gaze}`)).size, act).toBe(1);
      expect(frames.every((f) => f.debug.hop === 0), act).toBe(true);
      expect(last.dots, act).toBe("");
    }
    expect(stepFace(inAct("browse", { rm: true }), 700).debug.gaze[0]).toBeGreaterThan(3); // aside, by the eyes
    expect(eyeH(stepFace(inAct("rest", { rm: true }), 700))).toBeLessThan(2);
  });
  it("touch never moves it: no drag, no squash (a brief opacity dip instead)", () => {
    const s = make({ rm: true }); run(s, 0, 600);
    facePoke(s, 600);
    faceDrag(s, 10, 10);
    const fs: FaceFrame[] = [];
    run(s, 600, 900, (f) => fs.push(f));
    expect(new Set(fs.map((f) => f.rig)).size).toBe(1);
    expect(Math.min(...fs.map((f) => f.opacity))).toBeLessThan(1);
  });
});
