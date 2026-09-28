import { describe, expect, it } from "vitest";
import type { Presence } from "@synapse/shared";
import { createFaceSim, faceAmp, facePointer, faceTwirl, newProjection, project3d, REST_TURN, setFaceListening, setFacePresence, setFaceVoice, SIL_DEPTH, stepFace, type FaceFrame, type FaceSim } from "../../src/renderer/avatar/face-sim";

// "Soft 3D" (the user, 2026-09-23): every state reads as a solid object turning in space — volume
// from FORM and MOTION, never shading. The head yaws and pitches as a body: the face travels across
// it with parallax, the far eye narrows, the mouth foreshortens, the silhouette compresses, and a
// feature that goes past the limb is hidden.

const FRAME = 1000 / 60;
function make(o: { presence?: Presence; rm?: boolean; size?: number; seed?: number } = {}): FaceSim {
  return createFaceSim({ form: "pebble", presence: o.presence ?? "idle", seed: o.seed ?? 11, sizePx: o.size ?? 96, reducedMotion: o.rm ?? false, startMs: 0 });
}
function run(s: FaceSim, from: number, until: number, act: (t: number) => void = () => {}): { t: number; f: FaceFrame }[] {
  const out: { t: number; f: FaceFrame }[] = [];
  for (let t = from; t <= until; t += FRAME) { act(t); out.push({ t, f: stepFace(s, t) }); }
  return out;
}
const last = (xs: { f: FaceFrame }[]) => xs[xs.length - 1]!.f;
const range = (v: number[]) => Math.max(...v) - Math.min(...v);
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const faceDx = (f: FaceFrame) => Number(f.faceT.match(/translate\(([-\d.]+) ([-\d.]+)\)/)![1]);
const faceDy = (f: FaceFrame) => Number(f.faceT.match(/translate\(([-\d.]+) ([-\d.]+)\)/)![2]);
const silX = (f: FaceFrame) => Number(f.sil.match(/scale\(([-\d.]+) ([-\d.]+)\)/)![1]);

describe("the projection: yaw and pitch as a solid head", () => {
  const P = newProjection();
  it("square-on is the authored face", () => {
    project3d(0, 0, P);
    expect(P.dx).toBe(0); expect(P.dy).toBe(0); expect(P.bodyDx).toBe(0);
    expect(P.silX).toBeCloseTo(1, 6); expect(P.silY).toBeCloseTo(1, 6);
    expect(P.eyeX[0]).toBeCloseTo(39.5, 4); expect(P.eyeX[1]).toBeCloseTo(60.5, 4);
    expect(P.eyeWF[0]).toBeCloseTo(1, 6); expect(P.eyeWF[1]).toBeCloseTo(1, 6);
    expect(P.eyeHF).toBeCloseTo(1, 6); expect(P.mouthSX).toBeCloseTo(1, 6); expect(P.mouthSY).toBeCloseTo(1, 6);
    expect(P.eyeY).toBeCloseTo(52, 4); expect(P.mouthY).toBeCloseTo(67.5, 4);
    expect(P.eyeOn).toEqual([true, true]); expect(P.mouthOn).toBe(true);
  });
  it("a yaw carries the face across the body with parallax; the far eye narrows, the near one widens slightly", () => {
    project3d(0.3, 0, P);
    expect(P.dx).toBeGreaterThan(4); // the face travels toward the turn
    expect(P.bodyDx).toBeGreaterThan(0); // the silhouette shifts too…
    expect(P.dx).toBeGreaterThan(3 * P.bodyDx); // …but much less: parallax
    expect(P.eyeWF[1]).toBeLessThan(0.85); // far eye (the side it turns toward)
    expect(P.eyeWF[0]).toBeGreaterThan(1.02); // near eye
    expect(P.eyeWF[0]).toBeLessThan(1.25);
    expect(P.near).toBe(0);
    expect(P.mouthSX).toBeCloseTo(Math.cos(0.3), 3); // the mouth foreshortens
    expect(P.silX).toBeLessThan(1); // the silhouette compresses
    expect(P.silX).toBeGreaterThan(0.95);
    // the far eye's centre moves less (it is going round the limb) than the near one's
    expect(P.eyeX[1] - 60.5).toBeLessThan(P.eyeX[0] - 39.5);
  });
  it("is mirror-symmetric", () => {
    project3d(0.3, 0, P);
    const a = { dx: P.dx, w0: P.eyeWF[0], w1: P.eyeWF[1], x0: P.eyeX[0], s: P.silX };
    project3d(-0.3, 0, P);
    expect(P.dx).toBeCloseTo(-a.dx, 6); expect(P.eyeWF[1]).toBeCloseTo(a.w0, 6); expect(P.eyeWF[0]).toBeCloseTo(a.w1, 6);
    expect(P.eyeX[1]).toBeCloseTo(100 - a.x0, 6); expect(P.silX).toBeCloseTo(a.s, 6); expect(P.near).toBe(1);
  });
  it("pitch: looking up raises the face and shortens the eyes; looking down lowers it", () => {
    project3d(0, -0.25, P);
    expect(P.dy).toBeLessThan(-3); expect(P.eyeHF).toBeLessThan(0.97);
    project3d(0, 0.25, P);
    expect(P.dy).toBeGreaterThan(3); expect(P.mouthSY).toBeLessThan(1);
  });
  it("past 90° the mouth is round the back; each eye leaves at its own limb (the far one first)", () => {
    project3d(Math.PI / 2 + 0.05, 0, P);
    expect(P.mouthOn).toBe(false);
    expect(P.eyeOn[1]).toBe(false); // far
    expect(P.eyeOn[0]).toBe(true); // near, still on the limb, nearly edge-on
    expect(P.eyeWF[0]).toBeLessThan(0.8);
    project3d(Math.PI, 0, P);
    expect(P.eyeOn).toEqual([false, false]);
    project3d(1.0, 0, P);
    expect(P.eyeOn[1]).toBe(false); // the far eye is already behind at ~57°
    expect(P.mouthOn).toBe(true);
  });
  it("edge-on the silhouette is at its narrowest (a thick pebble, not a card)", () => {
    project3d(Math.PI / 2, 0, P);
    expect(P.silX).toBeCloseTo(SIL_DEPTH, 3);
    expect(SIL_DEPTH).toBeGreaterThan(0.4); expect(SIL_DEPTH).toBeLessThan(0.7);
    for (const y of [0.3, 1, 2, 2.8]) { project3d(y, 0, P); expect(P.silX).toBeGreaterThanOrEqual(SIL_DEPTH - 1e-9); }
  });
  it("features never leave the silhouette at any yaw", () => {
    for (let y = -Math.PI; y <= Math.PI; y += 0.05) {
      project3d(y, 0, P);
      const half = 32 * P.silX;
      for (const i of [0, 1] as const) if (P.eyeOn[i]) {
        const hw = (6.4 / 2) * P.eyeWF[i];
        expect(Math.abs(P.eyeX[i] - 50 - P.bodyDx) + hw, `yaw ${y.toFixed(2)} eye ${i}`).toBeLessThan(half);
      }
    }
  });
});

describe("every state is a pose in space", () => {
  it("idle drifts in yaw and pitch around the rest turn; breathing scales the body, not the face", () => {
    const xs = run(make(), 3000, 31_000); // two periods of the slow drift
    const yaw = xs.map((x) => x.f.debug.yaw), pitch = xs.map((x) => x.f.debug.pitch);
    expect(mean(yaw)).toBeCloseTo(REST_TURN, 1);
    expect(range(yaw)).toBeGreaterThan(0.05); expect(range(yaw)).toBeLessThan(0.3);
    expect(range(pitch)).toBeGreaterThan(0.02); expect(range(pitch)).toBeLessThan(0.2);
    expect(range(xs.map((x) => Number(x.f.sil.match(/scale\([-\d.]+ ([-\d.]+)\)/)![1])))).toBeGreaterThan(0.01); // the body breathes
    expect(new Set(xs.map((x) => x.f.body)).size).toBe(1); // the face's layer does not
  });

  it("thinking turns the head up and aside and holds it, with a small settle overshoot", () => {
    const s = make();
    run(s, 0, 1000);
    setFacePresence(s, "thinking");
    const xs = run(s, 1000, 4000);
    const f = last(xs);
    expect(f.debug.pitch).toBeLessThan(-0.12); // up
    expect(f.debug.yaw).toBeLessThan(-0.12); // aside
    expect(faceDy(f)).toBeLessThan(-2); expect(faceDx(f)).toBeLessThan(-2);
    const hold = xs.filter((x) => x.t > 2500).map((x) => x.f.debug.yaw);
    expect(range(hold)).toBeLessThan(0.01); // holds
    const peak = Math.min(...xs.map((x) => x.f.debug.yaw));
    expect(peak).toBeLessThan(f.debug.yaw - 0.003); // overshoots…
    expect(peak).toBeGreaterThan(f.debug.yaw * 1.2); // …a little
  });

  it("working pitches down toward the work and scans left-right in small yaws", () => {
    const xs = run(make({ presence: "working" }), 0, 8000).filter((x) => x.t > 1500);
    expect(Math.min(...xs.map((x) => x.f.debug.pitch))).toBeGreaterThan(0.05);
    const yaw = xs.map((x) => x.f.debug.yaw);
    expect(range(yaw)).toBeGreaterThan(0.04); expect(range(yaw)).toBeLessThan(0.25);
    expect(Math.min(...yaw)).toBeLessThan(0); expect(Math.max(...yaw)).toBeGreaterThan(0);
  });

  it("speaking nods with the mouth level and shifts its yaw, smoothly", () => {
    const s = make();
    run(s, 0, 1000);
    const xs = run(s, 1000, 5000, (t) => setFaceVoice(s, 0.5 + 0.45 * Math.sin(t / 130) * Math.sin(t / 470)));
    const pitch = xs.map((x) => x.f.debug.pitch), yaw = xs.map((x) => x.f.debug.yaw);
    expect(range(pitch)).toBeGreaterThan(0.03); expect(range(pitch)).toBeLessThan(0.2);
    expect(range(yaw)).toBeGreaterThan(0.02);
    // never a jump: the head moves at most ~0.02 rad a frame
    for (let i = 1; i < xs.length; i++) expect(Math.abs(pitch[i]! - pitch[i - 1]!)).toBeLessThan(0.02);
    const lv = xs.map((x) => x.f.debug.level);
    const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; } return n / Math.sqrt(da * db); };
    expect(corr(lv.slice(0, -6), pitch.slice(6))).toBeGreaterThan(0.4); // in rhythm (the head lags the mouth)
  });

  it("listening leans toward the user: a tilt and a lean in", () => {
    const s = make();
    run(s, 0, 1000);
    setFaceListening(s, true);
    const f = last(run(s, 1000, 3000));
    expect(Math.abs(f.debug.tilt)).toBeGreaterThan(2);
    expect(f.debug.lean).toBeGreaterThan(1.015);
    expect(Math.abs(f.debug.yaw)).toBeLessThan(0.12); // squarer to the user than the rest turn
    setFaceListening(s, false);
    const g = last(run(s, 3000, 5000));
    expect(g.debug.lean).toBeCloseTo(1, 2);
  });

  it("the happy hop: anticipation squash, stretch in the air pitched up with a small yaw, landing squash", () => {
    const s = make({ presence: "working" });
    run(s, 0, 1500);
    const before = last(run(s, 1500, 1500));
    setFacePresence(s, "idle");
    const xs = run(s, 1520, 2600);
    const firstAir = xs.findIndex((x) => x.f.debug.hop < -0.5);
    expect(firstAir).toBeGreaterThan(2);
    expect(xs.slice(0, firstAir).some((x) => x.f.debug.squash > 0.05)).toBe(true); // anticipation
    const air = xs.filter((x) => x.f.debug.hop < -2);
    expect(air.some((x) => x.f.debug.squash < -0.03)).toBe(true); // stretch
    expect(Math.min(...air.map((x) => x.f.debug.pitch))).toBeLessThan(-0.06); // pitched up
    expect(Math.max(...air.map((x) => Math.abs(x.f.debug.yaw - before.debug.yaw)))).toBeGreaterThan(0.03); // a small yaw
    const land = xs.findIndex((x, i) => i > firstAir && x.f.debug.hop === 0);
    expect(Math.max(...xs.slice(land, land + 10).map((x) => x.f.debug.squash))).toBeGreaterThan(0.05); // weight
  });

  it("the click twirl is a true 360° yaw: edge-on, face behind, edge-on, and back to rest", () => {
    const s = make();
    run(s, 0, 1500);
    faceTwirl(s, 1500);
    const xs = run(s, 1500, 4500);
    const minSil = Math.min(...xs.map((x) => silX(x.f)));
    expect(minSil).toBeLessThan(SIL_DEPTH + 0.03); // narrows through edge-on
    const hiddenAt = xs.findIndex((x) => !x.f.face);
    expect(hiddenAt).toBeGreaterThan(0);
    const back = xs.findIndex((x, i) => i > hiddenAt && x.f.face);
    expect(back).toBeGreaterThan(hiddenAt);
    // it reappears from the OTHER side: the face offset changes sign across the back
    const dxBefore = faceDx(xs[hiddenAt - 1]!.f), dxAfter = faceDx(xs[back]!.f);
    expect(Math.sign(dxBefore)).toBe(-Math.sign(dxAfter));
    const f = last(xs);
    expect(f.face).toBe(true);
    expect(f.debug.turn).toBeCloseTo(REST_TURN, 2); // the spin is done
    expect(Math.abs(f.debug.yaw - REST_TURN)).toBeLessThan(0.12); // back on the idle drift round the rest turn
  });

  it("a blink closes the lids with the face's foreshortening: the far eye stays narrower", () => {
    const s = make();
    const xs = run(s, 0, 20_000);
    const shut = xs.filter((x) => x.f.eyes[0].h < 3 && x.f.eyes[1].h < 3 && x.f.debug.yaw > 0.1);
    expect(shut.length).toBeGreaterThan(0);
    for (const x of shut) expect(x.f.eyes[1].w).toBeLessThan(x.f.eyes[0].w);
  });

  it("depth order: the near eye draws over the far one", () => {
    const s = make();
    expect(last(run(s, 0, 2000)).near).toBe(0); // the rest turn is toward +x, so eye 0 is near
    setFacePresence(s, "thinking");
    expect(last(run(s, 2000, 5000)).near).toBe(1); // turned aside the other way
  });
});

describe("constraints", () => {
  it("reduce motion holds the rest pose: no drift, no nods, no springs", () => {
    const s = make({ rm: true });
    const xs = run(s, 0, 8000, (t) => {
      if (Math.abs(t - 1000) < FRAME / 2) setFacePresence(s, "thinking");
      if (Math.abs(t - 3000) < FRAME / 2) setFaceVoice(s, 0.8);
      if (Math.abs(t - 4000) < FRAME / 2) { setFaceVoice(s, null); setFaceListening(s, true); }
      if (Math.abs(t - 5000) < FRAME / 2) { setFaceListening(s, false); setFacePresence(s, "idle"); }
    });
    for (const x of xs) {
      expect(x.f.debug.pitch).toBe(0);
      expect(x.f.debug.tilt).toBe(0);
      expect(x.f.debug.lean).toBe(1);
      expect([0, REST_TURN]).toContain(x.f.debug.yaw);
    }
    expect(xs[0]!.f.debug.yaw).toBe(REST_TURN); // from the first frame, no spring
  });

  it("small avatars move less: amplitudes scale with size, 22 px about half of 96 px", () => {
    expect(faceAmp(22)).toBeGreaterThan(0.35); expect(faceAmp(22)).toBeLessThan(0.6);
    expect(faceAmp(48)).toBe(1); expect(faceAmp(96)).toBe(1);
    const pitchAt = (size: number) => { const s = make({ size, presence: "thinking" }); return last(run(s, 0, 3000)).debug.pitch; };
    expect(pitchAt(22) / pitchAt(96)).toBeCloseTo(faceAmp(22), 1);
  });

  it("the twirl is full-size at every size (a turn is a turn)", () => {
    const s = make({ size: 22 });
    run(s, 0, 500); faceTwirl(s, 500);
    expect(run(s, 500, 3000).some((x) => !x.f.face)).toBe(true);
  });

  it("hover turns the head toward the pointer (yaw and pitch), not just the eyes", () => {
    const s = make();
    run(s, 0, 1000);
    facePointer(s, true, -1, 1, 1000);
    const f = last(run(s, 1000, 2500));
    expect(f.debug.yaw).toBeLessThan(-0.1);
    expect(f.debug.pitch).toBeGreaterThan(0.08);
  });
});
