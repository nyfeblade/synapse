/**
 * The two call sounds — a ring while a Bot's call sits unanswered, and a short tone when a call
 * that connected ends. Both are synthesized with Web Audio from call-sounds-params.ts (see there
 * for the "original tone, not a copy" note); nothing is a downloaded or recorded clip.
 *
 * Gated by Settings → Voice, "Call sounds" (calls.sounds.get/set — default on; the same setting
 * that already covers a group call's join / leave chime).
 */
import { useEffect, useState } from "react";
import { HANGUP_TONE, RING_TONE } from "./call-sounds-params";
import { synthesizeHangUp, synthesizeRingPattern } from "./call-sounds-synth";
import { nativeCall } from "../native";

function audioContextCtor(): typeof AudioContext | null {
  return (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ?? null;
}

function bufferFrom(ctx: AudioContext, pcm: Float32Array): AudioBuffer {
  const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
  // `.set()` takes any ArrayLike<number>, sidestepping the ArrayBuffer/SharedArrayBuffer generic
  // mismatch `copyToChannel` has with a plain `Float32Array` under the current DOM lib types.
  buf.getChannelData(0).set(pcm);
  return buf;
}

/**
 * Best effort: if the browser supports routing an AudioContext to a chosen output device
 * (`setSinkId`) and the user picked a non-default one in Settings → Voice, matches it by name
 * against `navigator.mediaDevices` and switches to it. Silently does nothing otherwise — this is a
 * nice-to-have, never a reason for a call sound to fail or delay.
 */
async function routeToPreferredDevice(ctx: AudioContext): Promise<void> {
  const withSink = ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== "function") return;
  try {
    const r = await nativeCall<{ devices?: { uid: string; name: string; output?: boolean }[]; prefs?: { output: string | null } }>("audio.devices.list");
    const uid = r?.prefs?.output;
    if (!uid) return; // "" / null = system default, which is already where the context plays
    const wanted = r?.devices?.find((d) => d.uid === uid);
    if (!wanted || !navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const match = list.find((d) => d.kind === "audiooutput" && d.label && wanted.name && d.label.includes(wanted.name));
    if (match) await withSink.setSinkId(match.deviceId);
  } catch {
    // Best effort only: the sound still plays on the system default device.
  }
}

/** Settings → Voice, "Call sounds" (default on). Both the ring and the hang-up tone honor it. */
export function useCallSoundsEnabled(): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let live = true;
    void nativeCall<{ on?: boolean }>("calls.sounds.get").then((r) => { if (live) setOn(r?.on !== false); }, () => { if (live) setOn(true); });
    return () => { live = false; };
  }, []);
  return on;
}

export interface RingHandle {
  /** Fades out over RING_TONE.stopFadeMs and closes — never a hard cut. */
  stop(): void;
}

/**
 * Starts the ring: a soft chirp that fades in, repeats on a phone-like cadence, and keeps going
 * until `stop()` is called (answer, decline, timeout, or the call being withdrawn). A no-op handle
 * when Web Audio isn't available (e.g. under test).
 */
export function startRing(): RingHandle {
  const AC = audioContextCtor();
  if (!AC) return { stop() {} };
  // `new AudioContext()` throws when the OS has no usable output or the context limit is hit; the
  // ring is decoration and must never break the call.
  let ctx: AudioContext;
  try { ctx = new AC(); } catch { return { stop() {} }; }
  void routeToPreferredDevice(ctx);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  const firstBuffer = bufferFrom(ctx, synthesizeRingPattern(RING_TONE, ctx.sampleRate, true));
  const loopBuffer = bufferFrom(ctx, synthesizeRingPattern(RING_TONE, ctx.sampleRate, false));
  let stopped = false;
  const playOne = (buffer: AudioBuffer) => {
    if (stopped) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    src.onended = () => playOne(loopBuffer);
    src.start();
  };
  playOne(firstBuffer);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0, t + RING_TONE.stopFadeMs / 1000);
      } catch {
        // best effort — the context close below still silences it
      }
      setTimeout(() => void ctx.close().catch(() => {}), RING_TONE.stopFadeMs + 30);
    },
  };
}

/**
 * Plays once: a short descending two-note tone for a call that connected and then ended, whatever
 * the reason (the user, the Bot, or the connection itself). A no-op when Web Audio isn't available.
 */
export function playHangUp(): void {
  const AC = audioContextCtor();
  if (!AC) return;
  let ctx: AudioContext;
  try { ctx = new AC(); } catch { return; }
  void routeToPreferredDevice(ctx);
  const pcm = synthesizeHangUp(HANGUP_TONE, ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = bufferFrom(ctx, pcm);
  src.connect(ctx.destination);
  src.start();
  const totalMs = (pcm.length / ctx.sampleRate) * 1000 + 50;
  setTimeout(() => void ctx.close().catch(() => {}), totalMs);
}
