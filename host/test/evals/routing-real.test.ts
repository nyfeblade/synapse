import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTED_MODEL } from "../../brain/model-router";
import { loadCases, type RoutingCase } from "../../evals/routing/run";
import {
  MAIN_MODEL, TOKEN_CAP, assertRealAllowed, checkAnswer, estimateRealRun, parseJudge, runEval, verdict, writeReport,
  type ArmAnswer, type BotDriver, type Judge, type JudgeInput, type JudgeOutput,
} from "../../evals/routing/real";
import { runRealEval } from "../../evals/routing/real-sdk";

/** The real routing eval's runner, offline: a fake Bot and a fake judge. No model call. */

const use = (input: number, output = 50) => ({ fresh: 0, cacheRead: 0, cacheWrite: input, output });
const answer = (text: string, model: string, over: Partial<ArmAnswer> = {}): ArmAnswer => ({
  model, models: [model], text, sent: true, toolCalls: [], escalated: false, usage: use(10_000), ...over,
});

/** A right answer for each checkable prompt. */
const GOOD: Record<string, string> = { R04: "Canberra", R05: "Austen", R06: "366", R07: "391", R14: "Estimated", R15: "JST", R16: "Biscuit", R19: "verb noun" };

/** A Bot whose answer names the model it ran on; `per` overrides a case's answer per model. */
function fakeBot(per: Record<string, Partial<Record<string, Partial<ArmAnswer> & { text?: string }>>> = {}): BotDriver & { calls: { id: string; model: string }[] } {
  const calls: { id: string; model: string }[] = [];
  return {
    calls,
    async answer(c: RoutingCase, model: string) {
      calls.push({ id: c.id, model });
      const o = per[c.id]?.[model] ?? {};
      return answer(o.text ?? `${model === MAIN_MODEL ? "main" : "cheap"} reply ${GOOD[c.id] ?? "ok"}`, model, o);
    },
  };
}

/** Prefers the reply containing "main" unless told a case is a tie; records what it was shown. */
function fakeJudge(prefersMainOn: string[] = []): Judge & { seen: JudgeInput[] } {
  const seen: JudgeInput[] = [];
  return {
    seen,
    async judge(i: JudgeInput): Promise<JudgeOutput> {
      seen.push(i);
      const s = { correctness: 5, completeness: 5, instructions: 5, tone: 5 };
      const mainIs = i.a.startsWith("main") ? "A" : "B";
      const verdict = prefersMainOn.includes(i.prompt) ? mainIs : "tie";
      return { a: s, b: s, verdict, reason: "fake", usage: use(900, 120) };
    },
  };
}

let seed = 1;
const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

describe("routing eval (real runner, fake model)", () => {
  it("refuses to run without EVAL_REAL=1", () => {
    expect(() => assertRealAllowed({})).toThrow(/EVAL_REAL=1/);
    expect(() => assertRealAllowed({ EVAL_REAL: "yes" })).toThrow(/EVAL_REAL=1/);
    expect(() => assertRealAllowed({ EVAL_REAL: "1" })).not.toThrow();
  });

  it("the real entry refuses before it builds a Bot or calls a model", async () => {
    let built = false;
    await expect(runRealEval({ env: {}, onBuild: () => { built = true; } })).rejects.toThrow(/EVAL_REAL=1/);
    expect(built).toBe(false);
  });

  it("runs each routed prompt on Haiku and on the Bot's model, and never spends on a prompt that does not route", async () => {
    const cases = loadCases();
    const bot = fakeBot();
    const r = await runEval({ cases, driver: bot, judge: fakeJudge(), rng });
    const routedIds = r.cases.filter((c) => c.routed).map((c) => c.id);
    expect(routedIds.length).toBe(20);
    expect(bot.calls.length).toBe(40);
    for (const id of routedIds) expect(bot.calls.filter((x) => x.id === id).map((x) => x.model).sort()).toEqual([MAIN_MODEL, ROUTED_MODEL].sort());
    const hard = r.cases.filter((c) => !c.routed);
    expect(hard.length).toBe(20);
    for (const h of hard) expect(h.identicalPath).toBe(true);
    expect(bot.calls.some((x) => x.id.startsWith("H"))).toBe(false);
    expect(MAIN_MODEL).toBe("claude-sonnet-5[1m]");
  });

  it("judges blind: randomized A/B order, and the verdict is unblinded to routed/main", async () => {
    const cases = loadCases().filter((c) => c.label === "simple");
    const judge = fakeJudge(cases.map((c) => c.text));
    const r = await runEval({ cases, driver: fakeBot(), judge, rng });
    const orders = new Set(r.cases.map((c) => c.judge!.order));
    expect(orders).toEqual(new Set(["routed-first", "main-first"]));
    for (const c of r.cases) expect(c.judge!.winner).toBe("main");
    // The judge never sees which model wrote which reply.
    for (const s of judge.seen) expect(JSON.stringify(s)).not.toMatch(/haiku|sonnet|routed/i);
  });

  it("checks checkable prompts programmatically: expected content, length, a reply sent, no tool call", () => {
    const c: RoutingCase = { id: "X", text: "what's 17 times 23?", label: "simple", must: ["391"], maxChars: 20 };
    expect(checkAnswer(c, answer("391", ROUTED_MODEL))).toMatchObject({ must: true, length: true, sent: true, noTool: true, pass: true });
    expect(checkAnswer(c, answer("it is 390", ROUTED_MODEL))).toMatchObject({ must: false, missing: ["391"], pass: false });
    expect(checkAnswer(c, answer("391 391 391 391 391 391", ROUTED_MODEL)).length).toBe(false);
    expect(checkAnswer(c, answer("391", ROUTED_MODEL, { sent: false })).sent).toBe(false);
    expect(checkAnswer(c, answer("391", ROUTED_MODEL, { toolCalls: ["WebSearch"] })).noTool).toBe(false);
    expect(checkAnswer({ ...c, must: undefined }, answer("x", ROUTED_MODEL)).must).toBeNull();
  });

  it("a routed turn that fails before saying anything reruns on the Bot's model (escalation 2), tokens summed", async () => {
    const cases = loadCases().filter((c) => c.id === "R04");
    const bot = fakeBot({ R04: { [ROUTED_MODEL]: { text: "", sent: false, error: "overloaded" } } });
    const r = await runEval({ cases, driver: bot, judge: fakeJudge(), rng });
    expect(bot.calls.map((x) => x.model)).toEqual([ROUTED_MODEL, MAIN_MODEL, MAIN_MODEL]);
    const c = r.cases[0]!;
    expect(c.routedAnswer!.rerun).toBe(true);
    expect(c.routedAnswer!.usage.cacheWrite).toBe(20_000);
  });

  it("the decision rule: worse on at most 5% of routed prompts and no correctness failure on a checkable one", async () => {
    const simple = loadCases().filter((c) => c.label === "simple");
    const one = await runEval({ cases: simple, driver: fakeBot(), judge: fakeJudge([simple[0]!.text]), rng });
    expect(verdict(one)).toMatchObject({ pass: true, worse: [simple[0]!.id] });
    const two = await runEval({ cases: simple, driver: fakeBot(), judge: fakeJudge([simple[0]!.text, simple[1]!.text]), rng });
    expect(verdict(two).pass).toBe(false);
    const wrong = await runEval({ cases: simple, driver: fakeBot({ R07: { [ROUTED_MODEL]: { text: "cheap reply 390" } } }), judge: fakeJudge(), rng });
    const v = verdict(wrong);
    expect(v.pass).toBe(false);
    expect(v.correctnessFailures).toEqual(["R07"]);
    expect(v.failuresByCategory).toMatchObject({ fact: ["R07"] });
  });

  it("refuses a run whose estimate passes the cap, and stops a run that would pass it midway", async () => {
    const cases = loadCases();
    expect(estimateRealRun(cases).inputTokens).toBeLessThanOrEqual(TOKEN_CAP);
    await expect(runEval({ cases, driver: fakeBot(), judge: fakeJudge(), rng, cap: 100_000 })).rejects.toThrow(/estimate/);
    const r = await runEval({ cases, driver: fakeBot(), judge: fakeJudge(), rng, cap: 400_000, preflightCap: 1e9 });
    expect(r.stoppedForBudget).toBe(true);
    expect(r.tokens.total.allInput).toBeLessThanOrEqual(400_000);
    expect(verdict(r).pass).toBe(false);
    expect(verdict(r).incomplete).toBe(true);
  });

  it("parses the judge's JSON, fenced or not, and rejects a malformed one", () => {
    const j = '{"a":{"correctness":5,"completeness":4,"instructions":5,"tone":4},"b":{"correctness":3,"completeness":3,"instructions":4,"tone":5},"verdict":"A","reason":"a is right"}';
    expect(parseJudge(j).verdict).toBe("A");
    expect(parseJudge("Here:\n```json\n" + j + "\n```").b.correctness).toBe(3);
    expect(() => parseJudge('{"verdict":"maybe"}')).toThrow();
  });

  it("writes report.md and results.json with routed vs main tokens and the judge's separately", async () => {
    const r = await runEval({ cases: loadCases(), driver: fakeBot(), judge: fakeJudge(), rng });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-eval-"));
    const { md, json } = writeReport(dir, r);
    const data = JSON.parse(fs.readFileSync(json, "utf8"));
    expect(data.tokens.routed.cacheWrite).toBe(200_000);
    expect(data.tokens.main.cacheWrite).toBe(200_000);
    expect(data.tokens.judge.cacheWrite).toBe(18_000);
    expect(data.verdict.pass).toBe(true);
    const text = fs.readFileSync(md, "utf8");
    expect(text).toMatch(/Decision rule/);
    expect(text).toMatch(/PASS/);
  });
});
