import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDef } from "@synapse/shared";
import type { FireConsumer, FireRequest } from "../../routines/fire-consumer";
import type { RuntimeMetrics } from "../../metrics/runtime-metrics";
import type { RoutineRecord, RoutineStore } from "../../routines/routine-store";
import type { SchedulerDb } from "../../routines/scheduler-db";
import { EventQueue } from "../../triggers/event-queue";
import type { TriggerEvent } from "../../triggers/types";

function harness(def: Partial<RoutineDef> = {}, accept = true) {
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
  const consumer = { submit: (req: FireRequest) => { submitted.push(req); return { accepted: accept, runId: req.runId, reason: accept ? undefined : "disabled" }; } } as unknown as FireConsumer;
  const bumps: string[] = [];
  const metrics = { bump: (botId: string, f: string) => bumps.push(`${botId}:${f}`) } as unknown as RuntimeMetrics;
  const q = new EventQueue({
    store, db, consumer, metrics, now: () => Date.now(), workspace: "/workspace",
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
  });
  return { q, rec, rows, submitted, bumps };
}
const wh = (id: string, at = Date.now()): TriggerEvent => ({ source: "webhook", eventId: id, occurredAt: at, text: `body ${id}`, raw: {} });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000_000); });
afterEach(() => vi.useRealTimers());

describe("EventQueue (RTN-15)", () => {
  it("debounces 750 ms and coalesces a burst into one fire", () => {
    const h = harness();
    h.q.ingest(wh("a"));
    vi.advanceTimersByTime(400);
    h.q.ingest(wh("b"));
    h.q.ingest(wh("c"));
    vi.advanceTimersByTime(749);
    expect(h.submitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.submitted).toHaveLength(1);
    const f = h.submitted[0]!;
    expect(f.trigger).toBe("event");
    expect(f.events!.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
    expect(f.coalescedRunIds).toHaveLength(2);
    expect(f.coalescedRunIds).not.toContain(f.runId);
    expect(h.bumps).toEqual(["b1:coalescedTurns"]);
  });

  it("never holds the oldest event longer than 4 × 750 ms under a steady stream", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) { h.q.ingest(wh(`s${i}`)); vi.advanceTimersByTime(500); }
    expect(h.submitted.length).toBeGreaterThanOrEqual(1);
    expect(h.submitted[0]!.events!.length).toBeLessThanOrEqual(7);
  });

  it("dedupes the same source:eventId within 24 h, while pending and after the fire", () => {
    const h = harness();
    expect(h.q.ingest(wh("x"))[0]).toMatchObject({ duplicate: false });
    expect(h.q.ingest(wh("x"))[0]).toMatchObject({ duplicate: true });
    vi.advanceTimersByTime(750);
    expect(h.q.ingest(wh("x"))[0]).toMatchObject({ duplicate: true });
    expect([...h.rows.values()].some((r) => r.reason === "dedupe-marker" && r.dedupeKey === "webhook:x@b1/watch")).toBe(true);
    vi.setSystemTime(10_000_000 + 24 * 3_600_000 + 1000);
    expect(h.q.ingest(wh("x"))[0]).toMatchObject({ duplicate: false });
  });

  it("caps a wake at 25 events and the queue at 500, shedding the oldest", () => {
    const h = harness();
    for (let i = 0; i < 600; i++) h.q.ingest(wh(`e${i}`));
    const shed = [...h.rows.values()].filter((r) => r.reason === "event_batch_overflow");
    expect(shed).toHaveLength(100);
    vi.advanceTimersByTime(750);
    expect(h.submitted[0]!.events).toHaveLength(25);
    expect(h.submitted[0]!.events![0]!.eventId).toBe("e100");
    expect(h.q.pending("b1", "watch")).toBe(475);
    vi.advanceTimersByTime(750);
    expect(h.submitted).toHaveLength(2);
    expect(h.q.pending("b1", "watch")).toBe(450);
  });

  it("does not record dedupe markers when the consumer rejects the fire", () => {
    const h = harness({}, false);
    h.q.ingest(wh("r1"));
    vi.advanceTimersByTime(750);
    expect([...h.rows.values()].some((r) => r.reason === "dedupe-marker")).toBe(false);
    expect(h.q.ingest(wh("r1"))[0]).toMatchObject({ duplicate: false });
  });

  it("file routines fire at most once per 5 minutes", () => {
    const h = harness({ trigger: { file: { paths: ["inbox"], events: ["created"] } } });
    const fe = (id: string): TriggerEvent => ({ source: "file", eventId: id, occurredAt: Date.now(), kind: "created", path: `/workspace/inbox/${id}`, text: id, raw: {} });
    h.q.ingest(fe("1"));
    vi.advanceTimersByTime(750);
    h.q.ingest(fe("2"));
    vi.advanceTimersByTime(60_000);
    expect(h.submitted).toHaveLength(1);
    vi.advanceTimersByTime(4 * 60_000);
    expect(h.submitted).toHaveLength(2);
  });

  it("skips disabled routines and events older than the last save", () => {
    const h = harness({ enabled: false });
    expect(h.q.ingest(wh("d"))).toEqual([]);
    const h2 = harness({ createdAt: 20_000_000 });
    expect(h2.q.ingest(wh("old", 10_000_000))).toEqual([]);
  });
});
