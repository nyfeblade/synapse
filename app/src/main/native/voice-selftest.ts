import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LIMITS5, VOICE_SELFTEST, judgeSelfTest, selfTestSkip, type SelfTestReport, type SelfTestSkip } from "@synapse/shared";
import { SentenceChunker, speechText } from "../../renderer/voice/sentences";
import { parseDictationLine } from "./dictation";
import type { NaturalTts } from "./kokoro";

/**
 * 5.8: the nightly voice self-test. A scripted call through the real pipeline stages the app can run without a
 * microphone or a speaker: the real helper hears a fixture clip (synthetic speech, in the repo) at real-time pace
 * (`--file`), ends the turn and sends its final; the reply — a fixed line, so no model call and no tokens — goes
 * through the call's sentence chunker, the real natural voice (Kokoro) renders its first line, and the helper plays
 * it (a file session has no speaker: "first audio out" is the moment it would have). Every stage is timed from the
 * end of speech in the clip. It fails over its own budget (1.4 s: the pipeline it measures, not the 1.2 s call goal)
 * or 25% or more slower than its last 7 nights (`history`).
 */

export const SELFTEST_REPLY = "It's just after three in the afternoon there. Want me to set a reminder?";
/** The fixture's own words (the clip says this, in Kokoro's af_heart voice). */
export const SELFTEST_UTTERANCE = "What time is it in Tokyo right now?";

/** End of the last voiced stretch of a 16-bit mono WAV, in ms (20 ms frames over -42 dBFS; the turn-taking bench's rule). */
export function speechEndMs(wav: Buffer): number | null {
  let off = 12, data: Buffer | null = null, rate = 16_000;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4), n = wav.readUInt32LE(off + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(off + 12);
    if (id === "data") { data = wav.subarray(off + 8, off + 8 + n); break; }
    off += 8 + n + (n % 2);
  }
  if (!data) return null;
  const F = Math.round(rate / 50), n = Math.floor(data.length / 2);
  let last: number | null = null;
  for (let i = 0; i + F <= n; i += F) {
    let s = 0;
    for (let k = 0; k < F; k++) { const v = data.readInt16LE((i + k) * 2) / 32768; s += v * v; }
    if (10 * Math.log10(s / F + 1e-12) > -42) last = ((i + F) / rate) * 1000;
  }
  return last;
}

export interface SelfTestDeps {
  helper: string;
  clip: string;
  /** The natural voice (the app's own, kept hot); null or cold → the helper's Apple voice says the line. */
  tts: Pick<NaturalTts, "isWarm" | "synth" | "cancel"> | null;
  voice?: string;
  reply?: string;
  spawnFn?: typeof spawn;
  now?: () => number;
  log?: (l: string) => void;
  /** Stops the run at once (a call started). */
  signal?: AbortSignal;
  /** Earlier nights' first audio (ms), oldest first: the regression check's baseline. */
  history?: readonly number[];
  timeoutMs?: number;
}

export async function runVoiceSelfTest(d: SelfTestDeps): Promise<SelfTestReport> {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const stages: SelfTestReport["stages"] = { likelyEnd: null, sttFinal: null, firstToken: null, firstChunk: null, firstAudio: null };
  const report = (ok: boolean, tts: SelfTestReport["tts"], error?: string): SelfTestReport => judgeSelfTest({
    at: new Date(now()).toISOString(), ok, budgetMs: VOICE_SELFTEST.budgetMs, tts, scriptedReply: true, stages, ...(error ? { error } : {}),
  }, d.history ?? []);
  let endMs: number | null = null;
  try { endMs = speechEndMs(fs.readFileSync(d.clip)); } catch { /* reported below */ }
  if (endMs === null) return report(false, null, "the fixture clip is missing or silent");
  if (!fs.existsSync(d.helper)) return report(false, null, "the dictation helper isn't built");

  const useKokoro = d.tts !== null && d.tts.isWarm();
  const tts: SelfTestReport["tts"] = useKokoro ? "kokoro" : "apple";
  const id = `selftest-${now()}`;
  const child: ChildProcess = (d.spawnFn ?? spawn)(d.helper, ["--mode", "call", "--silence-ms", String(LIMITS5.voiceSilenceMs), "--file", d.clip, "--locale", "en-US"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.on?.("error", () => {});
  child.stderr?.on("data", () => {});
  let speechEndAt: number | null = null;
  const rel = (t: number) => Math.round(t - speechEndAt!);
  let settled = false;
  return await new Promise<SelfTestReport>((resolve) => {
    const finish = (r: SelfTestReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      d.signal?.removeEventListener("abort", onAbort);
      if (useKokoro) d.tts!.cancel(id);
      try { child.stdin?.write("stop\n"); } catch { /* gone */ }
      const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3_000);
      kill.unref?.();
      child.once("close", () => clearTimeout(kill));
      log(`voice-selftest: ${r.ok ? "passed" : "FAILED"} (${r.tts ?? "no voice"}): final ${r.stages.sttFinal ?? "-"} / first chunk ${r.stages.firstChunk ?? "-"} / first audio ${r.stages.firstAudio ?? "-"} ms after the end of speech${r.error ? `: ${r.error}` : ""}`);
      resolve(r);
    };
    const onAbort = () => finish(report(false, tts, "stopped: a call started"));
    if (d.signal?.aborted) return onAbort();
    d.signal?.addEventListener("abort", onAbort);
    const guard = setTimeout(() => finish(report(false, tts, "timed out")), d.timeoutMs ?? endMs! + 20_000);
    guard.unref?.();
    child.on("error", (e) => finish(report(false, tts, `the helper couldn't start: ${e.message}`)));
    child.on("close", () => finish(report(false, tts, "the helper stopped before the reply played")));
    const speak = (text: string) => {
      stages.firstToken = rel(now()); // a scripted reply: its text is there the moment the turn ends
      if (!useKokoro) { child.stdin?.write(`speak ${JSON.stringify({ id, text })}\n`); return; }
      child.stdin?.write(`speak ${JSON.stringify({ id, text, engine: "pcm" })}\n`);
      d.tts!.synth({ id, text, voice: d.voice ?? "af_heart", speed: 1 }, {
        audio: (pcm) => { if (stages.firstChunk === null) stages.firstChunk = rel(now()); child.stdin?.write(`pcm ${JSON.stringify({ id, data: pcm.toString("base64") })}\n`); },
        done: () => child.stdin?.write(`pcm-end ${JSON.stringify({ id })}\n`),
        error: (m) => { child.stdin?.write(`pcm-fail ${JSON.stringify({ id })}\n`); log(`voice-selftest: the natural voice failed (${m}); the helper says it`); },
      });
    };
    let buf = "";
    child.stdout?.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const e = parseDictationLine(raw);
        if (!e) continue;
        const t = now();
        // The file source hands over its first 100 ms buffer at the start of the clip: the clip's clock starts here.
        if (e.type === "audio" && speechEndAt === null) speechEndAt = t + endMs!;
        if (speechEndAt === null) continue;
        if (e.type === "likely-end" && stages.likelyEnd === null) stages.likelyEnd = rel(t);
        if (e.type === "final" && stages.sttFinal === null) {
          stages.sttFinal = rel(t);
          if (!e.text.trim()) return finish(report(false, tts, "no words were recognised in the clip"));
          const first = new SentenceChunker({ firstClause: true }).finish(d.reply ?? SELFTEST_REPLY)[0];
          const line = first ? speechText(first) : "";
          if (!line) return finish(report(false, tts, "the reply had nothing to say"));
          speak(line);
        }
        if (e.type === "speak-audio" && e.id === id && stages.firstAudio === null) {
          stages.firstAudio = rel(t);
          finish(report(true, tts)); // judged against the budget and the last nights by judgeSelfTest
        }
        if (e.type === "error") finish(report(false, tts, `helper: ${e.message}`));
      }
    });
  });
}

/** Where the report goes: the repo's test-reports/voice-selftest in a dev build, the app's own folder when packaged. */
export function reportDir(o: { isPackaged: boolean; appPath: string; userData: string }): string {
  return o.isPackaged ? path.join(o.userData, "voice-selftest") : path.join(o.appPath, "..", "test-reports", "voice-selftest");
}

export function writeReport(dir: string, r: SelfTestReport): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${r.at.slice(0, 10)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}

/**
 * The nightly schedule: every VOICE_SELFTEST.checkEveryMs it asks whether it may run (selfTestSkip: the setting, the
 * quiet window, once a day, never during a call, never on battery, never on a busy or in-use Mac) and runs once. A
 * call starting mid-run stops it at once.
 */
export function scheduleVoiceSelfTest(o: {
  conditions(): { enabled: boolean; inCall: boolean; onBattery: boolean; load1: number; cpus: number; idleMs: number; ttsBusy?: boolean };
  lastRunAt(): number | null;
  run(signal: AbortSignal): Promise<SelfTestReport>;
  done(r: SelfTestReport): void;
  log?: (l: string) => void;
  now?: () => Date;
  every?: (ms: number, fn: () => void) => { stop(): void };
}): { check(): Promise<SelfTestSkip | "ran" | "running">; callStarted(): void; stop(): void } {
  let running: AbortController | null = null;
  const check = async (): Promise<SelfTestSkip | "ran" | "running"> => {
    if (running) return "running";
    const c = o.conditions();
    const skip = selfTestSkip({ ...c, now: (o.now ?? (() => new Date()))(), lastRunAt: o.lastRunAt() });
    if (skip) return skip;
    running = new AbortController();
    try {
      o.done(await o.run(running.signal));
    } catch (e) {
      o.log?.(`voice-selftest: ${(e as Error).message}`);
    } finally {
      running = null;
    }
    return "ran";
  };
  const timer = (o.every ?? ((ms, fn) => { const t = setInterval(fn, ms); t.unref?.(); return { stop: () => clearInterval(t) }; }))(VOICE_SELFTEST.checkEveryMs, () => void check());
  return { check, callStarted: () => running?.abort(), stop: () => { timer.stop(); running?.abort(); } };
}
