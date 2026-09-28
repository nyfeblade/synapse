import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDef } from "@synapse/shared";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { SchedulerDb } from "../../routines/scheduler-db";
import { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";

function harness(def: Partial<RoutineDef> = {}) {
  const rec: RoutineRecord = { botId: "b1", id: "watch", defHash: "h1", def: { name: "Watch", prompt: "p", trigger: { webhook: {} }, enabled: true, createdAt: 0, ...def } };
  const store = { get: (b: string, r: string) => (b === "b1" && r === "watch" ? rec : null), all: () => [rec] } as unknown as RoutineStore;
  const rows = new Map<string, { dedupeKey: string | null; state: string; reason: string | null; createdAt: number }>();
  const db = {
    claimFire: (f: { runId: string; dedupeKey: string | null; state?: string }, now: number) => {
      if (rows.has(f.runId) || [...rows.values()].some((r) => f.dedupeKey && r.dedupeKey === f.dedupeKey)) return false;
      rows.set(f.runId, { dedupeKey: f.dedupeKey, state: f.state ?? "claimed", reason: null, createdAt: now });
      return true;
    },
    setFireState: (id: string, state: string, reason: string | null) => { const r = rows.get(id); if (r) Object.assign(r, { state, reason }); },
    dedupeSeen: (key: string, since: number) => [...rows.values()].some((r) => r.dedupeKey === key && r.createdAt >= since),
  } as unknown as SchedulerDb;
  const submitted: FireRequest[] = [];
  const consumer = { submit: (req: FireRequest) => { submitted.push(req); return { accepted: true, runId: req.runId }; } } as unknown as FireConsumer;
  const capped: string[] = [];
  const q = new EventQueue({
    store, db, consumer, metrics: null, now: () => Date.now(), workspace: "/workspace",
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    onDailyCap: (botId, routineId) => capped.push(`${botId}/${routineId}`),
  });
  return { q, rows, submitted, capped };
}
const wh = (id: string): TriggerEvent => ({ source: "webhook", eventId: id, occurredAt: Date.now(), text: `body ${id}`, raw: {} });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000_000); });
afterEach(() => vi.useRealTimers());

describe("per-trigger daily cap", () => {
  it("stops starting turns after the cap in a rolling 24 h, then allows again", () => {
    const h = harness({ dailyCap: 2 });
    for (const id of ["a", "b", "c"]) {
      h.q.ingest(wh(id));
      vi.advanceTimersByTime(60_000); // separate wakes, not one coalesced batch
    }
    expect(h.submitted).toHaveLength(2);
    expect(h.capped).toEqual(["b1/watch"]);
    expect([...h.rows.values()].some((r) => r.reason === "daily_cap")).toBe(true);
    vi.advanceTimersByTime(24 * 3_600_000);
    h.q.ingest(wh("d"));
    vi.advanceTimersByTime(60_000);
    expect(h.submitted).toHaveLength(3);
  });

  it("uses the default cap when the routine sets none", () => {
    const h = harness();
    for (let i = 0; i < 52; i++) {
      h.q.ingest(wh(`e${i}`));
      vi.advanceTimersByTime(60_000);
    }
    expect(h.submitted).toHaveLength(50);
  });
});
