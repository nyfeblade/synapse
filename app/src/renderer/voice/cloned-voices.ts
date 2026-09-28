/**
 * Cloned voices in the renderer: the saved list, and recording a take.
 *
 * Recording happens here rather than in the Swift helper so the helper's microphone path
 * — dictation, calls, the wake word — is untouched. Voice processing is turned off for
 * the take: echo cancellation, noise suppression and automatic gain each colour a voice,
 * and a clone copies whatever it is given.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CLIP_SAMPLE_RATE, CLIP_MAX_S, type ClipCheck, type ClipMeasure } from "@synapse/shared";
import { nativeCall } from "../native";

export interface ClonedVoiceView { id: string; name: string; createdAt: string; scriptId: string }

export interface TakeVerdict { ok: boolean; seconds: number; measure: ClipMeasure; checks: ClipCheck[] }

/** The saved cloned voices, refreshed whenever one is added, renamed or removed. */
export function useClonedVoices(): { voices: ClonedVoiceView[]; reload: () => void } {
  const [voices, setVoices] = useState<ClonedVoiceView[]>([]);
  const reload = useCallback(() => {
    void nativeCall<{ voices?: ClonedVoiceView[] }>("voice.clips.list")
      .then((r) => setVoices(Array.isArray(r?.voices) ? r.voices : []), () => setVoices([]));
  }, []);
  useEffect(reload, [reload]);
  return { voices, reload };
}

/** Float32 samples → base64, the shape the main process reads a take in. */
export function encodeSamples(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Average absolute level of a block, for the meter. */
export function levelOf(block: Float32Array): number {
  let s = 0;
  for (let i = 0; i < block.length; i++) s += block[i] * block[i];
  return Math.sqrt(s / Math.max(1, block.length));
}

export interface Recorder {
  start(deviceId?: string | null): Promise<void>;
  stop(): Float32Array;
  close(): void;
}

/**
 * Capture 24 kHz mono float samples, with voice processing off.
 *
 * The AudioContext is asked for 24 kHz directly so nothing is resampled up from a worse
 * rate; when the device refuses, `sampleRate` says what was actually captured and the
 * caller resamples down (never up).
 */
export async function openRecorder(o: {
  deviceId?: string | null;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  makeContext?: (rate: number) => AudioContext;
} = {}): Promise<{ recorder: Recorder; sampleRate: number; onBlock: (fn: (level: number, seconds: number) => void) => void }> {
  const gum = o.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  const stream = await gum({
    audio: {
      ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}),
      // Off, all three: a clone copies whatever colouring it is given.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: CLIP_SAMPLE_RATE,
    } as MediaTrackConstraints,
  });
  const ctx = (o.makeContext ?? ((rate: number) => new AudioContext({ sampleRate: rate })))(CLIP_SAMPLE_RATE);
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const blocks: Float32Array[] = [];
  let total = 0;
  let watcher: ((level: number, seconds: number) => void) | null = null;
  let recording = false;
  node.onaudioprocess = (e) => {
    if (!recording) return;
    const b = e.inputBuffer.getChannelData(0);
    if (total / ctx.sampleRate >= CLIP_MAX_S + 5) return; // a stuck recorder cannot fill memory
    const copy = new Float32Array(b.length);
    copy.set(b);
    blocks.push(copy);
    total += copy.length;
    watcher?.(levelOf(copy), total / ctx.sampleRate);
  };
  source.connect(node);
  node.connect(ctx.destination);

  const recorder: Recorder = {
    async start() { blocks.length = 0; total = 0; recording = true; await ctx.resume?.(); },
    stop() {
      recording = false;
      const out = new Float32Array(total);
      let at = 0;
      for (const b of blocks) { out.set(b, at); at += b.length; }
      return out;
    },
    close() {
      recording = false;
      node.onaudioprocess = null;
      try { node.disconnect(); source.disconnect(); } catch { /* already gone */ }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close?.();
    },
  };
  return { recorder, sampleRate: ctx.sampleRate, onBlock: (fn) => { watcher = fn; } };
}

/**
 * Drop to 24 kHz when the device would only give a higher rate. Never the other way:
 * upsampling a 16 kHz capture would not add back what the microphone never heard.
 */
export function toClipRate(pcm: Float32Array, from: number): Float32Array {
  if (from === CLIP_SAMPLE_RATE || from <= 0) return pcm;
  if (from < CLIP_SAMPLE_RATE) return pcm; // worse than 24 kHz: keep it, and let the checks judge
  const ratio = from / CLIP_SAMPLE_RATE;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const j = Math.floor(at);
    const f = at - j;
    out[i] = j + 1 < pcm.length ? pcm[j] * (1 - f) + pcm[j + 1] * f : pcm[j] ?? 0;
  }
  return out;
}

/** Ask the main process to judge a take, without saving it. */
export function checkTake(pcm: Float32Array): Promise<TakeVerdict> {
  return nativeCall<TakeVerdict>("voice.clips.check", { pcm: encodeSamples(pcm) });
}

export function saveTake(o: { pcm: Float32Array; name: string; transcript: string; scriptId: string; id?: string }): Promise<{ voice: ClonedVoiceView }> {
  return nativeCall<{ voice: ClonedVoiceView }>("voice.clips.save", {
    pcm: encodeSamples(o.pcm), name: o.name, transcript: o.transcript, scriptId: o.scriptId, ...(o.id ? { id: o.id } : {}),
  });
}

/** Keeps the live elapsed/level readings a recorder UI shows, without re-rendering per block. */
export function useMeter(): { level: number; seconds: number; set: (l: number, s: number) => void; reset: () => void } {
  const [state, setState] = useState({ level: 0, seconds: 0 });
  const last = useRef(0);
  const set = useCallback((level: number, seconds: number) => {
    const now = Date.now();
    if (now - last.current < 60) return; // ~16 fps is plenty for a meter
    last.current = now;
    setState({ level, seconds });
  }, []);
  const reset = useCallback(() => { last.current = 0; setState({ level: 0, seconds: 0 }); }, []);
  return { ...state, set, reset };
}
