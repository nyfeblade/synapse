/**
 * Renders the app's two call sounds to WAV, for a quick listen outside the app. Same numbers, same
 * synthesis as what plays live (call-sounds-params.ts / call-sounds-synth.ts) — this script just
 * writes the PCM to disk instead of an AudioContext, so it needs neither Electron nor a browser.
 *
 * Run: node app/scripts/render-call-sounds.ts
 * Writes: test-reports/call-sounds/ring.wav, test-reports/call-sounds/hangup.wav
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HANGUP_TONE, RING_TONE } from "../src/renderer/voice/call-sounds-params.ts";
import { synthesizeHangUp, synthesizeRingPattern } from "../src/renderer/voice/call-sounds-synth.ts";

const SAMPLE_RATE = 44_100;

/** 16-bit PCM mono WAV — plain, no dependency, just for this script. */
function wavEncode(pcm: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test-reports", "call-sounds");
fs.mkdirSync(outDir, { recursive: true });

// The fade-in first ring, then one more so the file shows the repeating cadence.
const ring = concat(
  synthesizeRingPattern(RING_TONE, SAMPLE_RATE, true),
  synthesizeRingPattern(RING_TONE, SAMPLE_RATE, false),
);
fs.writeFileSync(path.join(outDir, "ring.wav"), wavEncode(ring, SAMPLE_RATE));

const hangup = synthesizeHangUp(HANGUP_TONE, SAMPLE_RATE);
fs.writeFileSync(path.join(outDir, "hangup.wav"), wavEncode(hangup, SAMPLE_RATE));

console.log(`Wrote ${path.join(outDir, "ring.wav")} (${(ring.length / SAMPLE_RATE).toFixed(2)}s)`);
console.log(`Wrote ${path.join(outDir, "hangup.wav")} (${(hangup.length / SAMPLE_RATE).toFixed(2)}s)`);
