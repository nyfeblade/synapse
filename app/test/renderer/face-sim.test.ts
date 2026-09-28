import { describe, expect, it } from "vitest";
import type { AvatarClip, Presence } from "@synapse/shared";
import { createFaceSim, faceBusy, facePlayClip, facePointer, faceTwirl, REST_TURN, setFaceClips, setFacePresence, setFaceVoice, stepFace, type FaceFrame, type FaceSim } from "../../src/renderer/avatar/face-sim";

// The Synapse avatar ("Eyes + mouth", the user's pick from the avatar studies) as a pure sim on a
// fake clock with a seeded RNG. Interaction claims are made against a TWIN with interactions off, so
// what differs is the interaction and only it.

const FRAME = 1000 / 60;
function make(o: { presence?: Presence; rm?: boolean; interactions?: boolean; seed?: number } = {}): FaceSim {
  return createFaceSim({ form: "pebble", presence: o.presence ?? "idle", seed: o.seed ?? 11, sizePx: 36, reducedMotion: o.rm ?? false, startMs: 0, interactions: o.interactions ?? true });
}
function run(s: FaceSim, from: number, until: number, act: (t: number) => void = () => {}): { t: number; f: FaceFrame }[] {
  const out: { t: number; f: FaceFrame }[] = [];
  for (let t = from; t <= until; t += FRAME) { act(t); out.push({ t, f: stepFace(s, t) }); }
  return out;
}
const last = (xs: { f: FaceFrame }[]) => xs[xs.length - 1]!.f;
const eyeH = (f: FaceFrame, i: 0 | 1) => f.eyes[i].h;

describe("the face at rest", () => {
  it("idle smiles, both eyes open as upright capsules", () => {
    const f = last(run(make(), 0, 2000));
    expect(f.mouth.kind).toBe("smile");
    expect(f.mouth.line).toMatch(/^M[\d.]+ [\d.]+Q/);
    expect(f.mouth.fill).toBe("");
    for (const i of [0, 1] as const) { expect(f.eyes[i].h).toBeGreaterThan(f.eyes[i].w * 1.5); expect(f.eyes[i].arc).toBe(""); }
  });

  it("blinks every few seconds, and the lid comes back open", () => {
    const xs = run(make(), 0, 20_000);
    const shut = xs.filter((x) => eyeH(x.f, 0) < 3);
    expect(shut.length).toBeGreaterThan(0);
    // blinks are short: no closed stretch lasts longer than a quarter of a second
    let runLen = 0, longest = 0;
    for (const x of xs) { runLen = eyeH(x.f, 0) < 3 ? runLen + 1 : 0; longest = Math.max(longest, runLen); }
    expect(longest * FRAME).toBeLessThan(250);
    const starts = xs.filter((x, i) => i > 0 && eyeH(x.f, 0) < 3 && eyeH(xs[i - 1]!.f, 0) >= 3).length;
    expect(starts).toBeGreaterThanOrEqual(2);
    expect(starts).toBeLessThanOrEqual(8);
    expect(eyeH(last(xs), 0)).toBeGreaterThan(10);
  });

  it("breathes: the body's outline swells and settles on a slow period (the face does not)", () => {
    const sy = run(make(), 3000, 9000).map((x) => Number(x.f.sil.match(/scale\(([-\d.]+) ([-\d.]+)\)/)![2]));
    expect(Math.max(...sy) - Math.min(...sy)).toBeGreaterThan(0.01);
    expect(Math.max(...sy) - Math.min(...sy)).toBeLessThan(0.05);
  });

  it("rests turned slightly toward the chat so the form reads (smooth pass)", () => {
    const f = last(run(make(), 0, 4000));
    expect(f.debug.turn).toBeCloseTo(REST_TURN, 2);
  });

  it("reduced motion: the rest turn is applied without springs, from the first frame", () => {
    const s = make({ rm: true });
    expect(stepFace(s, 0).debug.turn).toBe(REST_TURN);
  });
});

describe("mouth states follow what the Bot is doing", () => {
  it("thinking: the 'hmm' line, eyes glance up and aside", () => {
    const s = make();
    run(s, 0, 500);
    setFacePresence(s, "thinking");
    const f = last(run(s, 500, 2500));
    expect(f.mouth.kind).toBe("hmm");
    expect(f.debug.gaze[1]).toBeLessThan(-2); // up
    expect(Math.abs(f.debug.gaze[0])).toBeGreaterThan(1.5); // aside
  });

  it("working: eyes look down, the mouth is a level line", () => {
    const s = make({ presence: "working" });
    const f = last(run(s, 0, 2500));
    expect(f.mouth.kind).toBe("hmm");
    expect(f.debug.gaze[1]).toBeGreaterThan(1.5);
  });

  for (const p of ["searching", "loading", "orbit", "sending"] as const) {
    it(`${p} is a busy face (the hmm line), not the resting smile`, () => {
      expect(last(run(make({ presence: p }), 0, 2000)).mouth.kind).toBe("hmm");
    });
  }

  it("speaking: a filled ellipse that opens with the voice level", () => {
    const s = make();
    run(s, 0, 500);
    setFaceVoice(s, 0.1);
    const quiet = last(run(s, 500, 1200));
    setFaceVoice(s, 0.9);
    const loud = last(run(s, 1200, 1900));
    expect(quiet.mouth.kind).toBe("speak");
    expect(loud.mouth.kind).toBe("speak");
    const ry = (f: FaceFrame) => Number(f.mouth.fill.match(/A([\d.]+) ([\d.]+)/)![2]);
    expect(ry(loud)).toBeGreaterThan(ry(quiet) * 2);
    setFaceVoice(s, null);
    expect(last(run(s, 1900, 2600)).mouth.kind).toBe("smile");
  });

  it("happy: finishing work celebrates with happy (arched) eyes and an open smile, then rests", () => {
    const s = make({ presence: "working" });
    run(s, 0, 1000);
    setFacePresence(s, "idle");
    const xs = run(s, 1000, 4500);
    const happy = xs.filter((x) => x.f.mouth.kind === "open");
    expect(happy.length).toBeGreaterThan(20);
    expect(happy.some((x) => x.f.eyes[0].arc !== "" && x.f.eyes[1].arc !== "")).toBe(true);
    expect(Math.min(...xs.map((x) => x.f.debug.hop))).toBeLessThan(-3); // a hop
    expect(last(xs).mouth.kind).toBe("smile");
  });
});

describe("no spark (the user: \"avatar dot fully off\")", () => {
  it("a frame carries no dot in any state, working or thinking included", () => {
    for (const p of ["idle", "thinking", "working", "searching", "loading", "orbit", "sending"] as const) {
      for (const x of run(make({ presence: p }), 0, 2000)) expect(Object.keys(x.f), p).not.toContain("spark");
    }
  });
});

describe("the Bot-authored animation DSL plays on the new face", () => {
  const clip = (eyes: AvatarClip["keys"][number]["eyes"], extra: Partial<AvatarClip["keys"][number]> = {}): AvatarClip =>
    ({ name: "c", on: "manual", duration_ms: 1500, keys: [{ at: 0.1, eyes, y: -10, ...extra }, { at: 0.9, y: -10 }] });
  const mid = (c: AvatarClip) => {
    const s = make();
    run(s, 0, 500);
    facePlayClip(s, c, 500);
    return run(s, 500, 1500).find((x) => x.t >= 1250)!.f;
  };

  it("open keeps the capsules and the smile", () => {
    const f = mid(clip("open"));
    expect(f.eyes[0].arc).toBe("");
    expect(f.mouth.kind).toBe("smile");
  });
  it("closed shuts both eyes to a line", () => {
    const f = mid(clip("closed"));
    expect(eyeH(f, 0)).toBeLessThan(3);
    expect(eyeH(f, 1)).toBeLessThan(3);
  });
  it("happy arches both eyes and opens the smile", () => {
    const f = mid(clip("happy"));
    expect(f.eyes[0].arc).not.toBe("");
    expect(f.eyes[1].arc).not.toBe("");
    expect(f.mouth.kind).toBe("open");
  });
  it("wide makes the eyes taller and the mouth a small o", () => {
    const f = mid(clip("wide")), g = mid(clip("open"));
    expect(eyeH(f, 0)).toBeGreaterThan(eyeH(g, 0) * 1.1);
    expect(f.mouth.kind).toBe("o");
  });
  it("wink closes one eye only", () => {
    const f = mid(clip("wink"));
    expect(eyeH(f, 0)).toBeGreaterThan(10);
    expect(eyeH(f, 1) < 3 || f.eyes[1].arc !== "").toBe(true);
  });
  it("look_left / look_right / look_up / look_down move the gaze that way", () => {
    expect(mid(clip("look_left")).debug.gaze[0]).toBeLessThan(-2.5);
    expect(mid(clip("look_right")).debug.gaze[0]).toBeGreaterThan(2.5);
    expect(mid(clip("look_up")).debug.gaze[1]).toBeLessThan(-2);
    expect(mid(clip("look_down")).debug.gaze[1]).toBeGreaterThan(2);
  });
  it("moves, tilts, turns and squashes the body, and returns exactly to rest", () => {
    const c: AvatarClip = { name: "c", on: "manual", duration_ms: 1200, keys: [{ at: 0.4, y: -20, tilt: 20, squash: 0.2, ease: "linear" }] };
    const a = make(), b = make({ interactions: true });
    run(a, 0, 500); run(b, 0, 500);
    facePlayClip(a, c, 500);
    const on = run(a, 500, 2600), off = run(b, 500, 2600);
    const at = (xs: typeof on, t: number) => xs.find((x) => x.t >= t)!.f;
    expect(at(on, 980).debug.y - at(off, 980).debug.y).toBeLessThan(-12); // 20% of the 72-unit frame
    expect(at(on, 980).debug.tilt).toBeGreaterThan(15);
    expect(at(on, 980).debug.clip).toBe("c");
    expect(last(on).debug.clip).toBeNull();
    expect(last(on).debug.y).toBeCloseTo(last(off).debug.y, 1);
    expect(last(on).debug.tilt).toBe(0);
  });
  it("a turn carries the face round the back of the head", () => {
    const c: AvatarClip = { name: "c", on: "manual", duration_ms: 1200, keys: [{ at: 0.5, turn: 1 }] };
    const s = make();
    run(s, 0, 500);
    facePlayClip(s, c, 500);
    const xs = run(s, 500, 2000);
    expect(xs.some((x) => !x.f.face)).toBe(true);
    expect(last(xs).face).toBe(true);
  });
  it("task_done replaces the built-in celebration; click replaces the twirl", () => {
    const done: AvatarClip = { name: "yay", on: "task_done", duration_ms: 900, keys: [{ at: 0.5, y: -10 }] };
    const s = make({ presence: "working" });
    setFaceClips(s, [done]);
    run(s, 0, 600);
    setFacePresence(s, "idle");
    const xs = run(s, 600, 1200);
    expect(xs.some((x) => x.f.debug.clip === "yay")).toBe(true);
    const poke: AvatarClip = { ...done, name: "poke", on: "click" };
    const c = make();
    setFaceClips(c, [poke]);
    run(c, 0, 300);
    faceTwirl(c, 300);
    expect(stepFace(c, 320).debug.clip).toBe("poke");
    expect(run(c, 320, 1000).every((x) => x.f.face)).toBe(true); // no twirl
  });
  it("reduced motion never plays a clip (a brief opacity dip instead)", () => {
    const s = make({ rm: true });
    run(s, 0, 300);
    facePlayClip(s, clip("happy"), 300);
    const xs = run(s, 300, 900);
    expect(xs.every((x) => x.f.debug.clip === null)).toBe(true);
    expect(Math.min(...xs.map((x) => x.f.opacity))).toBeLessThan(0.9);
  });
});

describe("interactions (designed, restrained)", () => {
  it("hover hops once and glances toward the pointer; the twin never moves", () => {
    const a = make(), b = make({ interactions: false });
    run(a, 0, 600); run(b, 0, 600);
    facePointer(a, true, 1, 0, 600); facePointer(b, true, 1, 0, 600);
    const on = run(a, 600, 1400), off = run(b, 600, 1400);
    expect(Math.min(...on.map((x) => x.f.debug.hop))).toBeLessThan(-1.5); // > 0.75 px at 36 px
    expect(off.every((x) => x.f.debug.hop === 0)).toBe(true);
    expect(last(on).debug.gaze[0]).toBeGreaterThan(last(off).debug.gaze[0] + 1.5);
    expect(run(a, 1400, 2400).every((x) => x.f.debug.hop === 0)).toBe(true); // a pointer that stays does not hop again
  });

  it("click twirls one turn (the face goes round the back) and settles", () => {
    const s = make();
    run(s, 0, 500);
    faceTwirl(s, 500);
    const xs = run(s, 500, 3500);
    expect(Math.max(...xs.map((x) => Math.abs(x.f.debug.turn)))).toBeGreaterThanOrEqual(1);
    expect(xs.some((x) => !x.f.face)).toBe(true);
    expect(last(xs).debug.turn).toBeCloseTo(REST_TURN, 2); // settles back to the rest turn, not square-on
    expect(last(xs).face).toBe(true);
  });

  it("no interaction lifts the body more than 4 px at 36 px, or squashes it more than 14%", () => {
    const s = make({ presence: "working" });
    const xs = run(s, 0, 5000, (t) => {
      if (Math.abs(t - 400) < FRAME / 2) facePointer(s, true, 0.3, -0.2, t);
      if (Math.abs(t - 1200) < FRAME / 2) faceTwirl(s, t);
      if (Math.abs(t - 2600) < FRAME / 2) setFacePresence(s, "idle");
    });
    const px = 36 / 72;
    expect(Math.min(...xs.map((x) => x.f.debug.hop)) * px).toBeGreaterThan(-4);
    expect(Math.max(...xs.map((x) => Math.abs(x.f.debug.squash)))).toBeLessThanOrEqual(0.14);
  });

  it("reduced motion: presence changes and clicks move nothing (at most an opacity dip); no blinks, no breathing", () => {
    const s = make({ rm: true });
    const xs = run(s, 0, 8000, (t) => {
      if (Math.abs(t - 1000) < FRAME / 2) faceTwirl(s, t);
      if (Math.abs(t - 3000) < FRAME / 2) setFacePresence(s, "working");
      if (Math.abs(t - 5000) < FRAME / 2) setFacePresence(s, "idle");
    });
    expect(xs.every((x) => x.f.debug.hop === 0 && x.f.face)).toBe(true);
    // The rest turn still applies (without springs), snapping off while the mood is "working" and
    // back on once idle — no continuous motion, but not always square-on either.
    const turnAt = (t: number) => xs.find((x) => x.t >= t)!.f.debug.turn;
    expect(turnAt(0)).toBe(REST_TURN);
    expect(turnAt(2500)).toBe(REST_TURN);
    expect(turnAt(3500)).toBe(0);
    expect(turnAt(4500)).toBe(0);
    expect(turnAt(5500)).toBe(REST_TURN);
    expect(turnAt(7500)).toBe(REST_TURN);
    expect(new Set(xs.map((x) => x.f.sil)).size).toBe(2); // idle's rest-turned silhouette vs. working's square one
    expect(new Set(xs.map((x) => x.f.body)).size).toBe(1); // no breathing, no squash
    expect(xs.every((x) => eyeH(x.f, 0) > 10 || x.f.eyes[0].arc !== "")).toBe(true);
    expect(xs.find((x) => x.t > 4000)!.f.mouth.kind).toBe("hmm"); // state still reads
  });
});

describe("cost: the sim says when it needs the display rate (bug #100)", () => {
  it("busy on entry, calm once idle has settled (breathing, drift and blinks are ambient)", () => {
    const s = make();
    stepFace(s, 0);
    expect(faceBusy(s, 0)).toBe(true);
    let calm = 0, total = 0;
    for (let t = 2000; t < 20_000; t += 1000 / 30) { stepFace(s, t); total++; if (!faceBusy(s, t)) calm++; }
    expect(calm / total).toBeGreaterThan(0.9);
  });
  it("busy while hovered, twirling, speaking, or changing expression", () => {
    const s = make();
    run(s, 0, 2000);
    expect(faceBusy(s, 2000)).toBe(false);
    facePointer(s, true, 0, 0, 2000);
    expect(faceBusy(s, 2000)).toBe(true);
    facePointer(s, false, 0, 0, 2000); run(s, 2000, 4000);
    faceTwirl(s, 4000); stepFace(s, 4020);
    expect(faceBusy(s, 4020)).toBe(true);
    run(s, 4020, 7000);
    expect(faceBusy(s, 7000)).toBe(false);
    setFaceVoice(s, 0.5); stepFace(s, 7020);
    expect(faceBusy(s, 7020)).toBe(true);
    setFaceVoice(s, null); run(s, 7020, 9000);
    setFacePresence(s, "thinking"); stepFace(s, 9020);
    expect(faceBusy(s, 9020)).toBe(true);
    run(s, 9020, 12_000);
    expect(faceBusy(s, 12_000)).toBe(false); // a settled thinking face is ambient motion
  });
  it("the same seed gives the same frames; another seed does not", () => {
    const a = run(make({ seed: 3 }), 0, 9000).map((x) => JSON.stringify(x.f));
    const b = run(make({ seed: 3 }), 0, 9000).map((x) => JSON.stringify(x.f));
    const c = run(make({ seed: 4 }), 0, 9000).map((x) => JSON.stringify(x.f));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
