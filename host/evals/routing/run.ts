import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTurn, ROUTED_MODEL } from "../../brain/model-router";

/**
 * cost-diet-2 lever 1: the offline quality harness for model routing ("Save usage").
 *
 * OFFLINE (default, `--dry-run`, and what npm test runs): every fixed prompt goes through the router's own
 * deterministic signal. Pass = no hard case is ever routed (precision 1.0) and the simple cases that route are
 * counted (recall). It also prints the plan and the token cost of the real run below. No model call.
 *
 * REAL (`--real`, needs the user's approval; never run by a test or an agent on its own): each routed case is
 * answered twice by a real Bot turn on the same prompt and memory, once on the routed model and once on the
 * Bot's model, and judged against its expectation: `must` patterns present, reply length <= maxChars, a
 * SendMessage reply sent, no tool call (a tool call means the router misjudged a case as simple). Then a
 * blind pairwise judge (the Bot's model) says which reply is better or a tie. The routed model passes when it
 * meets every hard check the main model meets and the judge prefers the main model on at most 10% of cases.
 * That real runner is NOT built yet: it would drive a Bot through the gateway the way the coding bench does
 * (bench/coding/gateway-box.ts), with the Bot's Save usage switched on and off. `realPlan()` sizes it.
 */
export interface RoutingCase { id: string; text: string; label: "simple" | "hard"; must?: string[]; maxChars?: number; memory?: string[] }

const here = path.dirname(fileURLToPath(import.meta.url));
export function loadCases(file = path.join(here, "cases.jsonl")): RoutingCase[] {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RoutingCase);
}

export interface OfflineReport {
  cases: number;
  routed: string[];
  /** Hard cases the signal would route: must be empty. */
  falseSimple: string[];
  /** Simple cases kept on the main model (costs savings, never quality). */
  keptSimple: string[];
  precision: number; recall: number;
}

export function offline(cases = loadCases()): OfflineReport {
  const routed: string[] = [], falseSimple: string[] = [], keptSimple: string[] = [];
  for (const c of cases) {
    const simple = classifyTurn({ source: "user", lane: "user", text: c.text, images: 0 }).kind === "simple";
    if (simple) routed.push(c.id);
    if (simple && c.label === "hard") falseSimple.push(c.id);
    if (!simple && c.label === "simple") keptSimple.push(c.id);
  }
  const simpleCases = cases.filter((c) => c.label === "simple").length;
  return {
    cases: cases.length, routed, falseSimple, keptSimple,
    precision: routed.length ? (routed.length - falseSimple.length) / routed.length : 1,
    recall: simpleCases ? (simpleCases - keptSimple.length) / simpleCases : 1,
  };
}

/**
 * What the real run costs, from measured constants: a fresh everyday Bot's first call is 10,806 tokens on
 * sonnet-5 and 10,640 on Haiku 4.5 (EVERYDAY_PROFILE_MEASURED), all cache writes on a cold session; one reply
 * ~100 output tokens; the pairwise judge ~800 in / 150 out per case on the Bot's model.
 */
export function realPlan(cases = loadCases(), mainModel = "claude-sonnet-5") {
  const routed = offline(cases).routed.length;
  const turns = routed * 2;
  const input = routed * (10_806 + 10_640) + routed * 800;
  const output = turns * 100 + routed * 150;
  return { routedCases: routed, botTurns: turns, judgeCalls: routed, inputTokens: input, outputTokens: output, models: [ROUTED_MODEL, mainModel] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--real")) {
    process.stderr.write("The real routing eval spends model tokens and needs the user's approval; see realPlan() for its size. Not run.\n");
    process.exitCode = 2;
  } else {
    const r = offline();
    process.stdout.write(`${JSON.stringify({ offline: r, realPlan: realPlan() }, null, 2)}\n`);
    process.exitCode = r.falseSimple.length ? 1 : 0;
  }
}
