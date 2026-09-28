import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EFFORT } from "@synapse/shared";
import { CliRunner, claudeArgs, parseClaudeStream } from "../../../bench/coding/cli";
import { FakeBox, fakeClaudeExec, idleModel, type FakeModel, type FakeTurn } from "../../../bench/coding/fake";
import { runBench } from "../../../bench/coding/harness";
import { sampleDir, tmpDir } from "../../../bench/coding/repo";
import { SynapseRunner } from "../../../bench/coding/synapse";

// Dry-run only: the fake model stands in for Claude on both runners. No model is ever called.
const made: string[] = [];
const out = () => { const d = tmpDir("out"); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const realEnv = process.env.BENCH_REAL;
afterEach(() => { if (realEnv === undefined) delete process.env.BENCH_REAL; else process.env.BENCH_REAL = realEnv; });

const ANSWER = JSON.stringify({ method: "lateFee", file: "src/ledger.ts", graceDays: 15, capCents: 5000 });
const REGRESSION = `import { expect, it } from "vitest";
import { Emitter } from "../src/events";
it("once does not skip the next listener", () => {
  const e = new Emitter<{ x: number }>(); const seen: string[] = [];
  e.once("x", () => seen.push("a")); e.on("x", () => seen.push("b")); e.emit("x", 1);
  expect(seen).toEqual(["a", "b"]);
});
`;

/** A fake that solves T09, T10 and T11 without ever reading the harness's private dirs. */
function solver(seen: { prompt: string; resumed: boolean }[]): FakeModel {
  return ({ prompt, resumed }): FakeTurn => {
    seen.push({ prompt, resumed });
    if (prompt.includes("late-fee.json")) return { text: "Answered in answers/late-fee.json.", writes: { "answers/late-fee.json": ANSWER }, calls: 5 };
    if (prompt.includes("CI is failing")) return { text: "Fixed emit to iterate over a snapshot.", writes: { "src/events.ts": fs.readFileSync(path.join(sampleDir(), "src/events.ts"), "utf8") }, calls: 9 };
    if (prompt.includes("regression test")) return { text: "Added test/regression.test.ts.", writes: { "test/regression.test.ts": REGRESSION }, calls: 3 };
    return { text: "Done.", calls: 1 };
  };
}

const base = { model: "claude-sonnet-5[1m]", timeoutMs: 60_000, dryRun: true } as const;

describe("CLI runner (dry run)", () => {
  it("passes a solved task, fails an unsolved one, and catches the false done", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const r = await runBench({ ...base, runners: ["cli"], taskIds: ["T09", "T01"], outDir: out(), fake: solver(seen) });
    const t09 = r.results.find((x) => x.taskId === "T09")!;
    const t01 = r.results.find((x) => x.taskId === "T01")!;
    expect([t09.success, t09.falseDone, t09.calls]).toEqual([true, false, 5]);
    expect(t09.usage).toEqual({ fresh: 4, cacheRead: 60_000, cacheWrite: 20_000, output: 900 });
    expect([t01.success, t01.claimedDone, t01.falseDone]).toEqual([false, true, true]);
  }, 120_000);

  it("resumes the same Claude session for a follow-up and passes both tasks", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const r = await runBench({ ...base, runners: ["cli"], taskIds: ["T11"], outDir: out(), fake: solver(seen) });
    expect(r.results.map((x) => [x.taskId, x.success])).toEqual([["T10", true], ["T11", true]]);
    expect(seen.map((s) => s.resumed)).toEqual([false, true]);
    expect(r.results[1]!.sessionId).toBe(r.results[0]!.sessionId);
  }, 120_000);

  it("counts questions and denied commands as declined interventions", async () => {
    const fake: FakeModel = () => ({ text: "I could not finish.", asks: ["Which file?"], approvals: ["rm -rf /tmp/x"] });
    const r = await runBench({ ...base, runners: ["cli"], taskIds: ["T05"], outDir: out(), fake });
    expect(r.results[0]!.interventions.map((i) => [i.kind, i.action])).toEqual([["question", "declined"], ["permission-denied", "declined"]]);
    expect(r.results[0]!.falseDone).toBe(false);
  }, 120_000);

  it("kills a run at the time limit and keeps the streamed usage as a lower bound", async () => {
    const r = await runBench({ ...base, timeoutMs: 300, runners: ["cli"], taskIds: ["T05"], outDir: out(), fake: () => ({ text: "", hang: true }) });
    const x = r.results[0]!;
    expect([x.timedOut, x.success]).toEqual([true, false]);
    expect(x.usage).toEqual({ fresh: 4, cacheRead: 1000, cacheWrite: 500, output: 20 });
    expect(x.notes).toContain("usage from messages");
  }, 120_000);

  it("builds headless args with the model, stream-json, no user MCP or settings, and --resume only when given", () => {
    const a = claudeArgs("do it", "claude-sonnet-5[1m]");
    expect(a.slice(0, 2)).toEqual(["-p", "do it"]);
    expect(a.join(" ")).toContain(`--output-format stream-json --verbose --model claude-sonnet-5[1m] --effort ${DEFAULT_EFFORT} --permission-mode acceptEdits`);
    expect(a).toContain("--strict-mcp-config");
    expect(a).not.toContain("--resume");
    expect(claudeArgs("x", "m", "sid-1").slice(-2)).toEqual(["--resume", "sid-1"]);
  });

  // Bug 171: the CLI ran at its own default effort while the Bot runs at DEFAULT_EFFORT, so T01's
  // accuracy gap could not be read as the Bot's. Both runners now get the same effort.
  it("pins the CLI to the Bot's default effort", () => {
    const a = claudeArgs("do it", "m");
    expect(a[a.indexOf("--effort") + 1]).toBe(DEFAULT_EFFORT);
  });

  it("flags a run whose tool inputs touch the harness's private dirs", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/host/bench/coding/reference-solutions/T01/src/csv.ts" } }] } }),
      JSON.stringify({ type: "result", is_error: false, num_turns: 2, result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } }),
    ];
    const p = parseClaudeStream(lines);
    expect(p.leakSuspect).toBe(true);
    expect(p.usage).toEqual({ fresh: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
    expect(p.calls).toBe(2);
  });
});

describe("Synapse runner (dry run, fake box)", () => {
  it("creates one engineering-mode bench Bot, declines a question and an approval, reads usage, and cleans up", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const inner = solver(seen);
    const box = new FakeBox((ctx) => ({ ...inner(ctx), asks: ["Proceed?"], approvals: ["curl example.com"] }), base.model);
    const r = await runBench({ ...base, runners: ["synapse"], taskIds: ["T09"], outDir: out(), box });
    const x = r.results[0]!;
    expect(x.success).toBe(true);
    expect(x.usage).toEqual({ fresh: 4, cacheRead: 60_000, cacheWrite: 20_000, output: 900 });
    expect(x.calls).toBe(5);
    expect(x.interventions.map((i) => [i.kind, i.action])).toEqual([["question", "declined"], ["approval", "declined"]]);
    expect(box.calls.find((c) => c.cmd === "dismissWidget")).toBeTruthy();
    expect(box.calls.find((c) => c.cmd === "resolveAutoReviewApproval")?.args.choice).toBe("deny");
    // cleanup: only the user's Bot is left, the workspace is gone, MAX_SCREENS untouched
    expect([...box.bots.keys()]).toEqual(["user-bot-1"]);
    expect(fs.readdirSync(box.root)).toEqual([]);
    expect(r.meta.notes.filter((n) => n.includes("PARITY/SAFETY"))).toEqual([]);
    // 2026-09-21 run: 35 of 38 usage rows were Haiku reviews; the note splits them by purpose.
    expect(r.meta.notes.find((n) => n.includes("usage.db run(s)"))).toMatch(/T09: 1 usage\.db run\(s\) \(turn 1\)/);
    // bug 231: the bench Bot works in its own ~/code, as every Bot now does
    expect(seen[0]!.prompt.split("\n")[0]).toMatch(/ at \S*\/code\/bench-[a-z0-9]{8}\/ledger\. /);
  }, 120_000);

  it("keeps one Bot for a follow-up session", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const box = new FakeBox(solver(seen), base.model);
    const r = await runBench({ ...base, runners: ["synapse"], taskIds: ["T11"], outDir: out(), box });
    expect(r.results.map((x) => [x.taskId, x.success])).toEqual([["T10", true], ["T11", true]]);
    expect(box.calls.filter((c) => c.cmd === "sendPrompt").map((c) => c.args.id)).toEqual(["bot-1", "bot-1"]);
    expect(seen.map((s) => s.resumed)).toEqual([false, true]);
  }, 120_000);

  it("interrupts the Bot at the time limit", async () => {
    const box = new FakeBox(() => ({ text: "", hang: true }), base.model);
    const r = await runBench({ ...base, timeoutMs: 300, runners: ["synapse"], taskIds: ["T05"], outDir: out(), box });
    expect(r.results[0]!.timedOut).toBe(true);
    expect(box.calls.some((c) => c.cmd === "interruptAgent")).toBe(true);
    expect([...box.bots.keys()]).toEqual(["user-bot-1"]);
  }, 120_000);
});

describe("both runners", () => {
  it("send the same prompt apart from the repo location line, and write report.md + results.json", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const dir = out();
    const r = await runBench({ ...base, runners: ["cli", "synapse"], taskIds: ["T09"], outDir: dir, fake: solver(seen) });
    expect(seen).toHaveLength(2);
    const [a, b] = seen.map((s) => s.prompt.split("\n"));
    expect(a!.slice(1)).toEqual(b!.slice(1));
    expect(a![0]!.replace(/at .*$/, "")).toBe(b![0]!.replace(/at .*$/, ""));
    expect(r.summaries.map((s) => [s.runner, s.successes])).toEqual([["cli", 1], ["synapse", 1]]);
    const json = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
    expect(json.summaries).toHaveLength(2);
    const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
    expect(md).toContain("DRY RUN");
    expect(md).toContain("| cli | 1/1 (100%)");
    expect(md).toContain("Not equalised");
  }, 120_000);

  it("refuse to run for real without BENCH_REAL=1", async () => {
    delete process.env.BENCH_REAL;
    await expect(runBench({ ...base, dryRun: false, runners: ["cli"], taskIds: ["T01"], outDir: out() })).rejects.toThrow(/BENCH_REAL=1/);
    expect(() => new CliRunner({ exec: fakeClaudeExec(idleModel), model: "m", timeoutMs: 1, real: true })).toThrow(/BENCH_REAL=1/);
    const realBox = Object.assign(new FakeBox(), { real: true as const }) as unknown as FakeBox;
    expect(() => new SynapseRunner({ box: realBox, model: "m", timeoutMs: 1, pullDir: () => "" })).toThrow(/BENCH_REAL=1/);
  });
});

/**
 * Bug-log 88 follow-up: the coding bench gets the hard per-task budget the computer-use bench has (weighted
 * tokens, metered live: the CLI's streamed per-call usage; the Bot's session file on the box plus its
 * usage.db review rows). Past it the run is stopped and fails as budget exceeded. Bug-log 75: the per-call
 * trace is read before the Bot (and with it its session file) is deleted.
 */
describe("per-task budget and per-call trace", () => {
  it("CLI: stops a run past its weighted-token budget long before the time limit, and fails it", async () => {
    const r = await runBench({ ...base, timeoutMs: 60_000, maxWeighted: 500, runners: ["cli"], taskIds: ["T05"], outDir: out(), fake: () => ({ text: "", hang: true }) });
    const x = r.results[0]!;
    expect([x.budgetExceeded, x.success, x.timedOut]).toEqual([true, false, false]);
    expect(x.wallMs).toBeLessThan(10_000);
    expect(x.error).toMatch(/budget exceeded/);
    expect(r.markdown).toContain("BUDGET EXCEEDED");
  }, 120_000);

  it("Synapse: interrupts a Bot past its budget, fails the task, and still cleans up", async () => {
    const box = new FakeBox(() => ({ text: "", hang: true }), base.model);
    const r = await runBench({ ...base, timeoutMs: 60_000, maxWeighted: 500, budgetPollMs: 20, runners: ["synapse"], taskIds: ["T05"], outDir: out(), box });
    const x = r.results[0]!;
    expect([x.budgetExceeded, x.success, x.timedOut]).toEqual([true, false, false]);
    expect(x.wallMs).toBeLessThan(10_000);
    expect(box.calls.some((c) => c.cmd === "interruptAgent")).toBe(true);
    expect([...box.bots.keys()]).toEqual(["user-bot-1"]);
  }, 120_000);

  it("a run under budget is untouched", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const r = await runBench({ ...base, maxWeighted: 1_000_000, runners: ["cli", "synapse"], taskIds: ["T09"], outDir: out(), fake: solver(seen) });
    expect(r.results.map((x) => [x.runner, x.success, x.budgetExceeded ?? false])).toEqual([["cli", true, false], ["synapse", true, false]]);
  }, 120_000);

  it("keeps a per-call trace on both runners; the Bot's is read before the Bot is deleted", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const box = new FakeBox(solver(seen), base.model);
    const r = await runBench({ ...base, runners: ["cli", "synapse"], taskIds: ["T09"], outDir: out(), fake: solver(seen), box });
    for (const x of r.results) expect(x.trace?.calls, x.runner).toBeGreaterThan(0);
    const order = box.calls.map((c) => c.cmd);
    expect(order.indexOf("transcript")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("transcript")).toBeLessThan(order.indexOf("deleteBot"));
    expect(r.markdown).toContain("## Per-call trace");
    expect(r.markdown).toMatch(/T09 \/ synapse: \d+ calls · input\/call avg/);
  }, 120_000);

  it("npm run bench:coding has the budget on by default, and --max-weighted changes it", async () => {
    const { main, DEFAULT_MAX_WEIGHTED } = await import("../../../bench/coding/main");
    const log = console.log;
    console.log = () => {};
    try {
      const a = out(), b = out();
      expect(await main(["--dry-run", "--runner", "cli", "--tasks", "T05", "--out", a])).toBe(0);
      expect(await main(["--dry-run", "--runner", "cli", "--tasks", "T05", "--out", b, "--max-weighted", "1234"])).toBe(0);
      expect(await main(["--dry-run", "--max-weighted", "0"])).toBe(2);
      const meta = (d: string) => JSON.parse(fs.readFileSync(path.join(d, "results.json"), "utf8")).meta.maxWeighted;
      expect([meta(a), meta(b)]).toEqual([DEFAULT_MAX_WEIGHTED, 1234]);
    } finally {
      console.log = log;
    }
  }, 120_000);

  it("a follow-up task's trace counts only its own calls", async () => {
    const seen: { prompt: string; resumed: boolean }[] = [];
    const box = new FakeBox(solver(seen), base.model);
    const r = await runBench({ ...base, runners: ["synapse"], taskIds: ["T11"], outDir: out(), box });
    expect(r.results.map((x) => x.trace?.calls)).toEqual([9, 3]);
  }, 120_000);
});
