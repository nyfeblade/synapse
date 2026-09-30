import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file";
import {
  VOICE_LATENCY, VOICE_SELFTEST, latencyTrend, latencyVerdict, summarizeCall,
  type CallLatency, type CallLatencySummary, type LatencyVerdict, type SelfTestReport, type TurnRecord,
} from "@synapse/shared";

/**
 * 5.8 voice latency: each reply on a call, timed in five stages — the end of the user's speech (the helper says how
 * long ago the voice stopped when it sends the final), the final itself, the reply's first text in the app, its first
 * line's first TTS audio ready, and its first audio out of the helper. Numbers only: no audio, no text, no ids of
 * anything the user said. Kept in <userData>/voice-latency.json (the last 50 calls).
 *
 * Fed from main, where every one of those events already passes: the helper's stdout (final, speak-audio), the
 * renderer's voice.log marks (sent, first-text, speculate), and dictation.speak (which line is a reply's, and when
 * its first PCM went to the helper).
 */

export interface LatencyFile {
  v: 1;
  calls: CallLatency[];
  /** When the budget notice was last raised (it isn't raised again for a week). */
  noticedAt: number | null;
  /** The nightly self-test: when it last ran, its report, and the last nights' first audio (its regression baseline). */
  selfTest: { lastRunAt: number | null; last: SelfTestReport | null; history: number[]; noticedAt: number | null };
}

const EMPTY: LatencyFile = { v: 1, calls: [], noticedAt: null, selfTest: { lastRunAt: null, last: null, history: [], noticedAt: null } };

export class LatencyStore {
  constructor(private file: string) {}

  read(): LatencyFile {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LatencyFile>;
      if (j?.v !== 1 || !Array.isArray(j.calls)) return structuredClone(EMPTY);
      return {
        v: 1,
        calls: j.calls.filter((c) => c && typeof c.id === "string" && Array.isArray(c.turns)).slice(-VOICE_LATENCY.keepCalls),
        noticedAt: typeof j.noticedAt === "number" ? j.noticedAt : null,
        selfTest: {
          lastRunAt: typeof j.selfTest?.lastRunAt === "number" ? j.selfTest.lastRunAt : null, last: j.selfTest?.last ?? null,
          history: Array.isArray(j.selfTest?.history) ? j.selfTest.history.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(-VOICE_SELFTEST.historyNights) : [],
          noticedAt: typeof j.selfTest?.noticedAt === "number" ? j.selfTest.noticedAt : null,
        },
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  write(f: LatencyFile): void {
    const out = { ...f, calls: f.calls.slice(-VOICE_LATENCY.keepCalls) };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(out), 0o600);
    } catch { /* a lost record never breaks a call */ }
  }

  update(fn: (f: LatencyFile) => void): LatencyFile {
    const f = this.read();
    fn(f);
    this.write(f);
    return f;
  }
}

/** The events a call's reply passes through, as main sees them. */
export interface LatencyHooks {
  /** The helper's final on a call. `sinceVoiceMs`: how long ago the voice stopped (absent from an older helper). */
  final(sinceVoiceMs?: number): void;
  /** A voice.log mark from the renderer's loop ("sent", "first-text", "speculate", "speculate-cancel", ...). */
  mark(what: string): void;
  /** A reply's line (not the call's own "mm" / filler) was handed to speech under this id. */
  line(id: string): void;
  /** That line's first TTS audio went to the helper (cached lines: at once). */
  chunk(id: string): void;
  /** The helper's first audio out for that line. */
  audio(id: string): void;
}

interface Open {
  finalAt: number;
  speechEndAt: number | null;
  spec: boolean;
  tokenAt: number | null;
  lineId: string | null;
  chunkAt: number | null;
  audioAt: number | null;
}

export class LatencyRecorder implements LatencyHooks {
  private call: CallLatency | null = null;
  /** The helper's last final, waiting for the loop to send it as a turn (a backchannel or "stop" never is). */
  private pending: { finalAt: number; speechEndAt: number | null } | null = null;
  private cur: Open | null = null;
  private specLive = false;

  constructor(private o: { store: LatencyStore; now?: () => number; newId?: () => string; log?: (l: string) => void }) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  inCall(): boolean { return this.call !== null; }

  callStart(): void {
    if (this.call) this.callEnd();
    this.call = { id: (this.o.newId ?? randomUUID)(), startedAt: this.now(), endedAt: null, turns: [] };
    this.pending = this.cur = null;
    this.specLive = false;
  }

  /** The call ended: its turns are saved, and the budget verdict over the last calls comes back. */
  callEnd(): { summary: CallLatencySummary | null; verdict: LatencyVerdict } {
    const c = this.call;
    if (!c) return { summary: null, verdict: { action: "none" } };
    this.close();
    this.call = null;
    this.pending = null;
    c.endedAt = this.now();
    const summary = summarizeCall(c);
    let verdict: LatencyVerdict = { action: "none" };
    this.o.store.update((f) => {
      if (c.turns.length) f.calls.push(c);
      verdict = latencyVerdict(f.calls, { now: this.now(), noticedAt: f.noticedAt });
      if (verdict.action === "raise") f.noticedAt = this.now();
    });
    if (summary.measured) this.o.log?.(`voice-latency: call ${c.id.slice(0, 8)} first audio p50 ${summary.firstAudioP50} ms (${summary.measured} replies, ${summary.over} over ${VOICE_LATENCY.budgetMs} ms); stages p50 final ${summary.stages.sttFinal} / text ${summary.stages.firstToken} / chunk ${summary.stages.firstChunk}`);
    return { summary, verdict };
  }

  final(sinceVoiceMs?: number): void {
    if (!this.call) return;
    const t = this.now();
    const since = typeof sinceVoiceMs === "number" && Number.isFinite(sinceVoiceMs) && sinceVoiceMs >= 0 && sinceVoiceMs < 60_000 ? sinceVoiceMs : null;
    this.pending = { finalAt: t, speechEndAt: since === null ? null : t - since };
  }

  mark(what: string): void {
    if (!this.call) return;
    if (what === "speculate") { this.specLive = true; return; }
    if (what === "speculate-cancel") { this.specLive = false; return; }
    if (what === "sent") {
      this.close();
      const p = this.pending;
      this.pending = null;
      if (p) this.cur = { ...p, spec: this.specLive, tokenAt: null, lineId: null, chunkAt: null, audioAt: null };
      this.specLive = false;
      return;
    }
    if (what === "first-text" && this.cur && this.cur.tokenAt === null) this.cur.tokenAt = this.now();
  }

  line(id: string): void {
    if (this.cur && this.cur.lineId === null) this.cur.lineId = id;
  }

  chunk(id: string): void {
    if (this.cur && this.cur.lineId === id && this.cur.chunkAt === null) this.cur.chunkAt = this.now();
  }

  audio(id: string): void {
    if (this.cur && this.cur.lineId === id && this.cur.audioAt === null) this.cur.audioAt = this.now();
  }

  /** The open turn becomes a record (times after the end of speech, or after the final when that isn't known). */
  private close(): void {
    const t = this.cur;
    this.cur = null;
    if (!t || !this.call) return;
    const ref = t.speechEndAt ?? t.finalAt;
    const rel = (x: number | null) => (x === null ? null : Math.max(0, Math.round(x - ref)));
    const rec: TurnRecord = {
      at: Math.round(t.finalAt / 1000) * 1000, ref: t.speechEndAt === null ? "final" : "speech",
      sttFinal: rel(t.finalAt)!, firstToken: rel(t.tokenAt), firstChunk: rel(t.chunkAt), firstAudio: rel(t.audioAt),
      ...(t.spec ? { spec: true } : {}),
    };
    this.call.turns.push(rec);
    if (this.call.turns.length > VOICE_LATENCY.keepTurns) this.call.turns.splice(0, this.call.turns.length - VOICE_LATENCY.keepTurns);
  }
}

/** The last call that timed a reply, for Settings → Voice. */
export function lastCallLatency(f: LatencyFile): CallLatencySummary | null {
  for (let i = f.calls.length - 1; i >= 0; i--) {
    const s = summarizeCall(f.calls[i]!);
    if (s.measured > 0) return s;
  }
  return null;
}

type Reg = (name: string, fn: (a: any) => unknown) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The renderer's side: a call starting and ending (`voice.latency.call`; the end answers with the budget verdict,
 * which the renderer turns into the host's notice), and the last call's first audio for Settings → Voice.
 */
export function registerVoiceLatency(reg: Reg, o: { userData: string; log?: (l: string) => void; now?: () => number }): { recorder: LatencyRecorder; store: LatencyStore } {
  const store = new LatencyStore(path.join(o.userData, "voice-latency.json"));
  const recorder = new LatencyRecorder({ store, log: o.log, now: o.now });
  reg("voice.latency.call", (a: { on?: unknown }) => {
    if (typeof a?.on !== "boolean") throw new Error("Bad call state.");
    if (a.on) { recorder.callStart(); return {}; }
    const { summary, verdict } = recorder.callEnd();
    return { firstAudioMs: summary?.firstAudioP50 ?? null, measured: summary?.measured ?? 0, verdict };
  });
  reg("voice.latency.last", () => {
    const f = store.read();
    const s = lastCallLatency(f);
    // 5.8: `regressed` only when the last calls are 30% slower than the owner's own baseline (never for the goal).
    const regressed = latencyTrend(f.calls).regressed;
    return s ? { firstAudioMs: s.firstAudioP50, measured: s.measured, over: s.over, endedAt: s.endedAt, regressed } : { firstAudioMs: null, measured: 0, over: 0, endedAt: null, regressed: false };
  });
  return { recorder, store };
}

/**
 * 5.8: a finished nightly run is recorded (its first audio joins the last nights' baseline), and says whether the
 * slower-voice notice should go up (a regression, at most once a week) or come down (a normal night after one).
 */
export function recordSelfTest(store: LatencyStore, r: SelfTestReport, now: number): "raise" | "clear" | "none" {
  let out: "raise" | "clear" | "none" = "none";
  store.update((f) => {
    f.selfTest.lastRunAt = now;
    f.selfTest.last = r;
    if (r.regression) {
      if (!f.selfTest.noticedAt || now - f.selfTest.noticedAt >= VOICE_LATENCY.renoticeMs) { out = "raise"; f.selfTest.noticedAt = now; }
    } else if (r.ok) out = "clear";
    // A regressed night never becomes the new normal it is judged against.
    if (r.stages.firstAudio !== null && !r.regression) f.selfTest.history = [...f.selfTest.history, r.stages.firstAudio].slice(-VOICE_SELFTEST.historyNights);
  });
  return out;
}
