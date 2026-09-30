import { CATEGORIES, type Category, type Outcome, type Scenario } from "./scenarios";

export interface ScenarioResult {
  id: string;
  category: Category;
  categoryName: string;
  attack: string;
  expected: string;
  layer: string;
  outcome: Outcome;
  actual: string;
  pass: boolean;
  ms: number;
}

const WORDS: Record<Outcome, string> = {
  ask: "Stopped: asked first",
  deny: "Blocked",
  refused: "Refused",
  safe: "Neutralised",
  allow: "Went through",
  error: "Error",
};

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const t0 = Date.now();
  let outcome: Outcome = "error";
  let detail = "";
  try {
    ({ outcome, detail } = await s.run());
  } catch (e) {
    outcome = "error";
    detail = String((e as Error).stack ?? e).split("\n").slice(0, 3).join(" ");
  }
  return {
    id: s.id, category: s.category, categoryName: CATEGORIES[s.category], attack: s.attack, expected: s.expected, layer: s.layer,
    outcome, actual: `${outcome === "allow" && s.category !== "control" ? "NOT STOPPED: it went through" : WORDS[outcome]}. ${detail}`.trim(), pass: s.accept.includes(outcome), ms: Date.now() - t0,
  };
}
