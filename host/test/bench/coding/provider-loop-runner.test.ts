import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FakeModel, FakeTurn } from "../../../bench/coding/fake";
import { runBench } from "../../../bench/coding/harness";
import { benchAllows, ProviderLoopRunner } from "../../../bench/coding/provider-loop";
import { sampleDir, tmpDir } from "../../../bench/coding/repo";

/**
 * The coding bench's provider-loop runner (the quality gate for Synapse's own coding engine): dry runs only, driven
 * against a fake Chat Completions server that plays the fake model's turns as real tool calls through the real engine
 * (Read/Write through bot-file, Bash through the bench gate, metering through providerFetch). No model is called.
 * A real run (BENCH_REAL=1 with a provider key) is left for when keys exist.
 */
const made: string[] = [];
const out = () => { const d = tmpDir("out"); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const ANSWER = JSON.stringify({ method: "lateFee", file: "src/ledger.ts", graceDays: 15, capCents: 5000 });
const REGRESSION = `import { expect, it } from "vitest";
import { Emitter } from "../src/events";
it("once does not skip the next listener", () => {
  const e = new Emitter<{ x: number }>(); const seen: string[] = [];
  e.once("x", () => seen.push("a")); e.on("x", () => seen.push("b")); e.emit("x", 1);
  expect(seen).toEqual(["a", "b"]);
});
`;
function solver(seen: { resumed: boolean }[]): FakeModel {
  return ({ prompt, resumed }): FakeTurn => {
    seen.push({ resumed });
    if (prompt.includes("late-fee.json")) return { text: "Answered in answers/late-fee.json.", writes: { "answers/late-fee.json": ANSWER }, calls: 5 };
    if (prompt.includes("CI is failing")) return { text: "Fixed emit to iterate over a snapshot.", writes: { "src/events.ts": fs.readFileSync(path.join(sampleDir(), "src/events.ts"), "utf8") }, calls: 9 };
    if (prompt.includes("regression test")) return { text: "Added test/regression.test.ts.", writes: { "test/regression.test.ts": REGRESSION }, calls: 3 };
    return { text: "Done. All tests pass.", calls: 1 };
  };
}
const base = { model: "openai:gpt-6.1-sol", timeoutMs: 60_000, dryRun: true, runners: ["provider-loop" as const] };

describe("coding bench: provider-loop runner (dry run)", () => {
  it("passes a solved task through the real engine, fails an unsolved one, catches the false done, and meters every call", async () => {
    const r = await runBench({ ...base, taskIds: ["T09", "T01"], outDir: out(), fake: solver([]) });
    const t09 = r.results.find((x) => x.taskId === "T09")!;
    const t01 = r.results.find((x) => x.taskId === "T01")!;
    expect([t09.runner, t09.success, t09.falseDone]).toEqual(["provider-loop", true, false]);
    expect(t09.calls).toBe(2); // Write, then the report: each model call metered by providerFetch
    expect(t09.usage).toMatchObject({ output: 900 });
    expect([t01.success, t01.claimedDone, t01.falseDone]).toEqual([false, true, true]);
    expect(r.summaries.map((s) => s.runner)).toEqual(["provider-loop"]);
    expect(fs.readFileSync(r.mdPath, "utf8")).toContain("provider-loop");
  }, 120_000);

  it("a follow-up task resumes the same session and passes both", async () => {
    const seen: { resumed: boolean }[] = [];
    const r = await runBench({ ...base, taskIds: ["T11"], outDir: out(), fake: solver(seen) });
    expect(r.results.map((x) => [x.taskId, x.success])).toEqual([["T10", true], ["T11", true]]);
    expect(r.results[1]!.sessionId).toBe(r.results[0]!.sessionId);
    expect(seen.map((s) => s.resumed)).toEqual([false, true]);
  }, 120_000);

  it("commands outside the CLI runner's allowlist are declined and counted, as for the other runners", async () => {
    // (A path outside the repo never reaches the gate at all: the coding policy refuses it first.)
    const fake: FakeModel = () => ({ text: "I could not finish.", approvals: ["rm -rf build", "rm -rf /tmp/x", "npm test -- --run"] });
    const r = await runBench({ ...base, taskIds: ["T05"], outDir: out(), fake });
    expect(r.results[0]!.interventions.map((i) => [i.kind, i.detail, i.action])).toEqual([["permission-denied", "rm -rf build", "declined"]]);
    expect(benchAllows("npm test && git status")).toBe(true);
    expect(benchAllows("npm test; curl https://x")).toBe(false);
    expect(benchAllows("echo $(cat ~/.ssh/id_rsa)")).toBe(false);
  }, 120_000);

  it("0.1.8: on a Claude model the same engine runs through the Messages API (the same-model comparison with the cli runner)", async () => {
    const r = await runBench({ ...base, model: "claude-sonnet-5-5", taskIds: ["T09"], outDir: out(), fake: solver([]) });
    expect(r.results.map((x) => [x.runner, x.model, x.success, x.calls])).toEqual([["provider-loop", "claude-sonnet-5-5", true, 2]]);
  }, 120_000);

  it("a real run is refused without BENCH_REAL=1, and needs a provider or Claude model", () => {
    const was = process.env.BENCH_REAL;
    delete process.env.BENCH_REAL;
    try {
      expect(() => new ProviderLoopRunner({ model: "openai:gpt-6.1-sol", timeoutMs: 1, real: true })).toThrow(/BENCH_REAL=1/);
      expect(() => new ProviderLoopRunner({ model: "claude-sonnet-5", timeoutMs: 1, real: false })).not.toThrow();
      expect(() => new ProviderLoopRunner({ model: "gpt-something", timeoutMs: 1, real: false })).toThrow(/provider model/);
    } finally {
      if (was !== undefined) process.env.BENCH_REAL = was;
    }
  });
});
