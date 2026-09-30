/**
 * The journeys list and the budget arithmetic (battle plan 5.9), kept free of Playwright and Electron so `npm test`
 * can check it cheaply (host/test/perf/journeys-budgets.test.ts).
 */
import { loadScaledBudget, median, type Calibration } from "../perf/robust-timing.ts";
import type { JourneyResult } from "./report.ts";

export interface JourneyDef { id: string; title: string; kind: "launch" | "session" }
export const JOURNEYS: JourneyDef[] = [
  { id: "cold-start", title: "Cold start to a ready chat", kind: "launch" },
  { id: "first-launch", title: "First launch to first message", kind: "launch" },
  { id: "first-reply", title: "Send a message to first reply", kind: "session" },
  { id: "switch-bot", title: "Switch Bot", kind: "session" },
  { id: "open-settings", title: "Open Settings (⌘,)", kind: "session" },
  { id: "search", title: "Search (⌘K)", kind: "session" },
  { id: "search-query", title: "Search: type a query to results", kind: "session" },
  { id: "approve-card", title: "Approve a card", kind: "session" },
  { id: "long-reply", title: "First reply in a 100-turn chat", kind: "session" },
  { id: "long-approve", title: "Approve a card in a 100-turn chat", kind: "session" },
  { id: "activity", title: "Open Activity", kind: "session" },
  { id: "usage", title: "Open Usage", kind: "session" },
  { id: "call-ui", title: "Start a call (UI only)", kind: "session" },
  { id: "model-picker", title: "Open the model picker", kind: "session" },
];

export interface Sample {
  /** Input to painted result, ms (renderer clock). */
  wallMs: number;
  /** Renderer main-thread CPU over the step, ms. */
  cpuMs: number;
  /** Long tasks (>= 50 ms) on the main thread during the step. */
  longTasks: number;
  /** Their total duration, ms. */
  longTaskMs: number;
}

export interface Budget { wallMs: number; cpuMs: number }
export interface BudgetFile {
  calibration: { cpuMs: number; wallMs: number };
  margin: { factor: number; launchFactor: number; wallFloorMs: number; cpuFloorMs: number };
  journeys: Record<string, Budget>;
  /** Bug 442: a journey's median may be at most `max` × another's, measured in the same run (so load cancels out).
   *  The long-chat journeys must stay near their short-chat twins. */
  relative?: Record<string, { of: string; max: number }>;
}

export const roundUp = (x: number, step: number) => Math.ceil(x / step) * step;

/** Median plus the margin: ×factor, and never tighter than median + floor (tiny medians need absolute room). */
export function budgetFrom(med: number, factor: number, floor: number): number {
  return roundUp(Math.max(med * factor, med + floor), med > 1000 ? 100 : 5);
}

export function judge(results: Record<string, Sample[]>, cal: Calibration, budgets: BudgetFile | null, strict: boolean): JourneyResult[] {
  // A slower (or throttled) machine does more CPU per unit of work; never scale budgets DOWN on a faster one.
  const speed = budgets ? Math.min(2, Math.max(1, cal.cpuMs / budgets.calibration.cpuMs)) : 1;
  return JOURNEYS.filter((j) => results[j.id]?.length).map((j) => {
    const xs = results[j.id]!;
    const r: JourneyResult = {
      id: j.id, title: j.title, runs: xs.length,
      wallMs: median(xs.map((x) => x.wallMs)), cpuMs: median(xs.map((x) => x.cpuMs)),
      longTasks: median(xs.map((x) => x.longTasks)), longTaskMs: median(xs.map((x) => x.longTaskMs)),
      samples: xs.map((x) => Math.round(x.wallMs * 10) / 10),
    };
    const b = budgets?.journeys[j.id];
    if (b) {
      r.budget = b;
      r.wallLimit = strict ? b.wallMs : loadScaledBudget(b.wallMs * speed, cal);
      r.cpuLimit = b.cpuMs * speed;
      r.pass = r.wallMs <= r.wallLimit && r.cpuMs <= r.cpuLimit;
    }
    const rel = budgets?.relative?.[j.id];
    const base = rel ? results[rel.of] : undefined;
    if (rel && base?.length) {
      r.ratio = r.wallMs / median(base.map((x) => x.wallMs));
      r.ratioLimit = rel.max;
      r.pass = (r.pass ?? true) && r.ratio <= rel.max;
    }
    return r;
  });
}

