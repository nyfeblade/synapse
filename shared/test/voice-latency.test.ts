import { describe, expect, it } from "vitest";
import { VOICE_LATENCY, VOICE_SELFTEST, judgeSelfTest, latencyLabel, latencyTrend, latencyVerdict, quantile, selfTestSkip, summarizeCall, type CallLatency, type SelfTestConditions, type SelfTestReport, type TurnRecord } from "../src/voice-latency";

const turn = (firstAudio: number | null, o: Partial<TurnRecord> = {}): TurnRecord => ({ at: 0, ref: "speech", sttFinal: 900, firstToken: 1_200, firstChunk: firstAudio === null ? null : firstAudio - 10, firstAudio, ...o });
const call = (id: string, audios: (number | null)[], o: Partial<TurnRecord> = {}): CallLatency => ({ id, startedAt: 0, endedAt: 1, turns: audios.map((a) => turn(a, o)) });
const DAY = 24 * 3_600_000;

describe("5.8: a call's latency summary", () => {
  it("medians each stage from the end of speech and counts the replies over budget", () => {
    const s = summarizeCall(call("a", [900, 1_100, 1_500, 2_000, null]));
    expect(s.measured).toBe(4);
    expect(s.firstAudioP50).toBe(1_500);
    expect(s.firstAudioMax).toBe(2_000);
    expect(s.over).toBe(2);
    expect(s.stages.sttFinal).toBe(900);
  });

  it("a turn timed from the final (an older helper: no end of speech) is never measured against the budget", () => {
    const s = summarizeCall(call("a", [300, 400, 500], { ref: "final" }));
    expect(s.measured).toBe(0);
    expect(s.firstAudioP50).toBeNull();
  });

  it("quantile is the benches' nearest rank and ignores missing stages", () => {
    expect(quantile([null, 3, 1, 2, undefined], 0.5)).toBe(2);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("5.8: the latency notice is a regression against the owner's own calls, never the 1.2 s goal", () => {
  const now = 100 * DAY;
  const at = (id: string, ms: number) => call(id, [ms - 100, ms, ms + 100]);
  const usual = (n: number, ms = 2_000) => Array.from({ length: n }, (_, i) => at(`b${i}`, ms));

  it("always over the goal but steady: nothing, and a steady window clears", () => {
    expect(latencyVerdict([...usual(20), at("x", 2_100), at("y", 2_200), at("z", 2_000)], { now })).toEqual({ action: "clear" });
  });

  it("the last 3 counted calls 30% slower than the median of the 20 before: raise, with both numbers", () => {
    const v = latencyVerdict([...usual(25, 1_500), ...usual(20), at("x", 2_700), at("y", 2_600), at("z", 3_000)], { now });
    expect(v).toEqual({ action: "raise", p50Ms: 2_700, baselineMs: 2_000, calls: VOICE_LATENCY.consistentCalls });
    expect(latencyVerdict([...usual(20), at("x", 2_500), at("y", 2_500), at("z", 2_500)], { now }).action).toBe("clear"); // 25%: not yet
  });

  it("one slow call, or one slow reply, never raises it", () => {
    expect(latencyVerdict([...usual(20), at("x", 2_000), at("y", 2_000), at("z", 9_000)], { now }).action).toBe("clear");
    expect(latencyVerdict([...usual(20), at("x", 2_000), at("y", 2_000), call("z", [1_900, 2_000, 30_000])], { now }).action).toBe("clear");
  });

  it("no baseline yet (fewer than 5 counted calls before the window): nothing either way", () => {
    expect(latencyVerdict([...usual(4), at("x", 9_000), at("y", 9_000), at("z", 9_000)], { now }).action).toBe("none");
    expect(latencyTrend([...usual(5), at("x", 9_000), at("y", 9_000), at("z", 9_000)]).regressed).toBe(true);
  });

  it("calls with too few timed replies don't count either way", () => {
    const short = call("s", [9_000, 9_000]);
    expect(latencyVerdict([...usual(20), at("x", 3_000), short, at("y", 3_000), short, at("z", 3_000)], { now }).action).toBe("raise");
  });

  it("raised (or dismissed) in the last week: not raised again", () => {
    const calls = [...usual(20), at("x", 3_000), at("y", 3_000), at("z", 3_000)];
    expect(latencyVerdict(calls, { now, noticedAt: now - 2 * DAY }).action).toBe("none");
    expect(latencyVerdict(calls, { now, noticedAt: now - 8 * DAY }).action).toBe("raise");
  });

  it("labels: under a second in ms, else seconds to one place", () => {
    expect(latencyLabel(954)).toBe("950 ms");
    expect(latencyLabel(1_840)).toBe("1.8 s");
    expect(latencyLabel(2_000)).toBe("2.0 s");
  });
});

describe("5.8: when the nightly self-test may run", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m);
  const ok: SelfTestConditions = { enabled: true, now: at(3, 30), lastRunAt: null, inCall: false, onBattery: false, load1: 1, cpus: 10, idleMs: 60 * 60_000 };

  it("runs at a quiet hour on an idle Mac on power", () => {
    expect(selfTestSkip(ok)).toBeNull();
  });

  it("never during a call — whatever the hour", () => {
    expect(selfTestSkip({ ...ok, inCall: true })).toBe("in-call");
  });

  it("skips when the Mac is busy, on battery, or in use", () => {
    expect(selfTestSkip({ ...ok, load1: 6 })).toBe("busy");
    expect(selfTestSkip({ ...ok, load1: 5 })).toBeNull();
    expect(selfTestSkip({ ...ok, ttsBusy: true })).toBe("busy");
    expect(selfTestSkip({ ...ok, onBattery: true })).toBe("on-battery");
    expect(selfTestSkip({ ...ok, idleMs: 60_000 })).toBe("in-use");
  });

  it("only in its quiet window, and once a day", () => {
    expect(selfTestSkip({ ...ok, now: at(2, 59) })).toBe("not-quiet-hour");
    expect(selfTestSkip({ ...ok, now: at(5, 0) })).toBe("not-quiet-hour");
    expect(selfTestSkip({ ...ok, now: at(14) })).toBe("not-quiet-hour");
    expect(selfTestSkip({ ...ok, lastRunAt: at(1, 30).getTime() })).toBe("ran-today");
    expect(selfTestSkip({ ...ok, lastRunAt: at(3, 30).getTime() - DAY })).toBeNull();
  });

  it("the setting turns it off", () => {
    expect(selfTestSkip({ ...ok, enabled: false })).toBe("off");
  });
});

describe("5.8: the self-test's verdict (its own 1.4 s budget, and its last 7 nights)", () => {
  const r = (firstAudio: number | null): SelfTestReport => ({ at: "", ok: true, budgetMs: 0, tts: "kokoro", scriptedReply: true, stages: { likelyEnd: null, sttFinal: 900, firstToken: 900, firstChunk: null, firstAudio } });

  it("judges the pipeline it measures against 1.4 s, not the 1.2 s call goal", () => {
    expect(judgeSelfTest(r(1_237), [])).toMatchObject({ ok: true, budgetMs: VOICE_SELFTEST.budgetMs, baselineMs: null, regression: false });
    expect(judgeSelfTest(r(1_450), [])).toMatchObject({ ok: false, error: "first audio 1450 ms is over the 1400 ms budget" });
  });

  it("25% slower than the median of its last 7 nights fails as a regression; 20% doesn't", () => {
    const nights = [1_100, 1_150, 1_200, 1_100, 1_000, 900, 1_000, 1_100]; // the oldest drops out
    expect(judgeSelfTest(r(1_375), nights)).toMatchObject({ ok: false, regression: true, baselineMs: 1_100 });
    expect(judgeSelfTest(r(1_320), nights)).toMatchObject({ ok: true, regression: false });
    expect(judgeSelfTest(r(1_375), [1_000, 1_000])).toMatchObject({ ok: true, baselineMs: null }); // too few nights yet
  });

  it("no first audio, or an earlier error, is a failure", () => {
    expect(judgeSelfTest(r(null), []).ok).toBe(false);
    expect(judgeSelfTest({ ...r(1_000), error: "timed out" }, []).ok).toBe(false);
  });
});
