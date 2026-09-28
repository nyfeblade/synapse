// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANIM_SPRINGS, type AvatarClip, type BotSummary, type Presence } from "@synapse/shared";
import { BotAvatar } from "../../src/renderer/avatar/BotAvatar";
import { setAvatarClock } from "../../src/renderer/avatar/avatar-loop";
import { createFaceSim, faceBusy, facePlayClip, faceTwirl, setFaceClips, setFacePresence, stepFace, type FaceFrame, type FaceSim } from "../../src/renderer/avatar/face-sim";
import { SPRINGS } from "../../src/renderer/motion";

// Bot-authored avatar animations (docs/differentiators.md), played by the Synapse face through the
// sim's pose seam. Every claim is made against a twin with no clips, so what differs is the clip.
// (Per-eye-state mapping: face-sim.test.ts.)

const FRAME = 1000 / 60;
const hop: AvatarClip = { name: "hop", on: "task_done", duration_ms: 900, keys: [{ at: 0.4, y: -20, tilt: 20, eyes: "closed", ease: "linear" }] };
const clickClip: AvatarClip = { ...hop, name: "poke", on: "click" };
const manual: AvatarClip = { ...hop, name: "wave", on: "manual" };

function make(o: { presence?: Presence; rm?: boolean; clips?: AvatarClip[] } = {}): FaceSim {
  const s = createFaceSim({ form: "pebble", presence: o.presence ?? "idle", seed: 5, sizePx: 96, reducedMotion: o.rm ?? false, startMs: 0 });
  if (o.clips) setFaceClips(s, o.clips);
  return s;
}
function run(s: FaceSim, from: number, until: number, act: (t: number) => void = () => {}): { t: number; f: FaceFrame }[] {
  const out: { t: number; f: FaceFrame }[] = [];
  for (let t = from; t <= until; t += FRAME) { act(t); out.push({ t, f: stepFace(s, t) }); }
  return out;
}
const at = (xs: { t: number; f: FaceFrame }[], t: number) => xs.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b)).f;

describe("the sim plays a clip as a pose", () => {
  it("a manual clip moves the body up and tilts it mid-clip, closes the eyes, then returns exactly to the twin's track", () => {
    const a = make({ clips: [manual] }), b = make();
    const on = run(a, 0, 2400, (t) => { if (Math.abs(t - 600) < FRAME / 2) facePlayClip(a, manual, t); });
    const off = run(b, 0, 2400);
    const mid = 600 + 0.4 * 900;
    expect(at(on, mid).debug.y - at(off, mid).debug.y).toBeLessThan(-12); // 20% of the 72-unit frame = 14.4 up
    expect(at(on, mid).debug.tilt - at(off, mid).debug.tilt).toBeGreaterThan(15);
    expect(at(on, 600 + 0.6 * 900).eyes[0].h).toBeLessThan(3); // eyes shut from their key on
    expect(at(on, mid).debug.clip).toBe("wave");
    const end = on[on.length - 1]!.f, endOff = off[off.length - 1]!.f;
    expect(end.debug.y).toBeCloseTo(endOff.debug.y, 1);
    expect(end.debug.clip).toBeNull();
  });

  it("task_done replaces the built-in finish celebration", () => {
    const c = make({ presence: "working", clips: [hop] });
    let saw = false, turned = false;
    run(c, 0, 1400, (t) => { if (Math.abs(t - 500) < FRAME / 2) setFacePresence(c, "idle"); })
      .forEach(({ t, f }) => { if (t > 520 && t < 1300) { saw ||= f.debug.clip === "hop"; turned ||= f.debug.turn !== 0; } });
    expect(saw).toBe(true);
    expect(turned).toBe(false);
    const after = run(c, 1600, 1700).map((x) => x.f.debug.clip);
    expect(after.every((p) => p === null)).toBe(true);
  });

  it("a click clip replaces the twirl", () => {
    const a = make({ clips: [clickClip] });
    run(a, 0, 400);
    faceTwirl(a, 400);
    const f = stepFace(a, 420);
    expect(f.debug.clip).toBe("poke");
    expect(run(a, 420, 1200).every((x) => x.f.face)).toBe(true); // no twirl
  });

  it("keeps the loop at full rate while a clip plays, and lets it rest after", () => {
    const a = make({ clips: [manual] });
    run(a, 0, 1500);
    expect(faceBusy(a, 1500)).toBe(false);
    facePlayClip(a, manual, 1500);
    stepFace(a, 1600);
    expect(faceBusy(a, 1600)).toBe(true);
    run(a, 1600, 3200);
    expect(faceBusy(a, 3200)).toBe(false);
  });

  it("reduced motion never plays a clip (the opacity dip instead)", () => {
    const a = make({ rm: true, clips: [manual] });
    run(a, 0, 300);
    facePlayClip(a, manual, 300);
    const xs = run(a, 300, 900);
    expect(xs.every((x) => x.f.debug.clip === null)).toBe(true);
    expect(Math.min(...xs.map((x) => x.f.opacity))).toBeLessThan(0.9);
  });

  it("the DSL's springs are the app's water springs", () => {
    expect(ANIM_SPRINGS).toEqual(SPRINGS);
  });
});

// ---------- wired: BotAvatar plays the profile's clips ----------
let now = 0;
let queue: (() => void)[] = [];
beforeEach(() => { now = 0; queue = []; setAvatarClock({ now: () => now, raf: (cb) => { queue.push(cb); return 1; }, caf: () => {} }); });
afterEach(() => { cleanup(); setAvatarClock(null); });
function tick(ms: number, each: () => void = () => {}): void {
  for (let t = 0; t < ms; t += FRAME) { now += FRAME; const cb = queue.shift(); if (cb) act(() => cb()); each(); }
}
const bot = (profile: Partial<BotSummary["profile"]> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape", ...profile },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0,
});
const clipAttr = (c: HTMLElement) => c.querySelector("svg")!.getAttribute("data-clip");

describe("BotAvatar plays the Bot's own clips", () => {
  it("plays a cue once when its seq rises, never the cue it mounted with", () => {
    const { container, rerender } = render(<BotAvatar bot={bot({ avatarAnimations: [manual], avatarCue: { name: "wave", seq: 3 } })} size={36} />);
    let seen = false;
    tick(600, () => { seen ||= clipAttr(container) === "wave"; });
    expect(seen).toBe(false);
    rerender(<BotAvatar bot={bot({ avatarAnimations: [manual], avatarCue: { name: "wave", seq: 4 } })} size={36} />);
    tick(400, () => { seen ||= clipAttr(container) === "wave"; });
    expect(seen).toBe(true);
  });

  it("a click plays the Bot's click clip", () => {
    const { container } = render(<BotAvatar bot={bot({ avatarAnimations: [clickClip] })} size={36} />);
    tick(300);
    fireEvent.click(container.querySelector("svg")!);
    let seen = false;
    tick(300, () => { seen ||= clipAttr(container) === "poke"; });
    expect(seen).toBe(true);
  });
});
