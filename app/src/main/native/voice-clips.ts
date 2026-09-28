/**
 * The reference clips behind cloned voices: trimming a take, writing it as a 24 kHz mono
 * WAV under the app's data dir, and the IPC the recorder in Settings → Voice calls.
 *
 * The recorder captures in the renderer with voice processing off — echo cancellation,
 * noise suppression and automatic gain would each colour the voice a clone is supposed
 * to copy — and hands the raw float samples here. The Swift helper's microphone path is
 * not involved, so dictation and calls are untouched.
 *
 * Only the user's own voice, or one they have permission to use: CLONE_RIGHTS_NOTE says
 * so wherever a clip is recorded, and nothing here ever leaves the Mac.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CLIP_SAMPLE_RATE, checkClip, clipPasses, measureClip, type ClipCheck, type ClipMeasure,
} from "@synapse/shared";
import { registerNative } from "../native";
import {
  deleteProfile, listProfiles, readProfile, renameProfile, saveProfile, toView, voiceIdFor,
  voicesDir, type F5VoiceView,
} from "./f5";

/** A take is capped well above the longest script, so a stuck recorder cannot fill the disk. */
const MAX_SECONDS = 30;

// ---------------------------------------------------------------- WAV

/** 24 kHz mono 16-bit PCM — what F5 conditions on and what the helper plays. */
export function wavEncode(pcm: Float32Array, sampleRate = CLIP_SAMPLE_RATE): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);            // PCM
  out.writeUInt16LE(1, 22);            // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return out;
}

/** Read back a 24 kHz mono 16-bit WAV this module wrote. */
export function wavDecode(buf: Buffer): { pcm: Float32Array; sampleRate: number } | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let at = 12;
  let sampleRate = CLIP_SAMPLE_RATE;
  let bits = 16;
  let channels = 1;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) return null;
      const n = Math.floor(Math.min(size, buf.length - body) / 2);
      const pcm = new Float32Array(Math.floor(n / channels));
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(body + i * channels * 2) / 32768;
      return { pcm, sampleRate };
    }
    at = body + size + (size % 2);
  }
  return null;
}

// ---------------------------------------------------------------- trimming

/**
 * Drop the silence before the first word and after the last, cutting at a zero crossing
 * so the clip cannot start or end on a click. The words themselves are never touched:
 * the search only moves outward from the speech.
 */
export function trimSilence(pcm: Float32Array, sampleRate = CLIP_SAMPLE_RATE): Float32Array {
  const block = Math.max(1, Math.round((sampleRate * 10) / 1000));
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak === 0) return pcm;
  const gate = peak * 0.04;
  const loudAt = (b: number): boolean => {
    let s = 0;
    const from = b * block;
    const to = Math.min(pcm.length, from + block);
    for (let i = from; i < to; i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / Math.max(1, to - from)) >= gate;
  };
  const blocks = Math.floor(pcm.length / block);
  let first = 0;
  while (first < blocks && !loudAt(first)) first++;
  let last = blocks - 1;
  while (last > first && !loudAt(last)) last--;
  if (first >= blocks) return pcm;
  // keep 30 ms of room either side, then slide to the nearest zero crossing
  const pad = Math.round((sampleRate * 30) / 1000);
  let from = Math.max(0, first * block - pad);
  let to = Math.min(pcm.length, (last + 1) * block + pad);
  const zero = (i: number, dir: number): number => {
    const limit = Math.round((sampleRate * 5) / 1000);
    for (let k = 0; k < limit; k++) {
      const j = i + k * dir;
      if (j <= 0 || j >= pcm.length - 1) break;
      if ((pcm[j] <= 0 && pcm[j + 1] > 0) || (pcm[j] >= 0 && pcm[j + 1] < 0)) return j;
    }
    return i;
  };
  from = zero(from, 1);
  to = zero(to, -1);
  return to > from ? pcm.slice(from, to) : pcm;
}

export function rmsOf(pcm: Float32Array): number {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / Math.max(1, pcm.length));
}

// ---------------------------------------------------------------- the take

export interface TakeResult {
  ok: boolean;
  seconds: number;
  measure: ClipMeasure;
  checks: ClipCheck[];
}

/** Trim a take and judge it, without saving anything. */
export function judgeTake(pcm: Float32Array, sampleRate = CLIP_SAMPLE_RATE): TakeResult & { pcm: Float32Array } {
  const trimmed = trimSilence(pcm, sampleRate);
  const measure = measureClip(trimmed, sampleRate);
  const checks = checkClip(measure);
  return { ok: clipPasses(checks), seconds: measure.seconds, measure, checks, pcm: trimmed };
}

// ---------------------------------------------------------------- IPC

export interface VoiceClipsApi { dir: string; refresh(): F5VoiceView[] }

export function registerVoiceClips(o: {
  userData: string; log: (line: string) => void; changed?: () => void;
}): VoiceClipsApi {
  const dir = voicesDir(o.userData);
  fs.mkdirSync(dir, { recursive: true });

  const samples = (a: unknown): Float32Array | null => {
    if (typeof a !== "string") return null;
    const raw = Buffer.from(a, "base64");
    if (raw.length < 8 || raw.length % 4 !== 0) return null;
    if (raw.length / 4 > CLIP_SAMPLE_RATE * MAX_SECONDS) return null;
    const pcm = new Float32Array(raw.length / 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readFloatLE(i * 4);
    return pcm;
  };

  registerNative("voice.clips.list", async () => ({ voices: listProfiles(dir).map(toView) }));

  /** Judge a take and hand the marks back, so the recorder can offer a Retake before saving. */
  registerNative("voice.clips.check", async (a: { pcm?: unknown } | undefined) => {
    const pcm = samples(a?.pcm);
    if (!pcm) throw new Error("That recording couldn't be read.");
    const { ok, seconds, measure, checks } = judgeTake(pcm);
    return { ok, seconds, measure, checks };
  });

  /**
   * Save a take as a voice. The transcript is required and stored exactly as given —
   * punctuation, capitals and all — because it is what F5 conditions on.
   */
  registerNative("voice.clips.save", async (a: { pcm?: unknown; name?: unknown; transcript?: unknown; scriptId?: unknown; id?: unknown } | undefined) => {
    const pcm = samples(a?.pcm);
    if (!pcm) throw new Error("That recording couldn't be read.");
    const transcript = typeof a?.transcript === "string" ? a.transcript.trim() : "";
    if (!transcript) throw new Error("A cloned voice needs the words the clip says.");
    const name = (typeof a?.name === "string" ? a.name : "").trim() || "My voice";
    const { checks, pcm: trimmed, measure } = judgeTake(pcm);
    const id = typeof a?.id === "string" && readProfile(dir, a.id) ? a.id : voiceIdFor(dir, name);
    const p = saveProfile(dir, {
      id, name, transcript,
      scriptId: typeof a?.scriptId === "string" ? a.scriptId : "own",
      wav: wavEncode(trimmed),
      loudness: rmsOf(trimmed),
      checks,
    });
    o.log(`voice clip: saved "${p.name}" (${id}, ${measure.seconds.toFixed(1)}s)`);
    o.changed?.();
    return { voice: toView(p) };
  });

  registerNative("voice.clips.rename", async (a: { id?: unknown; name?: unknown } | undefined) => {
    if (typeof a?.id !== "string" || typeof a?.name !== "string") throw new Error("That voice couldn't be renamed.");
    const p = renameProfile(dir, a.id, a.name.trim());
    if (!p) throw new Error("That voice no longer exists.");
    o.changed?.();
    return { voice: toView(p) };
  });

  registerNative("voice.clips.delete", async (a: { id?: unknown } | undefined) => {
    if (typeof a?.id !== "string") throw new Error("That voice couldn't be deleted.");
    const gone = deleteProfile(dir, a.id);
    if (gone) o.log(`voice clip: deleted ${a.id}`);
    o.changed?.();
    return { deleted: gone };
  });

  /** The saved reference itself, so the recorder can A/B it against a cloned preview. */
  registerNative("voice.clips.read", async (a: { id?: unknown } | undefined) => {
    if (typeof a?.id !== "string" || !readProfile(dir, a.id)) throw new Error("That voice no longer exists.");
    const wav = fs.readFileSync(path.join(dir, a.id, "clip.wav"));
    return { wav: wav.toString("base64") };
  });

  return { dir, refresh: () => listProfiles(dir).map(toView) };
}
