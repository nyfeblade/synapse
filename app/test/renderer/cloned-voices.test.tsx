import { describe, expect, it, vi } from "vitest";
import { encodeSamples, levelOf, toClipRate } from "../../src/renderer/voice/cloned-voices";
import { CLIP_SAMPLE_RATE } from "@synapse/shared";

describe("handing a take to the main process", () => {
  it("encodes float samples losslessly", () => {
    const pcm = Float32Array.from([0, 0.5, -0.25, 1, -1]);
    const b64 = encodeSamples(pcm);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(new Float32Array(bytes.buffer)).toEqual(pcm);
  });

  it("measures a block's level for the meter", () => {
    expect(levelOf(new Float32Array(100))).toBe(0);
    expect(levelOf(Float32Array.from([1, -1, 1, -1]))).toBeCloseTo(1, 5);
  });
});

describe("sample rate", () => {
  it("leaves 24 kHz alone", () => {
    const pcm = Float32Array.from([1, 2, 3, 4]);
    expect(toClipRate(pcm, CLIP_SAMPLE_RATE)).toBe(pcm);
  });

  it("drops 48 kHz down to 24 kHz", () => {
    const pcm = new Float32Array(48_000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 100 * i) / 48_000);
    const out = toClipRate(pcm, 48_000);
    expect(out.length).toBe(24_000);
  });

  it("never upsamples a worse capture — that would invent what the mic never heard", () => {
    const pcm = new Float32Array(16_000);
    expect(toClipRate(pcm, 16_000).length).toBe(16_000);
  });
});

describe("the recorder's capture settings", () => {
  it("asks for 24 kHz mono with every kind of voice processing turned off", async () => {
    const { openRecorder } = await import("../../src/renderer/voice/cloned-voices");
    let asked: MediaStreamConstraints | null = null;
    const track = { stop: vi.fn() };
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => { asked = c; return { getTracks: () => [track] } as unknown as MediaStream; });
    const node = { onaudioprocess: null as unknown, connect: vi.fn(), disconnect: vi.fn() };
    const makeContext = () => ({
      sampleRate: CLIP_SAMPLE_RATE,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createScriptProcessor: () => node,
      destination: {},
      resume: vi.fn(),
      close: vi.fn(),
    }) as unknown as AudioContext;

    const r = await openRecorder({ deviceId: "mic-1", getUserMedia, makeContext });
    const audio = (asked as unknown as { audio: Record<string, unknown> }).audio;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
    expect(audio.channelCount).toBe(1);
    expect(audio.sampleRate).toBe(CLIP_SAMPLE_RATE);
    expect(audio.deviceId).toEqual({ exact: "mic-1" });
    expect(r.sampleRate).toBe(CLIP_SAMPLE_RATE);

    r.recorder.close();
    expect(track.stop).toHaveBeenCalled();
  });

  it("collects what was captured and stops collecting once stopped", async () => {
    const { openRecorder } = await import("../../src/renderer/voice/cloned-voices");
    const node = { onaudioprocess: null as ((e: unknown) => void) | null, connect: vi.fn(), disconnect: vi.fn() };
    const makeContext = () => ({
      sampleRate: CLIP_SAMPLE_RATE,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createScriptProcessor: () => node,
      destination: {}, resume: vi.fn(), close: vi.fn(),
    }) as unknown as AudioContext;
    const r = await openRecorder({
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream),
      makeContext,
    });
    const block = (v: number) => ({ inputBuffer: { getChannelData: () => Float32Array.from([v, v, v, v]) } });
    node.onaudioprocess?.(block(0.1));           // before start(): ignored
    await r.recorder.start();
    node.onaudioprocess?.(block(0.2));
    node.onaudioprocess?.(block(0.3));
    const out = r.recorder.stop();
    expect(out.length).toBe(8);
    expect(out[0]).toBeCloseTo(0.2, 5);
    expect(out[4]).toBeCloseTo(0.3, 5);
    node.onaudioprocess?.(block(0.9));           // after stop(): ignored
    expect(r.recorder.stop().length).toBe(8);
    r.recorder.close();
  });
});
