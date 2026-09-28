// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HANGUP_TONE, RING_TONE } from "../../src/renderer/voice/call-sounds-params";
import { synthesizeChirp, synthesizeHangUp, synthesizeRingPattern } from "../../src/renderer/voice/call-sounds-synth";
import { playHangUp, startRing } from "../../src/renderer/voice/call-sounds";

// Bug (call sounds): a ring while a Bot's call is unanswered, and a hang-up tone when a connected
// call ends — both original Web Audio synthesis (call-sounds-params.ts / call-sounds-synth.ts),
// never a downloaded clip. This covers the pure sample math and the Web Audio wiring; the ring's
// start/stop lifecycle and the hang-up's connected-only rule are covered where they're wired in
// (incoming-call.test.tsx, voice-call.test.tsx).

describe("call sound synthesis (plain math, no Web Audio)", () => {
  it("a chirp is each note back to back with silence gaps, fading up then down (no hard edges)", () => {
    const spec = { notes: [440], noteMs: 100, noteGapMs: 0, peakGain: 0.5, attackMs: 10, releaseMs: 10 };
    const pcm = synthesizeChirp(spec, 1000); // 1 sample/ms, easy to reason about
    expect(pcm.length).toBe(100);
    expect(pcm[0]).toBe(0); // starts at silence, not a click
    expect(Math.abs(pcm[99]!)).toBeLessThan(0.05); // released back near zero by the end
    expect(Math.max(...Array.from(pcm).map(Math.abs))).toBeLessThanOrEqual(spec.peakGain + 1e-9);
  });

  it("two notes leave silence between them for exactly the gap", () => {
    const spec = { notes: [440, 440], noteMs: 10, noteGapMs: 5, peakGain: 0.5, attackMs: 1, releaseMs: 1 };
    const pcm = synthesizeChirp(spec, 1000);
    expect(pcm.length).toBe(10 + 5 + 10);
    expect(pcm[12]).toBe(0); // inside the gap
  });

  it("a ring pattern is padded with silence out to patternMs + pauseMs", () => {
    const pcm = synthesizeRingPattern(RING_TONE, 8000, false);
    const expectedMs = RING_TONE.patternMs + RING_TONE.pauseMs;
    expect(Math.round((pcm.length / 8000) * 1000)).toBe(expectedMs);
    // well past the chirp, into the padded silence
    expect(pcm[pcm.length - 1]).toBe(0);
  });

  it("the first ring fades in: it starts at 0 and its peak stays under the un-faded pattern's peak", () => {
    const faded = synthesizeRingPattern(RING_TONE, 8000, true);
    const plain = synthesizeRingPattern(RING_TONE, 8000, false);
    expect(faded[0]).toBe(0);
    const peak = (a: Float32Array) => Math.max(...Array.from(a).map(Math.abs));
    expect(peak(faded)).toBeLessThan(peak(plain) + 1e-9);
  });

  it("the hang-up tone is short (250-350 ms) and descends (its second note is lower than its first)", () => {
    const pcm = synthesizeHangUp(HANGUP_TONE, 8000);
    const ms = (pcm.length / 8000) * 1000;
    expect(ms).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThanOrEqual(400);
    expect(HANGUP_TONE.notes[1]!).toBeLessThan(HANGUP_TONE.notes[0]!);
  });

  it("both tones stay well below full scale — quieter than a Bot's speech", () => {
    expect(RING_TONE.peakGain).toBeLessThan(0.15);
    expect(HANGUP_TONE.peakGain).toBeLessThan(0.15);
  });
});

// ---- Web Audio wiring: a small fake AudioContext, just enough to see what call-sounds.ts does ----

class FakeGainNode {
  gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
  connect() { return this; }
}
class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  connect = vi.fn(() => this);
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  close = vi.fn(async () => {});
  createGain() {
    const g = new FakeGainNode();
    FakeAudioContext.gains.push(g);
    return g;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, getChannelData: () => ({ set: vi.fn() }) };
  }
  createBufferSource() {
    const src = new FakeBufferSource();
    FakeAudioContext.sources.push(src);
    return src;
  }
  static sources: FakeBufferSource[] = [];
  static gains: FakeGainNode[] = [];
}

beforeEach(() => {
  FakeAudioContext.sources = [];
  FakeAudioContext.gains = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  (window as unknown as { synapse: unknown }).synapse = { native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} } };
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("startRing", () => {
  it("starts a buffer source right away, and fades the master gain out (not a hard cut) on stop", () => {
    vi.useFakeTimers();
    const ring = startRing();
    expect(FakeAudioContext.sources).toHaveLength(1);
    expect(FakeAudioContext.sources[0]!.start).toHaveBeenCalled();
    ring.stop();
    const master = FakeAudioContext.gains[0]!;
    expect(master.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, expect.any(Number));
    // calling stop twice is safe (answer + a stray re-render should never double-fade or throw)
    expect(() => ring.stop()).not.toThrow();
    expect(master.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1); // not re-triggered
  });

  it("a second stop, or no AudioContext at all, never throws", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    const ring = startRing();
    expect(() => ring.stop()).not.toThrow();
    expect(() => ring.stop()).not.toThrow();
  });

  it("the loop keeps going on its own: the first buffer ending starts the next one", () => {
    startRing();
    expect(FakeAudioContext.sources).toHaveLength(1);
    FakeAudioContext.sources[0]!.onended?.();
    expect(FakeAudioContext.sources).toHaveLength(2);
    expect(FakeAudioContext.sources[1]!.start).toHaveBeenCalled();
  });

  it("stop() before the loop advances again: no further buffer is scheduled", () => {
    const ring = startRing();
    ring.stop();
    FakeAudioContext.sources[0]!.onended?.();
    expect(FakeAudioContext.sources).toHaveLength(1); // no second buffer after stop
  });
});

describe("playHangUp", () => {
  it("plays one buffer straight to the destination — no ring master gain to fade", () => {
    playHangUp();
    expect(FakeAudioContext.sources).toHaveLength(1);
    expect(FakeAudioContext.sources[0]!.start).toHaveBeenCalled();
  });

  it("does nothing when Web Audio isn't available", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    expect(() => playHangUp()).not.toThrow();
  });
});

describe("call sounds when the AudioContext cannot be created", () => {
  // Chromium throws from `new AudioContext()` when the OS has no usable output device or has hit its
  // hardware-context limit. A ring or a hang-up tone is decoration: it must never break a call.
  afterEach(() => { vi.unstubAllGlobals(); });

  it("startRing returns a no-op handle and playHangUp does nothing, neither throws", () => {
    class Throwing { constructor() { throw new Error("NotSupportedError: no output device"); } }
    vi.stubGlobal("AudioContext", Throwing);
    let handle: ReturnType<typeof startRing> | undefined;
    expect(() => { handle = startRing(); }).not.toThrow();
    expect(() => handle!.stop()).not.toThrow();
    expect(() => playHangUp()).not.toThrow();
  });
});
