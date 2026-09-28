import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EfficiencyView } from "@synapse/shared";
import { RuntimeMetrics, weekStartOf } from "../../metrics/runtime-metrics";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "metrics-")), "runtime-metrics.db");
const NY = "America/New_York";

describe("weekStartOf (USE-05 weekly period)", () => {
  it("is Monday 00:00 local without a reset time", () => {
    const wed = Date.parse("2026-09-16T15:00:00Z"); // Wed Sep 16, 11:00 in New York
    expect(new Date(weekStartOf(wed, NY, null)).toISOString()).toBe("2026-09-14T04:00:00.000Z"); // Mon Sep 14 00:00 EDT
  });
  it("aligns to the weekly reset when known", () => {
    const reset = Date.parse("2026-09-18T17:00:00Z");
    const now = Date.parse("2026-09-20T12:00:00Z");
    expect(weekStartOf(now, NY, reset)).toBe(reset);
    expect(weekStartOf(Date.parse("2026-09-17T12:00:00Z"), NY, reset)).toBe(reset - 7 * 86_400_000);
  });
});

describe("RuntimeMetrics (ORIG-18 §18.7)", () => {
  it("computes the four tiles from the counters (stub: drops 3, inbox 2, batched 1, coalesced 1, loop 1 → 3 · 3 · 1 · 1)", () => {
    const changes: EfficiencyView[] = [];
    let now = Date.parse("2026-09-16T15:00:00Z");
    const m = new RuntimeMetrics(tmp(), { now: () => now, timeZone: () => NY, onChange: (v) => changes.push(v) });
    m.bump("a", "dropped", 2);
    m.bump("b", "dropped");
    m.bump("a", "inboxDelivered", 2);
    m.bump("b", "resultsBatched");
    m.bump("a", "coalescedTurns");
    m.bump("b", "loopsEnded");
    expect(m.efficiency()).toEqual({ weekStart: Date.parse("2026-09-14T04:00:00Z"), messagesDropped: 3, wakesAvoided: 3, burstsCoalesced: 1, loopsEnded: 1, wakesAvoidedTotal: 7 });
    expect(m.byBot().a).toEqual({ dropped: 2, inboxDelivered: 2, resultsBatched: 0, coalescedTurns: 1, loopsEnded: 0 });
    expect(changes.at(-1)!.loopsEnded).toBe(1);
    now += 7 * 86_400_000; // next week: zeros
    expect(m.efficiency()).toMatchObject({ messagesDropped: 0, wakesAvoided: 0, burstsCoalesced: 0, loopsEnded: 0 });
    m.close();
  });

  it("records bot-to-bot events and prunes them after 30 days", () => {
    let now = Date.parse("2026-09-01T00:00:00Z");
    const file = tmp();
    const m = new RuntimeMetrics(file, { now: () => now, timeZone: () => "UTC" });
    m.recordB2B({ botId: "a", chainId: "c_1", event: "dropped", reason: "G3" });
    m.recordB2B({ botId: "a", chainId: "c_1", event: "classifier_call" });
    expect(m.b2bCounts(0)).toEqual({ dropped: 1, classifier_call: 1 });
    now += 31 * 86_400_000;
    m.recordB2B({ botId: "a", chainId: "c_2", event: "sent", kind: "request" });
    expect(m.b2bCounts(0)).toEqual({ sent: 1 });
    m.close();
    const again = new RuntimeMetrics(file, { now: () => now, timeZone: () => "UTC" });
    expect(again.b2bCounts(0)).toEqual({ sent: 1 });
    again.close();
  });

  // getUsage is Phase 5's now (UsageView); the efficiency tiles it serves come from here: host/test/app-phase5-integration.test.ts.
});
