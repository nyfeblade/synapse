import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIP_SAMPLE_RATE } from "@synapse/shared";
import { judgeTake, rmsOf, trimSilence, wavDecode, wavEncode } from "../../src/main/native/voice-clips";

/** A take with `lead`/`tail` seconds of near-silence around `speech` seconds of voice. */
function take(o: { speech?: number; lead?: number; tail?: number; level?: number } = {}): Float32Array {
  const sr = CLIP_SAMPLE_RATE;
  const lead = Math.round((o.lead ?? 0) * sr);
  const tail = Math.round((o.tail ?? 0) * sr);
  const body = Math.round((o.speech ?? 8) * sr);
  const level = o.level ?? 0.5;
  const x = new Float32Array(lead + body + tail);
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const phrase = Math.round(1.5 * sr);
  const pause = Math.round(0.3 * sr);
  for (let i = 0; i < x.length; i++) x[i] = 0.0005 * rnd();
  for (let i = 0; i < body; i++) {
    if (i % phrase >= phrase - pause) continue;
    x[lead + i] += level * Math.sin((2 * Math.PI * 120 * i) / sr);
  }
  return x;
}

let dir = "";
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "clips-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("the WAV the clone conditions on", () => {
  it("writes 24 kHz mono 16-bit PCM and reads back what it wrote", () => {
    const pcm = take({ speech: 1 });
    const wav = wavEncode(pcm);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);               // mono
    expect(wav.readUInt32LE(24)).toBe(CLIP_SAMPLE_RATE); // 24 kHz
    expect(wav.readUInt16LE(34)).toBe(16);              // 16-bit
    const back = wavDecode(wav);
    expect(back?.sampleRate).toBe(CLIP_SAMPLE_RATE);
    expect(back?.pcm.length).toBe(pcm.length);
    // 16-bit quantisation, nothing worse
    for (let i = 0; i < pcm.length; i += 97) expect(Math.abs(back!.pcm[i] - pcm[i])).toBeLessThan(1 / 32000);
  });

  it("clamps rather than wrapping when a sample is over full scale", () => {
    const hot = Float32Array.from([2, -2, 0]);
    const back = wavDecode(wavEncode(hot))!;
    expect(back.pcm[0]).toBeCloseTo(1, 2);
    expect(back.pcm[1]).toBeCloseTo(-1, 2);
  });

  it("refuses something that is not a WAV", () => {
    expect(wavDecode(Buffer.from("not a wav at all, really no"))).toBeNull();
  });
});

describe("trimming a take", () => {
  it("drops the silence at each end and keeps the words", () => {
    const raw = take({ speech: 8, lead: 1.5, tail: 1.5 });
    const cut = trimSilence(raw);
    expect(cut.length).toBeLessThan(raw.length);
    // the 8 s of speech survives (plus the 30 ms of room kept either side)
    expect(cut.length / CLIP_SAMPLE_RATE).toBeGreaterThan(7.9);
    expect(cut.length / CLIP_SAMPLE_RATE).toBeLessThan(8.4);
  });

  it("cuts at a zero crossing, so the clip cannot start or end on a click", () => {
    const cut = trimSilence(take({ speech: 8, lead: 1, tail: 1 }));
    expect(Math.abs(cut[0])).toBeLessThan(0.02);
    expect(Math.abs(cut[cut.length - 1])).toBeLessThan(0.02);
  });

  it("leaves a take that is already tight alone", () => {
    const tight = take({ speech: 8 });
    expect(trimSilence(tight).length / tight.length).toBeGreaterThan(0.95);
  });

  it("does not throw on silence", () => {
    expect(() => trimSilence(new Float32Array(2400))).not.toThrow();
  });
});

describe("judging a take", () => {
  it("accepts a clean 8 s take and reports its length after trimming", () => {
    const r = judgeTake(take({ speech: 8, lead: 2, tail: 2 }));
    expect(r.ok).toBe(true);
    expect(r.seconds).toBeGreaterThan(7.9);
    expect(r.seconds).toBeLessThan(8.4);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it("judges by the trimmed length, not the raw one", () => {
    // 4 s of speech inside a 12 s recording is still too short to clone from
    const r = judgeTake(take({ speech: 4, lead: 4, tail: 4 }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "length")?.detail).toMatch(/too short/);
  });

  it("fails a take recorded far too quietly, with something to do about it", () => {
    const r = judgeTake(take({ speech: 8, level: 0.02 }));
    const level = r.checks.find((c) => c.id === "level")!;
    expect(level.pass).toBe(false);
    expect(level.detail).toMatch(/quiet/i);
  });

  it("measures the loudness a saved voice is held to", () => {
    const r = judgeTake(take({ speech: 8 }));
    expect(rmsOf(r.pcm)).toBeGreaterThan(0.05);
    expect(rmsOf(r.pcm)).toBeCloseTo(r.measure.rms, 5);
  });
});
