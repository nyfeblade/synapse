import { Downsampler, toInt16 } from "./resample";

/**
 * Bug 198: the phone's microphone capture, on the audio thread: the echo-cancelled input from
 * getUserMedia, down to 16 kHz mono 16-bit, posted to the page in 100 ms chunks (the page sends them
 * over the call socket). The peak of each chunk rides along for the call screen's meter.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const CHUNK = 1600;

class MicCapture extends AudioWorkletProcessor {
  private ds = new Downsampler(sampleRate, 16_000);
  private buf = new Float32Array(CHUNK);
  private fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0];
    const ch = chans?.[0];
    if (!ch) return true;
    let mono = ch;
    if (chans.length > 1 && chans[1]) {
      mono = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) mono[i] = (ch[i]! + chans[1]![i]!) / 2;
    }
    const out = this.ds.push(mono);
    for (let i = 0; i < out.length; i++) {
      this.buf[this.fill++] = out[i]!;
      if (this.fill === CHUNK) {
        let peak = 0;
        for (let k = 0; k < CHUNK; k++) peak = Math.max(peak, Math.abs(this.buf[k]!));
        const pcm = toInt16(this.buf);
        this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
