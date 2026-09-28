import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Options, SDKUserMessage, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ct10, judgeCt10 } from "../../../brain/conformance/checks/group-b";
import { ct13, judgeCt13 } from "../../../brain/conformance/checks/group-c";
import { ensureConformance, loadConformance, saveConformance } from "../../../brain/conformance/runner";
import { DEFAULT_FLAGS, withFlagOverrides } from "../../../brain/conformance/flags";
import type { ConformanceCheck, ConformanceContext } from "../../../brain/conformance/types";
import { log } from "../../../util/log";

/**
 * TTFT war room: CT-13 and CT-10 counted `system/init` messages as process spawns. The CLI emits `init` at the
 * start of EVERY turn (SDK docs, SDKSystemMessage; bench: 3 inits from ONE process over 3 warm turns), so the
 * live box read ["ONE","TWO","","FOUR"] from one process as 4 processes, failed CT-13 and ran every Bot cold
 * (warmSessions=false): ~1.0 s p50 / 1.8 s p90 of CLI start-up on every turn. CT-10 read "no init before the
 * first message" as "no prewarm", though the process had started (bench: push → API request 52 ms prewarmed vs
 * ~330 ms cold). Both now count real spawns through the SDK's spawnClaudeCodeProcess hook.
 */

/** A scripted stand-in for the CLI: spawns once (through the options' hook) and, like the real CLI, emits a
 *  system/init at the start of each turn, then a result. An interrupt yields an empty result. */
function fakeCli(o: { initBeforePush?: boolean } = {}) {
  let spawnCalls = 0;
  const queryFn = ((p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const spawnFn = p.options.spawnClaudeCodeProcess;
    if (spawnFn) { spawnFn({ command: "claude", args: [], env: {}, signal: new AbortController().signal } as SpawnOptions); spawnCalls++; }
    let interrupted = false;
    async function* gen() {
      if (o.initBeforePush) yield { type: "system", subtype: "init", session_id: "s" };
      for await (const m of p.prompt) {
        const text = JSON.stringify(m.message.content);
        yield { type: "system", subtype: "init", session_id: "s" };
        if (/sleep 15/.test(text)) {
          yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } };
          await new Promise((r) => setTimeout(r, 5));
          yield { type: "result", subtype: interrupted ? "error_during_execution" : "success", result: "" };
          continue;
        }
        const word = /word (\w+)/.exec(text)?.[1] ?? "OK";
        yield { type: "result", subtype: "success", result: word };
      }
    }
    const it = gen();
    return Object.assign(it, { interrupt: async () => { interrupted = true; }, close: () => {} });
  }) as unknown as ConformanceContext["queryFn"];
  return { queryFn, spawns: () => spawnCalls };
}

const ctxOf = (queryFn: ConformanceContext["queryFn"]): ConformanceContext => ({
  cfg: {} as never, runAs: "same-uid", queryFn, now: Date.now,
  baseOptions: (extra = {}) => ({ ...extra }) as Options,
  boxUid: async () => null, log: () => {},
  spawnProcess: () => ({}) as SpawnedProcess,
});

describe("CT-13 counts processes, not per-turn init messages", () => {
  it("the box's own evidence — 4 turns, 4 inits, ONE process — passes", () => {
    expect(judgeCt13({ texts: ["ONE", "TWO", "", "FOUR"], spawns: 1 }).status).toBe("pass");
  });
  it("a second process still fails it (a real respawn)", () => {
    expect(judgeCt13({ texts: ["ONE", "TWO", "", "FOUR"], spawns: 2 })).toMatchObject({ status: "fail", flags: { warmSessions: false } });
  });
  it("the check itself, on a CLI that emits init every turn from one process, passes", async () => {
    const cli = fakeCli();
    const out = await ct13.run(ctxOf(cli.queryFn));
    expect(cli.spawns()).toBe(1);
    expect(out.status).toBe("pass");
  });
});

const run = (ms: number, o: Partial<{ spawnedBeforePush: boolean; answered: boolean }> = {}) => ({ ms, spawnedBeforePush: true, answered: true, ...o });
describe("CT-10 judges prewarm by when the process starts, not by an early init", () => {
  it("started before the push and answering much faster than a cold start passes", () => {
    expect(judgeCt10({ cold: run(900), prewarmed: run(40) }).status).toBe("pass");
  });
  it("no head start (as slow as cold, or not started before the push) fails", () => {
    expect(judgeCt10({ cold: run(900), prewarmed: run(800) })).toMatchObject({ status: "fail", flags: { prewarm: false } });
    expect(judgeCt10({ cold: run(900), prewarmed: run(40, { spawnedBeforePush: false }) })).toMatchObject({ status: "fail" });
  });
  it("review fix round 1: an instantly exiting CLI is not a fast one, and a timeout is no verdict", () => {
    expect(judgeCt10({ cold: run(900), prewarmed: run(0, { answered: false }) })).toMatchObject({ status: "fail", flags: { prewarm: false } });
    expect(judgeCt10({ cold: run(3), prewarmed: run(1) })).toMatchObject({ status: "fail" }); // a 3 ms "cold start" didn't start anything
    expect(judgeCt10({ cold: run(Number.POSITIVE_INFINITY), prewarmed: run(40) })).toMatchObject({ status: "fail", transient: true });
    expect(judgeCt10({ cold: run(900), prewarmed: run(Number.NaN) }).status).toBe("fail");
  });
  it("the check itself no longer needs an init before the first message; a warm-up run is discarded; order is randomised", async () => {
    const cli = fakeCli({ initBeforePush: false });
    const out = await ct10.run({ ...ctxOf(cli.queryFn), prewarmWaitMs: 20, random: () => 0.9 } as never);
    expect(cli.spawns()).toBe(3); // warm-up, then the two measured runs
    expect(out.detail).not.toMatch(/init waits/);
  });
});

describe("CT-13 review fix round 1: an incomplete or rate-limited run is transient", () => {
  it("fewer than 4 results from one process is no verdict", () => {
    expect(judgeCt13({ texts: ["ONE", "TWO"], spawns: 1 })).toMatchObject({ status: "fail", transient: true });
    expect(judgeCt13({ texts: ["ONE", "TWO"], spawns: 2 }).transient).toBeUndefined(); // a respawn is a real failure
  });
});

describe("transient conformance results are never persisted as a verdict (review fix round 1)", () => {
  let dir = "";
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-tr-")); vi.spyOn(log, "info").mockImplementation(() => {}); vi.spyOn(log, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cfgIn = () => ({ brain: "claude", hostPrivate: dir, workspace: dir, executables: { setpriv: "/x", bwrap: "/y" } }) as never;

  it("a rate-limited rev-2 run keeps the saved result and re-runs next boot; the retry's honest pass then sticks", async () => {
    saveConformance(dir, { cliVersion: "2.1.280", ranAt: 1, flags: { ...DEFAULT_FLAGS, warmSessions: false },
      results: { "CT-13": { status: "fail", detail: "rev 1", flags: { warmSessions: false } } } });
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("API Error: 429 rate_limit_error"))
      .mockResolvedValueOnce({ status: "pass", detail: "4 results from one process" });
    const checks: ConformanceCheck[] = [{ id: "CT-13", title: "b", onThrow: { warmSessions: false }, rev: 2, run }];
    const f1 = await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.280", now: () => 2 });
    expect(f1.warmSessions).toBe(false);
    expect(loadConformance(dir)?.results["CT-13"]).toMatchObject({ detail: "rev 1" }); // not overwritten
    const f2 = await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.280", now: () => 3 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(f2.warmSessions).toBe(true);
    expect(loadConformance(dir)?.results["CT-13"]).toMatchObject({ status: "pass", rev: 2 });
  });

  it("a transient first run with nothing saved runs on the fallback flags and is marked for a re-run", async () => {
    saveConformance(dir, { cliVersion: "2.1.280", ranAt: 1, flags: DEFAULT_FLAGS, results: {} });
    const out = { status: "fail" as const, detail: "timed out", flags: { prewarm: false }, transient: true };
    const run = vi.fn().mockResolvedValueOnce(out).mockResolvedValueOnce({ status: "pass", detail: "ok" });
    const checks: ConformanceCheck[] = [{ id: "CT-10", title: "p", onThrow: { prewarm: false }, rev: 2, run }];
    const f1 = await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.281", now: () => 2 }); // new CLI: full run
    expect(f1.prewarm).toBe(false);
    expect(loadConformance(dir)?.results["CT-10"]).toMatchObject({ transient: true });
    const f2 = await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.281", now: () => 3 });
    expect(f2.prewarm).toBe(true);
    expect(loadConformance(dir)?.results["CT-10"]?.transient).toBeUndefined();
  });
});

describe("kill switch (review fix round 1)", () => {
  it("SYNAPSE_WARM_SESSIONS / SYNAPSE_PREWARM override the saved flags either way; anything else leaves them alone", () => {
    const saved = { ...DEFAULT_FLAGS, warmSessions: true, prewarm: false };
    expect(withFlagOverrides(saved, { SYNAPSE_WARM_SESSIONS: "0" })).toMatchObject({ warmSessions: false, prewarm: false });
    expect(withFlagOverrides(saved, { SYNAPSE_PREWARM: "1" })).toMatchObject({ warmSessions: true, prewarm: true });
    expect(withFlagOverrides(saved, { SYNAPSE_WARM_SESSIONS: "yes" })).toBe(saved);
    expect(withFlagOverrides(saved, {})).toBe(saved);
  });
});

describe("a revised check re-runs at boot even when the CLI version is unchanged", () => {
  let dir = "";
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "conf-rev-")); vi.spyOn(log, "info").mockImplementation(() => {}); vi.spyOn(log, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cfgIn = () => ({ brain: "claude", hostPrivate: dir, workspace: dir, executables: { setpriv: "/x", bwrap: "/y" } }) as never;

  it("saved flags from an older judge revision are replaced by the revised check's honest result", async () => {
    saveConformance(dir, {
      cliVersion: "2.1.280", ranAt: 1, flags: { ...DEFAULT_FLAGS, warmSessions: false, sendStreaming: false },
      results: {
        "CT-01": { status: "fail", detail: "old", flags: { sendStreaming: false } },
        "CT-13": { status: "fail", detail: 'results: ["ONE","TWO","","FOUR"]', flags: { warmSessions: false } },
      },
    });
    const ct01 = vi.fn(async () => ({ status: "pass" as const, detail: "should not re-run" }));
    const ct13run = vi.fn(async () => ({ status: "pass" as const, detail: "4 results from one process" }));
    const checks: ConformanceCheck[] = [
      { id: "CT-01", title: "a", onThrow: {}, run: ct01 },
      { id: "CT-13", title: "b", onThrow: { warmSessions: false }, rev: 2, run: ct13run },
    ];
    const flags = await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.280", now: () => 2 });
    expect(ct13run).toHaveBeenCalledOnce();
    expect(ct01).not.toHaveBeenCalled(); // unchanged checks keep their saved result
    expect(flags).toMatchObject({ warmSessions: true, sendStreaming: false });
    expect(loadConformance(dir)?.results["CT-13"]).toMatchObject({ status: "pass", rev: 2 });
    // …and the next boot with the same CLI re-runs nothing.
    await ensureConformance(cfgIn(), { checks, detectCliVersion: async () => "2.1.280", now: () => 3 });
    expect(ct13run).toHaveBeenCalledOnce();
  });
});
