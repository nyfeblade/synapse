import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug 213: a call's voices on headphones sit at real binaural seats (HRTFHQ, one player per Bot), on
 * speakers at the old gentle pan, and a mono output keeps them centred. The helper renders its real
 * speech graph on an OFFLINE engine (nothing is played out loud, no microphone is opened) and measures
 * what comes out: ILD / ITD per seat (monotonic left → right), loudness against today's centred voice
 * (±1 dB), no clipping, one voice at a time, the 80 ms barge-in fade on a seat, a restart mid-line,
 * first-audio latency against today's path (±10 ms) and CPU. RUN_NATIVE=1 opts in (macOS + the built
 * helper); test-reports/spatial-calls/harness.mjs is the same run on real voices, with WAVs.
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
type Ev = { type: string; ok?: boolean; cases?: number; failures?: string[]; report?: Record<string, unknown> };
const result = (args: string[]): Ev => {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000 });
  const ev = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Ev).find((e) => e.type === "self-test");
  expect(ev, r.stderr.slice(-3000)).toBeTruthy();
  return ev!;
};

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("spatial voices on a call (bug 213)", () => {
  it("--self-test-spatial: route rules, the Mac-mic rule, seats, loudness, timing, fade, latency", () => {
    const ev = result(["--self-test-spatial"]);
    expect(ev.failures).toEqual([]);
    expect(ev.ok).toBe(true);
    expect(ev.cases).toBeGreaterThanOrEqual(40);
    const seats = ev.report!.seats as { azimuth: number; ildDb: number; itdSamples: number; loudnessVsCentreLU: number; peak: number }[];
    expect(seats.map((s) => s.azimuth)).toEqual([-40, 0, 40]);
    expect(seats[0]!.itdSamples).toBeGreaterThan(seats[1]!.itdSamples);
    expect(seats[1]!.itdSamples).toBeGreaterThan(seats[2]!.itdSamples);
    for (const s of seats) { expect(Math.abs(s.loudnessVsCentreLU)).toBeLessThanOrEqual(1); expect(s.peak).toBeLessThan(1); }
  }, 120_000);

  it("the old level-only pan fails the binaural checks (no time difference at any seat)", () => {
    const ev = result(["--self-test-spatial", "--seat-mode", "speakers"]);
    expect(ev.ok).toBe(false);
    expect(ev.failures!.some((f) => f.includes("time difference"))).toBe(true);
  }, 120_000);

  it("the wake matcher hears 'Hey Nova and Scout'", () => {
    const ev = result(["--self-test-wake"]);
    expect(ev.failures).toEqual([]);
  });
});
