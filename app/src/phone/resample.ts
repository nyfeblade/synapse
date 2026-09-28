/**
 * Bug 198: the phone's microphone, from the browser's rate (48 kHz on iPhones and most Androids,
 * 44.1 kHz on some) down to the 16 kHz the Mac's recognizer takes. A windowed-sinc low-pass first
 * (nothing above ~7.2 kHz folds back into the speech band), then linear interpolation at the new
 * rate. Streaming: blocks of any size, no state lost between them.
 */
export class Downsampler {
  private readonly taps: Float32Array;
  private readonly hist: Float32Array;
  private hi = 0;
  private readonly step: number;
  /** Position of the next output sample; index 0 = the previous block's last filtered sample. */
  private t = 1;
  private last = 0;

  constructor(inRate: number, outRate = 16_000, nTaps = 31) {
    this.step = inRate / outRate;
    if (inRate <= outRate * 1.01) {
      this.taps = new Float32Array([1]);
    } else {
      const fc = (0.45 * outRate) / inRate;
      const m = (nTaps - 1) / 2;
      const taps = new Float32Array(nTaps);
      let sum = 0;
      for (let k = 0; k < nTaps; k++) {
        const x = k - m;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (nTaps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (nTaps - 1));
        taps[k] = sinc * w;
        sum += taps[k]!;
      }
      for (let k = 0; k < nTaps; k++) taps[k]! /= sum;
      this.taps = taps;
    }
    this.hist = new Float32Array(this.taps.length);
  }

  push(input: Float32Array): Float32Array {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    const N = this.taps.length;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.hist[this.hi] = input[i]!;
      this.hi = (this.hi + 1) % N;
      let acc = 0;
      for (let k = 0; k < N; k++) acc += this.taps[k]! * this.hist[(this.hi - 1 - k + N * 2) % N]!;
      f[i] = acc;
    }
    const out: number[] = [];
    while (this.t < n) {
      const i0 = Math.floor(this.t);
      const frac = this.t - i0;
      const a = i0 === 0 ? this.last : f[i0 - 1]!;
      const b = f[i0]!;
      out.push(a + (b - a) * frac);
      this.t += this.step;
    }
    this.t -= n;
    this.last = f[n - 1]!;
    return Float32Array.from(out);
  }
}

/** Float samples → 16-bit little-endian PCM (clipped). */
export function toInt16(s: Float32Array): Int16Array {
  const o = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(s[i]! * 32767)));
  return o;
}

/** 16-bit little-endian PCM → float samples. */
export function fromInt16(b: ArrayBuffer): Float32Array {
  const v = new DataView(b);
  const n = Math.floor(b.byteLength / 2);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = v.getInt16(i * 2, true) / 32768;
  return o;
}
