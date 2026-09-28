import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bug 198: everything the phone e2e needs made once, before the browsers start: the phone client
 * build, the real dictation helper compiled from THIS tree (no code signing — the linker's ad hoc
 * signature runs it), a self-signed certificate for the stand-in of `tailscale serve`, and the
 * speech the fake microphones play (synthesised with macOS `say`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, "..");
export const REPORT = path.resolve(APP, "..", "test-reports", "tailscale-phone");
export const WORK = path.join(os.tmpdir(), "synapse-phone-e2e");
export const SPEECH_WAV = path.join(WORK, "speech-v2.wav");
export const CLIENT_DIR = path.join(WORK, "phone");
export const CERT = { key: path.join(WORK, "key.pem"), cert: path.join(WORK, "cert.pem") };

/** When each phrase starts in speech.wav (s), measured when it is made. */
export const PHRASES = [
  { at: 4.5, text: "Hello Nova, what is the weather like in Paris today?" },
  { at: 17, text: "Wait, stop. What about London instead?" },
] as const;

function helperPath(): string {
  const src = fs.readFileSync(path.join(APP, "native", "dictation", "Dictation.swift"));
  return path.join(WORK, `bots-dictation-${createHash("sha256").update(src).digest("hex").slice(0, 12)}`);
}

export function helperBinary(): string {
  return process.env.PHONE_E2E_HELPER ?? helperPath();
}

function buildHelper(): void {
  const out = helperPath();
  if (process.env.PHONE_E2E_HELPER || fs.existsSync(out)) return;
  const dir = path.join(APP, "native", "dictation");
  const root = path.join(os.homedir(), "Library", "Application Support", "Synapse", "whisper");
  const whisper = fs.existsSync(path.join(root, "lib", "libwhisper.a")) && fs.existsSync(path.join(root, "include", "whisper.h"))
    ? ["-D", "WHISPER", "-import-objc-header", path.join(dir, "whisper-bridge.h"), "-I", path.join(root, "include"), "-L", path.join(root, "lib"),
      "-lwhisper", "-lggml", "-lggml-cpu", "-lggml-blas", "-lggml-metal", "-lggml-base", "-lc++", "-framework", "Metal", "-framework", "MetalKit", "-framework", "Accelerate"]
    : [];
  execFileSync("swiftc", ["-O", path.join(dir, "Dictation.swift"), "-o", `${out}.tmp`, "-framework", "Speech", "-framework", "AVFoundation", ...whisper,
    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", path.join(dir, "Info.plist")], { stdio: "inherit", timeout: 600_000 });
  fs.renameSync(`${out}.tmp`, out);
}

/** 16-bit mono PCM of a phrase at `rate`, via `say` (AIFF) → afconvert (WAV). */
function sayPcm(text: string, rate: number): Buffer {
  const aiff = path.join(WORK, `say-${createHash("sha1").update(text).digest("hex").slice(0, 8)}.aiff`);
  const wav = `${aiff}.wav`;
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text], { timeout: 60_000 });
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${rate}`, "-c", "1", aiff, wav], { timeout: 60_000 });
  const b = fs.readFileSync(wav);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === "data") return b.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  throw new Error("no data chunk");
}

export function wavFile(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Phrase 1 at 4.5 s (after the pick-up greeting), phrase 2 at 17 s (over the Bot's long answer: the barge-in), then a minute of room quiet. */
function makeSpeech(): void {
  if (fs.existsSync(SPEECH_WAV)) return;
  const rate = 48_000;
  const total = Buffer.alloc(rate * 2 * 80);
  for (const p of PHRASES) {
    const pcm = sayPcm(p.text, rate);
    pcm.copy(total, Math.round(p.at * rate) * 2);
  }
  fs.writeFileSync(SPEECH_WAV, wavFile(total, rate));
}

function makeCert(): void {
  if (fs.existsSync(CERT.cert)) return;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", CERT.key, "-out", CERT.cert, "-days", "3", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 60_000 });
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.join(REPORT, "screens"), { recursive: true });
  const { buildPhone } = await import("../scripts/build-phone.mjs");
  await buildPhone(CLIENT_DIR, { minify: false });
  makeCert();
  makeSpeech();
  buildHelper();
}
