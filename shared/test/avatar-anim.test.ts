import { describe, expect, it } from "vitest";
import {
  ANIM_LIMITS, ANIM_REST, AVATAR_ANIM_HELP, parseAvatarClip, sampleClip, upsertClip, validateAvatarClip, type AvatarClip,
} from "../src";

const spin: AvatarClip = {
  name: "happy-spin", on: "task_done", duration_ms: 1200,
  keys: [
    { at: 0.25, y: -18, squash: -0.15, eyes: "happy", ease: "pop" },
    { at: 0.6, turn: 1, ease: "glide" },
    { at: 0.8, y: 0, squash: 0.2 },
  ],
};

describe("avatar animation DSL: validation", () => {
  it("accepts a well-formed clip and returns it normalised", () => {
    const r = validateAvatarClip(spin);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.clip).toEqual(spin);
  });

  it("parses JSON text, and reports bad JSON as an error rather than throwing", () => {
    expect(parseAvatarClip(JSON.stringify(spin)).ok).toBe(true);
    const bad = parseAvatarClip("{name: nope");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatch(/JSON/);
  });

  it("rejects unknown fields at every level (no scripts, no smuggled keys)", () => {
    const r = validateAvatarClip({ ...spin, onload: "alert(1)", keys: [{ at: 0.5, y: 2, script: "x" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toMatch(/onload/);
      expect(r.errors.join("\n")).toMatch(/keys\[0\]\.script/);
    }
  });

  it("rejects out-of-range amplitudes and durations instead of clamping them silently", () => {
    const r = validateAvatarClip({ ...spin, duration_ms: 60_000, keys: [{ at: 0.5, x: 400, tilt: 90, scale: 9, squash: 2, turn: 7 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) for (const f of ["duration_ms", "x", "tilt", "scale", "squash", "turn"]) expect(r.errors.join("\n")).toContain(f);
  });

  it("rejects non-finite numbers, strings where numbers go, and values outside the enums", () => {
    for (const bad of [{ at: 0.5, y: Number.NaN }, { at: 0.5, y: "1" }, { at: 0.5, eyes: "laser" }, { at: 0.5, ease: "cubic-bezier(0,0,1,1)" }]) {
      expect(validateAvatarClip({ ...spin, keys: [bad] }).ok).toBe(false);
    }
    expect(validateAvatarClip({ ...spin, on: "every_frame" }).ok).toBe(false);
  });

  it("requires keys strictly increasing inside (0, 1), each doing something, and far enough apart", () => {
    expect(validateAvatarClip({ ...spin, keys: [{ at: 0.6, y: 1 }, { at: 0.4, y: 2 }] }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, keys: [{ at: 0, y: 1 }] }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, keys: [{ at: 1, y: 1 }] }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, keys: [{ at: 0.5 }] }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, keys: [] }).ok).toBe(false);
    // 1,000 ms clip: keys 10 ms apart are under the minimum gap
    expect(validateAvatarClip({ ...spin, duration_ms: 1000, keys: [{ at: 0.5, y: 1 }, { at: 0.51, y: 2 }] }).ok).toBe(false);
  });

  it("caps the number of keys, the name, and the serialised size", () => {
    const many = Array.from({ length: ANIM_LIMITS.maxKeys + 1 }, (_, i) => ({ at: (i + 1) / (ANIM_LIMITS.maxKeys + 3), y: 1 }));
    expect(validateAvatarClip({ ...spin, duration_ms: 4000, keys: many }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, name: "Has Spaces" }).ok).toBe(false);
    expect(validateAvatarClip({ ...spin, name: "x".repeat(40) }).ok).toBe(false);
    expect(parseAvatarClip(JSON.stringify(spin) + " ".repeat(ANIM_LIMITS.maxJsonChars)).ok).toBe(false);
  });

  it("limits eye changes so a clip cannot strobe", () => {
    const flicker = Array.from({ length: 8 }, (_, i) => ({ at: (i + 1) / 10, eyes: i % 2 ? "open" : "closed" }));
    const r = validateAvatarClip({ ...spin, duration_ms: 4000, keys: flicker });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/eye/);
    // eye changes closer than the minimum gap
    expect(validateAvatarClip({ ...spin, duration_ms: 400, keys: [{ at: 0.2, eyes: "closed" }, { at: 0.35, eyes: "open" }] }).ok).toBe(false);
  });
});

describe("avatar animation DSL: sampling", () => {
  it("starts and ends at rest", () => {
    expect(sampleClip(spin, 0)).toEqual(ANIM_REST);
    const end = sampleClip(spin, spin.duration_ms);
    expect(end).toMatchObject({ x: 0, y: 0, tilt: 0, scale: 1, squash: 0, eyes: "open" });
    // a whole turn ends a whole turn round, which draws exactly like rest
    expect(end.turn).toBe(1);
  });

  it("interpolates each channel only between keys that set it", () => {
    const lin: AvatarClip = { name: "a", on: "manual", duration_ms: 1000, keys: [{ at: 0.5, x: 10, ease: "linear" }, { at: 0.75, tilt: 20, ease: "linear" }] };
    expect(sampleClip(lin, 250).x).toBeCloseTo(5, 6);
    expect(sampleClip(lin, 500).x).toBeCloseTo(10, 6);
    // x runs from its key at 0.5 back to rest at 1: halfway at 0.75
    expect(sampleClip(lin, 750).x).toBeCloseTo(5, 6);
    // tilt runs from rest at 0 to 20 at 0.75
    expect(sampleClip(lin, 375).tilt).toBeCloseTo(10, 6);
  });

  it("steps the eyes (they hold until the next key that sets them)", () => {
    expect(sampleClip(spin, 200).eyes).toBe("open");
    expect(sampleClip(spin, 300).eyes).toBe("happy");
    expect(sampleClip(spin, 1100).eyes).toBe("happy");
  });

  it("the spring eases overshoot a little but every sample stays inside the channel bounds", () => {
    const big: AvatarClip = { name: "b", on: "manual", duration_ms: 800, keys: [{ at: 0.5, y: -ANIM_LIMITS.y, scale: ANIM_LIMITS.scale[1], ease: "pop" }] };
    let minY = 0;
    for (let t = 0; t <= 800; t += 5) {
      const p = sampleClip(big, t);
      minY = Math.min(minY, p.y);
      expect(p.y).toBeGreaterThanOrEqual(-ANIM_LIMITS.y);
      expect(p.scale).toBeLessThanOrEqual(ANIM_LIMITS.scale[1]);
    }
    expect(minY).toBe(-ANIM_LIMITS.y);
  });

  it("is total: times before, after and NaN give rest-safe poses", () => {
    expect(sampleClip(spin, -50)).toEqual(ANIM_REST);
    expect(sampleClip(spin, 99_999).y).toBe(0);
    expect(sampleClip(spin, Number.NaN)).toEqual(ANIM_REST);
  });
});

describe("avatar animation DSL: per-Bot set", () => {
  it("one clip per trigger (a new one replaces it), any number of manual ones up to the cap, same name replaces", () => {
    let set: AvatarClip[] = [];
    set = upsertClip(set, spin).clips;
    set = upsertClip(set, { ...spin, name: "other-done" }).clips;
    expect(set.map((c) => c.name)).toEqual(["other-done"]);
    set = upsertClip(set, { ...spin, name: "wave", on: "manual" }).clips;
    set = upsertClip(set, { ...spin, name: "wave", on: "manual", duration_ms: 900 }).clips;
    expect(set.filter((c) => c.name === "wave")).toHaveLength(1);
    for (let i = 0; i < ANIM_LIMITS.maxClips + 2; i++) set = upsertClip(set, { ...spin, name: `m${i}`, on: "manual" }).clips;
    expect(set.length).toBeLessThanOrEqual(ANIM_LIMITS.maxClips);
    expect(upsertClip(set, { ...spin, name: "one-more", on: "manual" }).error).toMatch(/at most/);
  });

  it("documents itself for the Bot in under 1,500 characters", () => {
    expect(AVATAR_ANIM_HELP.length).toBeLessThan(1_500);
    for (const w of ["task_done", "click", "manual", "turn", "squash", "happy", "pop", "duration_ms"]) expect(AVATAR_ANIM_HELP).toContain(w);
    // the example in the help is itself valid
    const ex = AVATAR_ANIM_HELP.slice(AVATAR_ANIM_HELP.indexOf("{"), AVATAR_ANIM_HELP.lastIndexOf("}") + 1);
    expect(parseAvatarClip(ex).ok).toBe(true);
  });
});
