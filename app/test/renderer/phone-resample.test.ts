import { describe, expect, it } from "vitest";
import { Downsampler, fromInt16, toInt16 } from "../../src/phone/resample";

// Bug 198: the phone's microphone, 48 / 44.1 kHz → 16 kHz for the Mac's recognizer.

const tone = (hz: number, rate: number, secs: number) => Float32Array.from({ length: Math.round(rate * secs) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (s: Float32Array) => Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);

function run(inRate: number, hz: number, block = 128) {
  const d = new Downsampler(inRate, 16_000);
  const x = tone(hz, inRate, 1);
  const out: number[] = [];
  for (let i = 0; i < x.length; i += block) out.push(...d.push(x.subarray(i, i + block)));
  return Float32Array.from(out);
}

/** The strongest frequency in `s` (a plain DFT scan, 50 Hz steps). */
function peakHz(s: Float32Array, rate: number) {
  let best = 0, bestP = 0;
  for (let f = 50; f < rate / 2; f += 50) {
    let re = 0, im = 0;
    for (let i = 0; i < s.length; i++) { re += s[i]! * Math.cos((2 * Math.PI * f * i) / rate); im += s[i]! * Math.sin((2 * Math.PI * f * i) / rate); }
    const p = re * re + im * im;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

describe("Downsampler", () => {
  it("makes 16,000 samples a second from 48 kHz and 44.1 kHz, whatever the block size", () => {
    for (const rate of [48_000, 44_100]) for (const block of [128, 1000, 7]) expect(Math.abs(run(rate, 440, block).length - 16_000)).toBeLessThanOrEqual(2);
  });

  it("keeps speech-band tones at their pitch and level", () => {
    for (const rate of [48_000, 44_100]) {
      const out = run(rate, 1000).subarray(200);
      expect(peakHz(out.subarray(0, 4000), 16_000)).toBe(1000);
      expect(rms(out)).toBeGreaterThan(0.33);
    }
    expect(rms(run(48_000, 6000).subarray(200))).toBeGreaterThan(0.25);
  });

  it("filters what would fold back into the speech band (a 12 kHz tone doesn't become 4 kHz)", () => {
    expect(rms(run(48_000, 12_000).subarray(200))).toBeLessThan(0.02);
    expect(rms(run(44_100, 13_000).subarray(200))).toBeLessThan(0.02);
  });

  it("16-bit round trip", () => {
    const s = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const back = fromInt16(toInt16(s).buffer as ArrayBuffer);
    expect(Array.from(back).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1, 1]);
  });
});
