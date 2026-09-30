/**
 * 5.8 voice latency: every call times each reply in five stages, keeps the numbers (never audio, never text) and
 * checks them against one budget — end of the user's speech to the reply's first audio. The nightly self-test runs
 * the same stages through the real pipeline with a fixture clip. Everything here is pure: the recorder, the store
 * and the scheduler live in the app (main/native/voice-latency.ts, voice-selftest.ts).
 */

export const VOICE_LATENCY = {
  /**
   * End of the user's speech → the reply's first audio: the GOAL, shown in Settings and counted per call. It is not
   * met yet (the end of turn alone is ~1 s, the voice's first text ~0.8 s more), so it never raises anything: only a
   * regression against the owner's own calls does.
   */
  budgetMs: 1_200,
  /** Calls kept on disk. */
  keepCalls: 50,
  /** Turns a call keeps (a long call's newest). */
  keepTurns: 200,
  /** A call counts toward the budget check only with at least this many timed replies. */
  minTurns: 3,
  /** The regression check: the median of the last this-many counted calls... */
  consistentCalls: 3,
  /** ...against the owner's own baseline: the median of up to this many counted calls before them... */
  baselineCalls: 20,
  /** ...once there are at least this many of them... */
  minBaselineCalls: 5,
  /** ...is a regression at this much slower (1.3 = 30% worse). */
  regressionRatio: 1.3,
  /** Once raised (or dismissed), the notice isn't raised again for this long. */
  renoticeMs: 7 * 24 * 3_600_000,
} as const;

/** The stages of one reply, as ms after the end of the user's speech (null: that stage never came, or isn't known). */
export interface TurnStages {
  /** The helper's end of turn with the final transcript. */
  sttFinal: number;
  /** The reply's first text reached the app. */
  firstToken: number | null;
  /** The reply's first line had its first TTS audio ready. */
  firstChunk: number | null;
  /** The reply's first audio went out to the speaker. */
  firstAudio: number | null;
}

/**
 * One timed reply. `ref`: what the times count from — "speech" (the helper said how long ago the voice stopped) or
 * "final" (an older helper: the end of speech isn't known, so the times count from the final and never meet the
 * budget check). `at`: when the turn ended (epoch ms, to the second).
 */
export interface TurnRecord extends TurnStages { at: number; ref: "speech" | "final"; spec?: boolean }

export interface CallLatency {
  id: string;
  startedAt: number;
  endedAt: number | null;
  turns: TurnRecord[];
}

export interface CallLatencySummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** Replies with a first audio, timed from the end of speech. */
  measured: number;
  /** Their median / slowest first audio (ms after the end of speech); null = none measured. */
  firstAudioP50: number | null;
  firstAudioMax: number | null;
  /** Measured replies over the budget. */
  over: number;
  /** Each stage's median (ms after the end of speech), for the log and the self-test report. */
  stages: { sttFinal: number | null; firstToken: number | null; firstChunk: number | null; firstAudio: number | null };
}

/** The p-th quantile the way the voice benches take it (nearest rank, low side). */
export function quantile(xs: readonly (number | null | undefined)[], p: number): number | null {
  const s = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null;
}

export function summarizeCall(c: CallLatency, budgetMs: number = VOICE_LATENCY.budgetMs): CallLatencySummary {
  const timed = c.turns.filter((t) => t.ref === "speech");
  const audio = timed.map((t) => t.firstAudio).filter((x): x is number => x !== null);
  return {
    id: c.id, startedAt: c.startedAt, endedAt: c.endedAt,
    measured: audio.length,
    firstAudioP50: quantile(audio, 0.5),
    firstAudioMax: audio.length ? Math.max(...audio) : null,
    over: audio.filter((x) => x > budgetMs).length,
    stages: {
      sttFinal: quantile(timed.map((t) => t.sttFinal), 0.5),
      firstToken: quantile(timed.map((t) => t.firstToken), 0.5),
      firstChunk: quantile(timed.map((t) => t.firstChunk), 0.5),
      firstAudio: quantile(audio, 0.5),
    },
  };
}

/**
 * The latency notice: a REGRESSION only, never the goal. The median first audio of the last `consistentCalls` counted
 * calls (each timed at least `minTurns` replies) against the owner's own baseline — the median of up to
 * `baselineCalls` counted calls before them (at least `minBaselineCalls`). 30% slower or more raises it (at most once a
 * week); a latest window that is back under that clears it. One slow reply or one slow call can't raise it.
 */
export type LatencyVerdict =
  | { action: "raise"; p50Ms: number; baselineMs: number; calls: number }
  | { action: "clear" }
  | { action: "none" };

export interface LatencyTrend { recentMs: number | null; baselineMs: number | null; regressed: boolean }

export function latencyTrend(calls: readonly CallLatency[]): LatencyTrend {
  const p50s = calls.map((c) => summarizeCall(c)).filter((s) => s.measured >= VOICE_LATENCY.minTurns && s.firstAudioP50 !== null).map((s) => s.firstAudioP50!);
  const recent = p50s.slice(-VOICE_LATENCY.consistentCalls);
  const prior = p50s.slice(0, -VOICE_LATENCY.consistentCalls).slice(-VOICE_LATENCY.baselineCalls);
  const recentMs = recent.length === VOICE_LATENCY.consistentCalls ? quantile(recent, 0.5) : null;
  const baselineMs = prior.length >= VOICE_LATENCY.minBaselineCalls ? quantile(prior, 0.5) : null;
  return { recentMs, baselineMs, regressed: recentMs !== null && baselineMs !== null && recentMs >= baselineMs * VOICE_LATENCY.regressionRatio };
}

export function latencyVerdict(calls: readonly CallLatency[], o: { now: number; noticedAt?: number | null } = { now: Date.now() }): LatencyVerdict {
  const t = latencyTrend(calls);
  if (t.recentMs === null || t.baselineMs === null) return { action: "none" };
  if (!t.regressed) return { action: "clear" };
  if (o.noticedAt && o.now - o.noticedAt < VOICE_LATENCY.renoticeMs) return { action: "none" };
  return { action: "raise", p50Ms: t.recentMs, baselineMs: t.baselineMs, calls: VOICE_LATENCY.consistentCalls };
}

/** "1.8 s" / "950 ms": how the settings row shows a first-audio time. */
export function latencyLabel(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms / 10) * 10} ms` : `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}

// ---------------- the nightly self-test ----------------

export const VOICE_SELFTEST = {
  /**
   * What the self-test can reach: end of speech → first audio with a scripted reply (no model time). Measured
   * 1,164-1,237 ms on the owner's Mac (2026-09-30); 1.4 s leaves room for a busy night, not for a regression.
   */
  budgetMs: 1_400,
  /** ...and against its own last nights: this many... */
  historyNights: 7,
  /** ...(at least this many of them)... */
  minHistory: 3,
  /** ...25% slower than their median fails. */
  regressionRatio: 1.25,
  /** The quiet window it runs in, local time (hours, [start, end)). */
  startHour: 3,
  endHour: 5,
  /** The Mac has had no input for this long. */
  idleMs: 10 * 60_000,
  /** 1-minute load average per core above this: the Mac is busy. */
  maxLoadPerCore: 0.5,
  /** At most once in this long. */
  everyMs: 20 * 3_600_000,
  /** The scheduler looks this often. */
  checkEveryMs: 10 * 60_000,
} as const;

export interface SelfTestConditions {
  enabled: boolean;
  now: Date;
  lastRunAt: number | null;
  inCall: boolean;
  onBattery: boolean;
  /** os.loadavg()[0] and os.cpus().length. */
  load1: number;
  cpus: number;
  idleMs: number;
  /** The natural voice is already rendering something (a pre-render): the test would only measure the queue. */
  ttsBusy?: boolean;
}

export type SelfTestSkip = "off" | "not-quiet-hour" | "ran-today" | "in-call" | "on-battery" | "busy" | "in-use";

/** Whether the nightly self-test may run now; the first reason it may not, in order. Never during a call. */
export function selfTestSkip(c: SelfTestConditions): SelfTestSkip | null {
  if (!c.enabled) return "off";
  if (c.inCall) return "in-call";
  const h = c.now.getHours();
  if (h < VOICE_SELFTEST.startHour || h >= VOICE_SELFTEST.endHour) return "not-quiet-hour";
  if (c.lastRunAt !== null && c.now.getTime() - c.lastRunAt < VOICE_SELFTEST.everyMs) return "ran-today";
  if (c.onBattery) return "on-battery";
  if (c.ttsBusy || c.load1 / Math.max(1, c.cpus) > VOICE_SELFTEST.maxLoadPerCore) return "busy";
  if (c.idleMs < VOICE_SELFTEST.idleMs) return "in-use";
  return null;
}

/** The self-test's report (test-reports/voice-selftest/<date>.json): numbers only. */
export interface SelfTestReport {
  at: string;
  ok: boolean;
  budgetMs: number;
  /** The median first audio of the last nights it was judged against (null: too few nights yet). */
  baselineMs?: number | null;
  /** 25% or more slower than those nights. */
  regression?: boolean;
  /** Why it didn't run to the end (no helper, no speech recognised, ...). */
  error?: string;
  /** "kokoro" = the real natural voice rendered the reply; "apple" = the helper's own voice (Kokoro unavailable). */
  tts: "kokoro" | "apple" | null;
  /** The reply's text is a fixed line (no model call): its first token counts as at once. */
  scriptedReply: true;
  /** ms after the end of speech in the clip (null: that stage never came). */
  stages: { likelyEnd: number | null; sttFinal: number | null; firstToken: number | null; firstChunk: number | null; firstAudio: number | null };
}

/**
 * The self-test's verdict: its own budget (1.4 s: the pipeline it measures, not the call goal) and a regression
 * against its last nights' first audio. `history`: earlier nights' first audio, oldest first.
 */
export function judgeSelfTest(r: SelfTestReport, history: readonly number[]): SelfTestReport {
  const past = history.slice(-VOICE_SELFTEST.historyNights);
  const baselineMs = past.length >= VOICE_SELFTEST.minHistory ? quantile(past, 0.5) : null;
  const fa = r.stages.firstAudio;
  if (fa === null) return { ...r, ok: false, budgetMs: VOICE_SELFTEST.budgetMs, baselineMs, regression: false };
  const regression = baselineMs !== null && fa >= baselineMs * VOICE_SELFTEST.regressionRatio;
  const over = fa > VOICE_SELFTEST.budgetMs;
  const error = r.error ?? (over ? `first audio ${fa} ms is over the ${VOICE_SELFTEST.budgetMs} ms budget` : regression ? `first audio ${fa} ms is 25% or more slower than the last nights (${baselineMs} ms)` : undefined);
  return { ...r, ok: !over && !regression && !r.error, budgetMs: VOICE_SELFTEST.budgetMs, baselineMs, regression, ...(error ? { error } : {}) };
}
