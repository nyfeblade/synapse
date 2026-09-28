import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BOT_MODEL, spawnModelId } from "@synapse/shared";
import { classifyTurn, ROUTED_MODEL } from "../../brain/model-router";
import type { RoutingCase } from "./run";

/**
 * cost-diet-2 lever 1: the REAL routing quality eval ("Save usage"), model-free core.
 *
 * For every prompt the router marks simple, the same Bot turn is answered twice: on the routed path (Haiku 4.5,
 * with the Bot's escalation rules) and on the Bot's own model. Prompts the router keeps on the main model take
 * the identical path either way, so they are recorded as identical and cost nothing. A blind pairwise judge
 * (Sonnet 5, randomized A/B) scores each pair; programmatic checks cover the prompts with a checkable answer.
 *
 * DECISION RULE (fixed before the run): "Save usage" may default ON only if the routed path is judged worse on
 * <= 5% of the routed prompts AND has no correctness failure (a `must` pattern missed) on a checkable prompt.
 * An incomplete run (stopped for budget) never passes.
 *
 * The model-facing parts (a Bot turn, the judge) are injected: real-sdk.ts drives them; the tests use fakes.
 */

/** The Bot's model as it is spawned. */
export const MAIN_MODEL = spawnModelId(DEFAULT_BOT_MODEL);
export const JUDGE_MODEL = MAIN_MODEL;
/** Hard ceiling on all input tokens (fresh + cache read + cache write) the run may spend, bots and judge together. */
export const TOKEN_CAP = 600_000;
/** Per routed prompt, from measured constants (EVERYDAY_PROFILE_MEASURED; run.ts realPlan) plus the judge. */
export const PER_CASE_INPUT = 10_806 + 10_640 + 1_500;
export const PER_CASE_OUTPUT = 2 * 150 + 250;
export const WORSE_MAX_RATE = 0.05;

export interface TokenUse { fresh: number; cacheRead: number; cacheWrite: number; output: number }
export interface ArmAnswer {
  /** The model the turn started on. */
  model: string;
  /** Every model that answered a call in the turn (escalation adds the main model). */
  models: string[];
  /** What the user saw: the SendMessage contents, joined. */
  text: string;
  sent: boolean;
  toolCalls: string[];
  /** Escalation 1: a tool other than SendMessage switched the rest of the turn to the main model. */
  escalated: boolean;
  /** Escalation 2: the routed turn failed before doing or saying anything and reran on the main model. */
  rerun?: boolean;
  usage: TokenUse;
  error?: string;
}
export interface BotDriver { answer(c: RoutingCase, model: string): Promise<ArmAnswer> }

export interface Scores { correctness: number; completeness: number; instructions: number; tone: number }
export interface JudgeInput { prompt: string; memory: string[]; a: string; b: string }
export interface JudgeOutput { a: Scores; b: Scores; verdict: "A" | "B" | "tie"; reason: string; usage: TokenUse }
export interface Judge { judge(i: JudgeInput): Promise<JudgeOutput> }

export interface CheckResult { must: boolean | null; missing: string[]; length: boolean; sent: boolean; noTool: boolean; pass: boolean }
export interface CaseResult {
  id: string; text: string; label: RoutingCase["label"]; category: string;
  routed: boolean; reason: string;
  /** Not routed: the "Save usage" path is the Bot's own model, byte for byte. Nothing spent. */
  identicalPath?: boolean;
  skipped?: "budget";
  routedAnswer?: ArmAnswer; mainAnswer?: ArmAnswer;
  checks?: { routed: CheckResult; main: CheckResult };
  judge?: { order: "routed-first" | "main-first"; winner: "routed" | "main" | "tie"; routed: Scores; main: Scores; reason: string; usage: TokenUse };
  error?: string;
}
export interface Totals extends TokenUse { allInput: number }
export interface EvalResult {
  startedAt: string; finishedAt: string; mainModel: string; routedModel: string; judgeModel: string;
  cap: number; estimate: { inputTokens: number; outputTokens: number };
  stoppedForBudget: boolean;
  cases: CaseResult[];
  tokens: { routed: Totals; main: Totals; judge: Totals; total: Totals };
  context?: Record<string, unknown>;
}

/** Simple-prompt categories, for reporting which kind failed. */
export const CATEGORY: Record<string, string> = {
  R01: "greeting", R02: "ack", R03: "greeting", R08: "ack", R09: "greeting", R10: "ack", R11: "ack", R18: "greeting", R20: "ack",
  R04: "fact", R05: "fact", R06: "fact", R07: "fact", R14: "fact", R15: "fact",
  R16: "memory", R12: "opinion", R13: "explain", R17: "opinion", R19: "explain",
};

export function assertRealAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.EVAL_REAL !== "1") throw new Error("refusing the real routing eval: it spends model tokens on the user's plan. Set EVAL_REAL=1 to run it (once, approved).");
}

const isRouted = (c: RoutingCase) => classifyTurn({ source: "user", lane: "user", text: c.text, images: 0 });

export function estimateRealRun(cases: RoutingCase[]): { routedCases: number; inputTokens: number; outputTokens: number } {
  const n = cases.filter((c) => isRouted(c).kind === "simple").length;
  return { routedCases: n, inputTokens: n * PER_CASE_INPUT, outputTokens: n * PER_CASE_OUTPUT };
}

export function checkAnswer(c: RoutingCase, a: ArmAnswer): CheckResult {
  const missing = (c.must ?? []).filter((p) => !new RegExp(p).test(a.text));
  const must = c.must?.length ? missing.length === 0 : null;
  const length = c.maxChars === undefined || a.text.length <= c.maxChars;
  const noTool = a.toolCalls.length === 0;
  return { must, missing, length, sent: a.sent, noTool, pass: must !== false && length && a.sent && noTool };
}

export function parseJudge(text: string): Omit<JudgeOutput, "usage"> {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
  const j = JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>;
  const scores = (x: unknown): Scores => {
    const o = (x ?? {}) as Record<string, unknown>;
    const out = {} as Scores;
    for (const k of ["correctness", "completeness", "instructions", "tone"] as const) {
      const v = Number(o[k]);
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`judge score ${k}=${String(o[k])} is not 1-5`);
      out[k] = v;
    }
    return out;
  };
  const v = String(j.verdict ?? "").trim();
  const verdict = /^a$/i.test(v) ? "A" : /^b$/i.test(v) ? "B" : /^tie$/i.test(v) ? "tie" : null;
  if (!verdict) throw new Error(`judge verdict "${v}" is not A, B or tie`);
  return { a: scores(j.a), b: scores(j.b), verdict, reason: String(j.reason ?? "") };
}

const zero = (): Totals => ({ fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, allInput: 0 });
const addTo = (t: Totals, u: TokenUse) => {
  t.fresh += u.fresh; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.output += u.output;
  t.allInput += u.fresh + u.cacheRead + u.cacheWrite;
};
const sumUse = (a: TokenUse, b: TokenUse): TokenUse => ({ fresh: a.fresh + b.fresh, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output });

export interface RunEvalOptions {
  cases: RoutingCase[]; driver: BotDriver; judge: Judge;
  /** [0,1) source for the blind A/B order. */
  rng?: () => number;
  cap?: number;
  /** The estimate must fit under this before anything runs (default: cap). */
  preflightCap?: number;
  memory?: string[];
  log?: (s: string) => void;
  context?: Record<string, unknown>;
}

export async function runEval(o: RunEvalOptions): Promise<EvalResult> {
  const cap = o.cap ?? TOKEN_CAP;
  const estimate = estimateRealRun(o.cases);
  if (estimate.inputTokens > (o.preflightCap ?? cap)) {
    throw new Error(`refusing: the estimate (${estimate.inputTokens} input tokens for ${estimate.routedCases} routed prompts) passes the cap of ${o.preflightCap ?? cap}`);
  }
  const rng = o.rng ?? Math.random;
  const log = o.log ?? (() => {});
  const tokens = { routed: zero(), main: zero(), judge: zero(), total: zero() };
  const spend = (bucket: Totals, u: TokenUse) => { addTo(bucket, u); addTo(tokens.total, u); };
  const r: EvalResult = {
    startedAt: new Date().toISOString(), finishedAt: "", mainModel: MAIN_MODEL, routedModel: ROUTED_MODEL, judgeModel: JUDGE_MODEL,
    cap, estimate: { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens }, stoppedForBudget: false, cases: [], tokens,
    ...(o.context ? { context: o.context } : {}),
  };
  let maxCase = 0;
  for (const c of o.cases) {
    const cls = isRouted(c);
    const base: CaseResult = { id: c.id, text: c.text, label: c.label, category: CATEGORY[c.id] ?? (c.label === "hard" ? "work" : "other"), routed: cls.kind === "simple", reason: cls.reason };
    r.cases.push(base);
    if (cls.kind !== "simple") { base.identicalPath = true; continue; }
    // Room for the next prompt: the estimate, or the dearest prompt so far if one cost more (a second call, a nudge).
    if (r.stoppedForBudget || tokens.total.allInput + Math.max(PER_CASE_INPUT, maxCase) > cap) {
      r.stoppedForBudget = true; base.skipped = "budget";
      continue;
    }
    const before = tokens.total.allInput;
    try {
      let routed = await o.driver.answer(c, ROUTED_MODEL);
      if (routed.error && !routed.sent && routed.toolCalls.length === 0) {
        // Escalation 2: rerun at once on the Bot's model; both attempts are the routed path's cost.
        const again = await o.driver.answer(c, MAIN_MODEL);
        routed = { ...again, model: ROUTED_MODEL, models: [...new Set([...routed.models, ...again.models])], rerun: true, usage: sumUse(routed.usage, again.usage), error: again.error ?? undefined };
        if (!routed.error) delete routed.error;
      }
      spend(tokens.routed, routed.usage);
      base.routedAnswer = routed;
      const main = await o.driver.answer(c, MAIN_MODEL);
      spend(tokens.main, main.usage);
      base.mainAnswer = main;
      base.checks = { routed: checkAnswer(c, routed), main: checkAnswer(c, main) };
      const routedFirst = rng() < 0.5;
      const j = await o.judge.judge({ prompt: c.text, memory: o.memory ?? c.memory ?? [], a: routedFirst ? routed.text : main.text, b: routedFirst ? main.text : routed.text });
      spend(tokens.judge, j.usage);
      const routedSide = routedFirst ? "A" : "B";
      base.judge = {
        order: routedFirst ? "routed-first" : "main-first",
        winner: j.verdict === "tie" ? "tie" : j.verdict === routedSide ? "routed" : "main",
        routed: routedFirst ? j.a : j.b, main: routedFirst ? j.b : j.a, reason: j.reason, usage: j.usage,
      };
      log(`${c.id} routed=${routed.models.join("+")} winner=${base.judge.winner} checks=${base.checks.routed.pass ? "ok" : "FAIL"} spent=${tokens.total.allInput}`);
    } catch (e) {
      base.error = String(e instanceof Error ? e.message : e);
      log(`${c.id} error: ${base.error}`);
    }
    maxCase = Math.max(maxCase, tokens.total.allInput - before);
  }
  r.finishedAt = new Date().toISOString();
  return r;
}

export interface Verdict {
  pass: boolean; incomplete: boolean;
  judged: number; worse: string[]; worseRate: number; allowedWorse: number;
  wins: number; ties: number; losses: number;
  correctnessFailures: string[];
  /** Routed checks that failed where the main model's passed (length, no reply, a tool call): reported, not in the rule. */
  otherCheckFailures: { id: string; failed: string[] }[];
  errors: string[];
  failuresByCategory: Record<string, string[]>;
}

export function verdict(r: EvalResult): Verdict {
  const routed = r.cases.filter((c) => c.routed);
  const judged = routed.filter((c) => c.judge);
  const worse = judged.filter((c) => c.judge!.winner === "main").map((c) => c.id);
  const wins = judged.filter((c) => c.judge!.winner === "routed").length;
  const ties = judged.filter((c) => c.judge!.winner === "tie").length;
  const correctnessFailures = routed.filter((c) => c.checks?.routed.must === false).map((c) => c.id);
  const otherCheckFailures = routed.flatMap((c) => {
    if (!c.checks) return [];
    const failed = (["length", "sent", "noTool"] as const).filter((k) => !c.checks!.routed[k] && c.checks!.main[k]);
    return failed.length ? [{ id: c.id, failed: [...failed] }] : [];
  });
  const errors = routed.filter((c) => c.error).map((c) => c.id);
  const incomplete = r.stoppedForBudget || errors.length > 0 || routed.some((c) => c.skipped);
  const failuresByCategory: Record<string, string[]> = {};
  for (const id of [...new Set([...worse, ...correctnessFailures])]) {
    const cat = r.cases.find((c) => c.id === id)!.category;
    (failuresByCategory[cat] ??= []).push(id);
  }
  const worseRate = judged.length ? worse.length / judged.length : 0;
  const allowedWorse = Math.floor(routed.length * WORSE_MAX_RATE + 1e-9);
  return {
    pass: !incomplete && judged.length > 0 && worseRate <= WORSE_MAX_RATE && correctnessFailures.length === 0,
    incomplete, judged: judged.length, worse, worseRate, allowedWorse, wins, ties, losses: worse.length,
    correctnessFailures, otherCheckFailures, errors, failuresByCategory,
  };
}

/** Relative price per token, in Haiku-input units (decisions.md cost-diet-2: Haiku $1 / Sonnet $2 in, output 5x; cache write 2x on the 1-hour cache, read 0.1x). */
export function weighted(u: TokenUse, model: string): number {
  const inPrice = /haiku/.test(model) ? 1 : /opus/.test(model) ? 5 : 2;
  return inPrice * (u.fresh + 2 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output);
}

function answerCost(a: ArmAnswer | undefined): number {
  if (!a) return 0;
  // A turn that escalated or reran was paid partly at the main model's price; charge the whole turn at the dearest model it touched (upper bound).
  const m = a.models.some((x) => !/haiku/.test(x)) ? MAIN_MODEL : a.model;
  return weighted(a.usage, m);
}

export function writeReport(dir: string, r: EvalResult): { md: string; json: string } {
  fs.mkdirSync(dir, { recursive: true });
  const v = verdict(r);
  const routed = r.cases.filter((c) => c.routed && c.routedAnswer && c.mainAnswer);
  const costRouted = routed.reduce((s, c) => s + answerCost(c.routedAnswer), 0);
  const costMain = routed.reduce((s, c) => s + answerCost(c.mainAnswer), 0);
  const saving = {
    allInputPct: r.tokens.main.allInput ? 1 - r.tokens.routed.allInput / r.tokens.main.allInput : 0,
    outputPct: r.tokens.main.output ? 1 - r.tokens.routed.output / r.tokens.main.output : 0,
    priceWeightedPct: costMain ? 1 - costRouted / costMain : 0,
  };
  const json = path.join(dir, "results.json");
  fs.writeFileSync(json, `${JSON.stringify({ ...r, verdict: v, saving }, null, 2)}\n`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const t = (x: Totals) => `${x.allInput.toLocaleString("en-US")} in (fresh ${x.fresh.toLocaleString("en-US")}, cache write ${x.cacheWrite.toLocaleString("en-US")}, cache read ${x.cacheRead.toLocaleString("en-US")}) / ${x.output.toLocaleString("en-US")} out`;
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);
  const sc = (s?: Scores) => (s ? `${s.correctness}/${s.completeness}/${s.instructions}/${s.tone}` : "");
  const lines = [
    `# Routing eval ("Save usage"), real run`,
    "",
    `${r.startedAt} to ${r.finishedAt}. Routed model ${r.routedModel}, Bot model ${r.mainModel}, judge ${r.judgeModel} (blind, randomized A/B).`,
    "",
    "## Decision rule (fixed before the run)",
    `"Save usage" may default ON only if the routed path is judged worse on <= 5% of the routed prompts (here <= ${v.allowedWorse} of ${r.cases.filter((c) => c.routed).length}) and has no correctness failure on a checkable prompt. An incomplete run never passes.`,
    "",
    `## Verdict: ${v.pass ? "PASS" : v.incomplete ? "INCOMPLETE (no verdict)" : "FAIL"}`,
    `- Judged ${v.judged}: routed better ${v.wins}, tie ${v.ties}, routed worse ${v.losses} (${pct(v.worseRate)})${v.worse.length ? `: ${v.worse.join(", ")}` : ""}`,
    `- Correctness failures on checkable prompts: ${v.correctnessFailures.length ? v.correctnessFailures.join(", ") : "none"}`,
    `- Other routed check failures the main model passed: ${v.otherCheckFailures.length ? v.otherCheckFailures.map((x) => `${x.id} (${x.failed.join(", ")})`).join("; ") : "none"}`,
    `- Failures by category: ${Object.keys(v.failuresByCategory).length ? Object.entries(v.failuresByCategory).map(([k, ids]) => `${k}: ${ids.join(", ")}`).join("; ") : "none"}`,
    ...(v.errors.length ? [`- Errors: ${v.errors.join(", ")}`] : []),
    ...(r.stoppedForBudget ? ["- Stopped early: the next prompt would have passed the token cap."] : []),
    `- Prompts not routed (${r.cases.filter((c) => c.identicalPath).length}): identical path on both settings, nothing spent.`,
    "",
    "## Tokens",
    `- Routed path (the ${routed.length} routed prompts): ${t(r.tokens.routed)}`,
    `- Bot's model, same prompts: ${t(r.tokens.main)}`,
    `- Judge: ${t(r.tokens.judge)}`,
    `- Total: ${t(r.tokens.total)} (cap ${r.cap.toLocaleString("en-US")}, estimate ${r.estimate.inputTokens.toLocaleString("en-US")})`,
    `- Saving on routed prompts: ${pct(saving.allInputPct)} of input tokens, ${pct(saving.outputPct)} of output, ${pct(saving.priceWeightedPct)} price-weighted`,
    "",
    "## Routed prompts",
    "| id | cat | prompt | routed reply | main reply | checks r/m | scores r (c/c/i/t) | scores m | winner | models r |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...r.cases.filter((c) => c.routed).map((c) => `| ${c.id} | ${c.category} | ${cell(c.text)} | ${cell(c.routedAnswer?.text ?? c.error ?? c.skipped ?? "")} | ${cell(c.mainAnswer?.text ?? "")} | ${c.checks ? `${c.checks.routed.pass ? "ok" : "FAIL"}/${c.checks.main.pass ? "ok" : "FAIL"}` : ""} | ${sc(c.judge?.routed)} | ${sc(c.judge?.main)} | ${c.judge?.winner ?? ""} | ${c.routedAnswer ? `${c.routedAnswer.models.join("+")}${c.routedAnswer.escalated ? " (escalated)" : ""}${c.routedAnswer.rerun ? " (rerun)" : ""}` : ""} |`),
    "",
    "## Judge reasons where the routed reply lost",
    ...(v.worse.length ? r.cases.filter((c) => v.worse.includes(c.id)).map((c) => `- ${c.id}: ${cell(c.judge!.reason)}`) : ["- none"]),
    "",
  ];
  const md = path.join(dir, "report.md");
  fs.writeFileSync(md, lines.join("\n"));
  return { md, json };
}
