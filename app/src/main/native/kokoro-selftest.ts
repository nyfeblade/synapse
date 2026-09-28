import fs from "node:fs";
import path from "node:path";
import { findKokoro, KokoroSidecar, probeKokoro, type KokoroEngine } from "./kokoro";

/**
 * Portable install: SYNAPSE_KOKORO_SELFTEST=<out.wav> makes the (packaged) app find Kokoro exactly the
 * way a call does — bundled runtime first — say one line through the real sidecar, write the PCM to a
 * WAV and exit. No window, no host, no audio device: it proves the shipped bundle speaks on its own.
 */
export const SELFTEST_ENV = "SYNAPSE_KOKORO_SELFTEST";

export interface SelfTestResult { ok: boolean; source: KokoroEngine["source"] | null; python: string | null; seconds: number; rms: number; ms: number; reason?: string }

export function wav16(pcmF32: Buffer, rate = 24_000): Buffer {
  const n = pcmF32.length / 4;
  const s16 = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) s16.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcmF32.readFloatLE(i * 4) * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + s16.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(s16.length, 40);
  return Buffer.concat([h, s16]);
}

export function rmsOf(pcmF32: Buffer): number {
  const n = pcmF32.length / 4;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcmF32.readFloatLE(i * 4); sum += v * v; }
  return Math.sqrt(sum / n);
}

export async function kokoroSelfTest(o: {
  out: string; script: string; bundled: string | null; userData: string; log: (l: string) => void;
  text?: string; settings?: { python?: string | null; modelDir?: string | null };
}): Promise<SelfTestResult> {
  const started = Date.now();
  const engine = findKokoro({ bundled: o.bundled, userData: o.userData, exists: (p) => fs.existsSync(p), settings: o.settings });
  const fail = (reason: string): SelfTestResult => ({ ok: false, source: engine?.source ?? null, python: engine?.python ?? null, seconds: 0, rms: 0, ms: Date.now() - started, reason });
  if (!engine) return fail("no Kokoro runtime found");
  const cacheDir = path.join(o.userData, "kokoro-cache");
  const probe = await probeKokoro(engine, { cacheDir });
  o.log(`kokoro: probe ${probe.ok ? "ok" : "failed"} in ${probe.ms} ms (${engine.source}: ${engine.python})${probe.reason ? `: ${probe.reason}` : ""}`);
  if (!probe.ok) return fail(probe.reason ?? "probe failed");
  const side = new KokoroSidecar({ engine, script: o.script, log: o.log, cacheDir, idleMs: 120_000, stallMs: 60_000 });
  try {
    if (!(await side.whenWarm(180_000))) return fail("the sidecar never warmed up");
    const pcm: Buffer[] = [];
    await new Promise<void>((resolve, reject) => side.synth(
      { id: "selftest", text: o.text ?? "Hello from Synapse. This voice ships inside the app.", voice: "af_heart", speed: 1 },
      { audio: (b) => pcm.push(Buffer.from(b)), done: () => resolve(), error: (m) => reject(new Error(m)) },
    ));
    const all = Buffer.concat(pcm);
    fs.writeFileSync(o.out, wav16(all));
    return { ok: true, source: engine.source, python: engine.python, seconds: all.length / 4 / 24_000, rms: rmsOf(all), ms: Date.now() - started };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    side.dispose();
  }
}
