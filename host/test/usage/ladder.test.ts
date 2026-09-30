import { describe, expect, it } from "vitest";
import { UsageLadder, parseResetsAt, routineOffsetMs } from "../../usage/ladder";

const HOUR = 3_600_000;
function setup(o: { pct?: number | null; cost?: number; budget?: number | null } = {}) {
  let now = 1_000_000_000_000;
  const trays: { title: string; dedupeKey?: string; buttons: { label: string; action: string }[] }[] = [];
  const degraded: number[] = [];
  const state = { pct: o.pct ?? null, cost: o.cost ?? 0, budget: o.budget ?? null, week: 42 };
  // usage.db's kv row that outlives the host process.
  let persisted: { dismissed: Record<string, number>; resumedWeek: number | null } = { dismissed: {}, resumedWeek: null };
  const usage = {
    // synapse-public: no Claude plan window; `pct` is the share of a $100 weekly budget spent.
    weekCostUsd: () => state.pct ?? state.cost, budgetUsd: () => (state.pct !== null ? 100 : state.budget), weekStart: () => state.week,
    ladderState: () => structuredClone(persisted), setLadderState: (s: typeof persisted) => { persisted = structuredClone(s); },
  } as never;
  const trayService = {
    add: (t: { title: string; dedupeKey?: string }) => {
      const existing = trays.find((x) => x.dedupeKey && x.dedupeKey === t.dedupeKey);
      if (existing) return existing;
      const tray = { ...t, buttons: [] };
      trays.push(tray);
      return tray;
    },
    list: () => trays, dismiss: () => {},
  } as never;
  // `pct` is the share of the monthly budget spent (the only budget); `cost`/`budget` give it as dollars.
  const monthBudgetPct = () => state.pct ?? (state.budget ? (state.cost / state.budget) * 100 : null);
  const make = () => new UsageLadder({ usage, trays: trayService, now: () => now, onReviewerDegraded: (u) => degraded.push(u), monthBudgetPct });
  const ladder = make();
  return {
    ladder, trays, degraded, state, advance: (ms: number) => { now += ms; }, now: () => now,
    /** What the user does in the UI: the host remembers the dismissal, then the tray leaves the list. */
    dismiss: (dedupeKey: string, l: { noteTrayDismissed(k: string | null): void } = ladder) => {
      l.noteTrayDismissed(dedupeKey);
      const i = trays.findIndex((x) => x.dedupeKey === dedupeKey);
      if (i >= 0) trays.splice(i, 1);
    },
    /** A fresh ladder over the same usage.db, i.e. the host restarted. */
    restart: make,
    titled: (title: string) => trays.filter((x) => x.title === title).length,
  };
}

describe("parseResetsAt (ORIG-14 §14.1)", () => {
  it("reads 'resets in N hours' and 'resets at <time>', else +5 h", () => {
    const now = Date.UTC(2026, 8, 18, 12);
    expect(parseResetsAt("You've hit your limit · resets in 3 hours", now)).toBe(now + 3 * HOUR);
    expect(parseResetsAt("limit reached, resets in 45 minutes", now)).toBe(now + 45 * 60_000);
    expect(parseResetsAt("resets at 2026-09-18T20:00:00Z", now)).toBe(Date.UTC(2026, 8, 18, 20));
    expect(parseResetsAt("usage limit reached", now)).toBe(now + 5 * HOUR);
  });
});

describe("UsageLadder levels and effects (§14.2)", () => {
  it("L0 → L1 at 80% with one tray per week, L2 at 90% pauses background work", () => {
    const t = setup({ pct: 79 });
    expect(t.ladder.level()).toBe("L0");
    t.state.pct = 80;
    t.ladder.evaluate();
    t.ladder.evaluate();
    expect(t.ladder.level()).toBe("L1");
    expect(t.trays.filter((x) => x.title === "You've used 80% of your monthly budget")).toHaveLength(1);
    expect(t.ladder.allowsBackground("dreaming")).toBe(true);
    t.state.pct = 91;
    expect(t.ladder.level()).toBe("L2");
    expect(t.ladder.allowsBackground("dreaming")).toBe(false);
    expect(t.ladder.allowsBackground("followups")).toBe(false);
    expect(t.ladder.routinePausedUntil("r1")).toBeNull();
  });

  it("L3 when the user's own budget is spent: routines pause until Resume; user turns unaffected", () => {
    const t = setup({ cost: 25, budget: 20 });
    t.ladder.evaluate();
    expect(t.ladder.level()).toBe("L3");
    expect(t.ladder.usagePct()).toBe(125);
    expect(t.trays.some((x) => x.title === "Routines on hold: the monthly budget is used up")).toBe(true);
    expect(t.ladder.routinePausedUntil("r1")).toBe(Number.POSITIVE_INFINITY);
    t.ladder.resumeRoutines();
    expect(t.ladder.routinePausedUntil("r1")).toBeNull();
  });

  it("L4 on a limit error: routines resume after resetsAt plus a stable 0–5 min offset; reviewer degraded until then", () => {
    const t = setup({ pct: 50 });
    t.ladder.noteLimitError("Claude usage limit reached · resets in 2 hours");
    expect(t.ladder.level()).toBe("L4");
    const until = t.now() + 2 * HOUR;
    expect(t.ladder.limitedUntil()).toBe(until);
    expect(t.degraded).toEqual([until]);
    expect(t.ladder.routinePausedUntil("r1")).toBe(until + routineOffsetMs("r1"));
    expect(routineOffsetMs("r1")).toBe(routineOffsetMs("r1"));
    expect(routineOffsetMs("r1")).toBeLessThan(5 * 60_000);
    t.advance(2 * HOUR + 1);
    expect(t.ladder.level()).toBe("L0");
  });

  it("an E0420 settled turn feeds noteLimitError; other errors don't", () => {
    const t = setup();
    t.ladder.onSettled({ result: { error: { code: "BOT-E0401", message: "overloaded" } } } as never);
    expect(t.ladder.level()).toBe("L0");
    t.ladder.onSettled({ result: { error: { code: "BOT-E0420", message: "resets in 1 hour" } } } as never);
    expect(t.ladder.level()).toBe("L4");
  });
});

import { createUsageModule } from "../../usage/module";
it("dismissTray resume-routines resumes its own budget tray and falls through otherwise (Phase 4 spend-guard trays too)", async () => {
  const t = setup({ cost: 30, budget: 20 });
  const calls: string[] = [];
  const trays: Record<string, { dedupeKey: string }> = { x: { dedupeKey: "budget:42" }, sg: { dedupeKey: "b1:spend-guard" } };
  const ctx = { hub: { publish: () => {} }, trays: { get: (id: string) => trays[id], dismiss: (id: string) => calls.push(`dismiss:${id}`) }, flags: () => ({ usageSource: "rate_limit_event" }) } as never;
  const usage = { weekly: () => ({ pct: null, resetsAt: null }), weekCostUsd: () => 30, budgetUsd: () => 20, weekStart: () => 42, plan: () => null, rows: () => [], efficiency: () => ({ dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 }) } as never;
  const m = createUsageModule(ctx, { usage, ladder: t.ladder });
  const wrapped = m.wrapHandlers!({ dismissTray: async () => { calls.push("base"); return {}; } });
  await wrapped.dismissTray!({ trayId: "x", action: "resume-routines" });
  await wrapped.dismissTray!({ trayId: "y" });
  await wrapped.dismissTray!({ trayId: "sg", action: "resume-routines" }); // Phase 4's spend guard owns this one
  expect(calls).toEqual(["dismiss:x", "base", "base"]);
  expect(t.ladder.routinePausedUntil("r")).toBeNull();
});

const USAGE80 = "You've used 80% of your monthly budget";
const BUDGET = "Routines on hold: the monthly budget is used up";
const LIMIT = "Usage limit reached";

describe("a dismissed ladder tray stays dismissed (§14.2)", () => {
  it("the 80% banner does not come back on later settled turns at the same level", () => {
    const t = setup({ pct: 85 });
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(1);
    t.dismiss("usage80:42");
    for (let i = 0; i < 5; i++) t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(0);
  });

  it("an escalation to a higher level surfaces it again; a drop back down does not", () => {
    const t = setup({ pct: 85 });
    t.ladder.evaluate();
    t.dismiss("usage80:42");
    t.state.pct = 95; // L1 → L2 is news
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(1);
    t.dismiss("usage80:42");
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(0);
    t.state.pct = 85; // back to L1: nothing new to say
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(0);
  });

  it("a new week surfaces it again", () => {
    const t = setup({ pct: 85 });
    t.ladder.evaluate();
    t.dismiss("usage80:42");
    t.state.week = 43;
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(1);
  });

  it("the dismissal survives a host restart", () => {
    const t = setup({ pct: 85 });
    t.ladder.evaluate();
    t.dismiss("usage80:42");
    const fresh = t.restart();
    fresh.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(0);
    t.state.pct = 95;
    fresh.onSettled({ result: {} } as never); // still escalates after a restart
    expect(t.titled(USAGE80)).toBe(1);
  });

  it("the budget tray stays dismissed for the week, across a restart, and Resume survives one too", () => {
    const t = setup({ cost: 30, budget: 20 });
    t.ladder.evaluate();
    expect(t.titled(BUDGET)).toBe(1);
    t.dismiss("budget:42");
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(BUDGET)).toBe(0);
    expect(t.restart().routinePausedUntil("r1")).toBe(Number.POSITIVE_INFINITY); // dismissing is not resuming
    t.restart().onSettled({ result: {} } as never);
    expect(t.titled(BUDGET)).toBe(0);

    const u = setup({ cost: 30, budget: 20 });
    u.ladder.evaluate();
    u.ladder.resumeRoutines();
    const fresh = u.restart();
    expect(fresh.routinePausedUntil("r1")).toBeNull();
    fresh.onSettled({ result: {} } as never);
    expect(u.titled(BUDGET)).toBe(1); // the one raised before Resume; no second one
  });

  it("the limit tray stays dismissed for the window the user saw, and a new lockout raises it again", () => {
    const t = setup({ pct: 50 });
    t.ladder.noteLimitError("usage limit reached · resets in 2 hours");
    expect(t.titled(LIMIT)).toBe(1);
    t.dismiss("usage-limit");
    t.advance(60_000);
    t.ladder.onSettled({ result: { error: { code: "BOT-E0420", message: "usage limit reached · resets in 2 hours" } } } as never);
    expect(t.titled(LIMIT)).toBe(0);
    t.advance(3 * HOUR);
    t.ladder.onSettled({ result: { error: { code: "BOT-E0420", message: "usage limit reached · resets in 2 hours" } } } as never);
    expect(t.titled(LIMIT)).toBe(1);
  });

  it("dismissTray with no action records the dismissal through the usage module", async () => {
    const t = setup({ pct: 85 });
    t.ladder.evaluate();
    expect(t.titled(USAGE80)).toBe(1);
    const trays: Record<string, { dedupeKey: string }> = { u: { dedupeKey: "usage80:42" } };
    const ctx = { hub: { publish: () => {} }, trays: { get: (id: string) => trays[id], dismiss: () => {} }, flags: () => ({ usageSource: "rate_limit_event" }) } as never;
    const usage = { weekly: () => ({ pct: 85, resetsAt: null }), weekCostUsd: () => 0, budgetUsd: () => null, weekStart: () => 42, plan: () => null, rows: () => [], efficiency: () => ({ dropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 }) } as never;
    const m = createUsageModule(ctx, { usage, ladder: t.ladder });
    const wrapped = m.wrapHandlers!({ dismissTray: async () => ({}) });
    await wrapped.dismissTray!({ trayId: "u" });
    t.trays.length = 0;
    t.ladder.onSettled({ result: {} } as never);
    expect(t.titled(USAGE80)).toBe(0);
  });
});

describe("the ladder counts the dollar budgets only", () => {
  const trays = { add: (t: object) => ({ ...t, buttons: [] }), list: () => [], dismiss: () => {} } as never;
  const usageAt = () => ({ weekCostUsd: () => 0, budgetUsd: () => null, weekStart: () => 1, ladderState: () => ({ dismissed: {}, resumedWeek: null }), setLadderState: () => {} }) as never;

  it("near the account's monthly budget background work slows (L1 at 80%, L2 at 90%)", () => {
    let month: number | null = 50;
    const l = new UsageLadder({ usage: usageAt(), trays, now: () => 1, monthBudgetPct: () => month });
    expect(l.level()).toBe("L0");
    month = 85;
    expect(l.level()).toBe("L1");
    month = 92;
    expect(l.level()).toBe("L2");
    expect(l.allowsBackground("dreaming")).toBe(false);
    month = null;
    expect(l.level()).toBe("L0");
  });

});

describe("review of new-user walk finding 7: one budget", () => {
  const trays = { add: (t: object) => ({ ...t, buttons: [] }), list: () => [], dismiss: () => {} } as never;
  it("the ladder reads the monthly budget only; a stale weekly amount changes nothing", () => {
    const usage = { weekCostUsd: () => 500, budgetUsd: () => 10, weekStart: () => 1, ladderState: () => ({ dismissed: {}, resumedWeek: null }), setLadderState: () => {} } as never;
    const l = new UsageLadder({ usage, trays, now: () => 1, monthBudgetPct: () => null });
    expect(l.level()).toBe("L0");
    expect(l.usagePct()).toBeNull();
  });

  it("there is no setWeeklyBudget command", () => {
    const ctx = { hub: { publish: () => {} }, trays: { get: () => undefined, dismiss: () => {} }, flags: () => ({ usageSource: "rate_limit_event" }) } as never;
    const m = createUsageModule(ctx, { usage: {} as never, ladder: {} as never });
    expect(Object.keys(m.handlers ?? {})).not.toContain("setWeeklyBudget");
  });
});
