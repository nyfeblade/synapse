import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITS5 } from "@synapse/shared";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import { Heartbeat } from "../../followups/heartbeat";
import { createFollowupsModule } from "../../followups/module";
import { FollowupStore, formatLocal, localToEpoch, parseFollowupLine } from "../../followups/store";

const TZ = "America/New_York";
let root: string;
let now: number;
let store: FollowupStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fu-"));
  now = localToEpoch("2026-09-14T07:00", TZ); // Monday 7:00 AM local
  store = new FollowupStore(root, () => now);
});

describe("follow-up ledger (ORIG-11 §11.1)", () => {
  it("parses extraction lines in the user's zone", () => {
    const p = parseFollowupLine("followup: 2026-09-18T10:00 | Check whether the landlord replied about the lease renewal.", TZ);
    expect(p).toEqual({ dueAt: Date.UTC(2026, 8, 18, 14, 0), what: "Check whether the landlord replied about the lease renewal." });
    expect(formatLocal(p!.dueAt, TZ)).toBe("2026-09-18 10:00");
    expect(parseFollowupLine("profile: likes jazz", TZ)).toBeNull();
    expect(parseFollowupLine(`followup: 2026-09-18T10:00 | ${"x".repeat(300)}`, TZ)!.what).toHaveLength(200);
  });

  it("keeps at most 50 open, dropping the oldest", () => {
    for (let i = 0; i < 52; i++) store.add("b", { what: `t${i}`, dueAt: now + i });
    expect(store.open("b")).toHaveLength(50);
    expect(store.open("b")[0]!.what).toBe("t2");
    expect(store.ingestExtractionOutput("b", "profile: x\nfollowup: 2026-09-20T09:00 | Ask about the offer\nNONE", TZ, "t5u")).toBe(1);
  });
});

describe("heartbeat gates (ORIG-11 §11.2): 7 days, 20 follow-ups", () => {
  it("wakes only in 9:00–20:00, never beyond 2 attempts, ≤ 2 messages per Bot per day", () => {
    for (let i = 0; i < 20; i++) store.add("b", { what: `item ${i}`, dueAt: now + i * 3600_000 });
    const woke: { at: number; text: string }[] = [];
    const hb = new Heartbeat({
      store, botIds: () => ["b"], optedIn: () => true, tz: () => TZ, now: () => now, isIdle: () => true,
      ladder: () => ({ level: () => "L0", usagePct: () => null, allowsBackground: () => true }),
      enqueueHidden: (botId, spec) => woke.push({ at: now, text: spec.text }),
    });
    hb.noteUserActive();
    const end = now + 7 * 86_400_000;
    for (; now < end; now += 30 * 60_000) {
      if (hb.tick().length) {
        // the Bot sends one message and marks nothing done: the host counts the attempt
        hb.onSettled({ botId: "b", source: "heartbeat", hidden: true, endedAt: now, sentTexts: ["Quick check-in"], result: {} } as never);
      }
    }
    for (const w of woke) {
      const h = Number(formatLocal(w.at, TZ).slice(11, 13));
      expect(h >= 9 && h < 20).toBe(true);
    }
    const perDay = new Map<string, number>();
    for (const w of woke) perDay.set(formatLocal(w.at, TZ).slice(0, 10), (perDay.get(formatLocal(w.at, TZ).slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(2);
    expect(store.list("b").every((f) => f.attempts <= 2)).toBe(true);
    expect(woke.length).toBeGreaterThan(0);
  });

  it("stays quiet for Bots that ran in the last 2 h, inactive owners, and at L2+", () => {
    store.add("b", { what: "x", dueAt: now - 1 });
    now = localToEpoch("2026-09-14T10:00", TZ);
    const mk = (o: { allows?: boolean; active?: boolean }) => {
      const woke: string[] = [];
      const hb = new Heartbeat({ store, botIds: () => ["b"], optedIn: () => true, tz: () => TZ, now: () => now, isIdle: () => true, ladder: () => ({ level: () => "L2", usagePct: () => 91, allowsBackground: () => o.allows ?? true }), enqueueHidden: (b) => woke.push(b) });
      if (o.active !== false) hb.noteUserActive();
      return { hb, woke };
    };
    expect(mk({ allows: false }).hb.tick()).toEqual([]);
    expect(mk({ active: false }).hb.tick()).toEqual([]);
    const recent = mk({});
    recent.hb.onSettled({ botId: "b", source: "user", hidden: false, endedAt: now - 3600_000, sentTexts: [], result: {} } as never);
    expect(recent.hb.tick()).toEqual([]);
    expect(mk({}).hb.tick()).toEqual(["b"]);
  });

  it("Fix round 1 finding 2: a heartbeat turn that never settles (error/no-lease) does not permanently block the Bot", () => {
    now = localToEpoch("2026-09-14T10:00", TZ); // inside the 9:00-20:00 wake window
    store.add("b", { what: "stuck item", dueAt: now - 1 });
    const woke: string[] = [];
    const hb = new Heartbeat({
      store, botIds: () => ["b"], optedIn: () => true, tz: () => TZ, now: () => now, isIdle: () => true,
      ladder: () => ({ level: () => "L0", usagePct: () => null, allowsBackground: () => true }),
      enqueueHidden: (botId) => woke.push(botId),
    });
    hb.noteUserActive();
    // First tick wakes the Bot; the turn then errors/loses its lease, so onSettled is never called
    // (mirrors turn-runner.ts's early returns at the acquire()-failure and post-catch result==null paths).
    expect(hb.tick()).toEqual(["b"]);
    // Without a timeout, `pending` for "b" is set forever and every subsequent tick skips it.
    now += LIMITS5.followupPendingTimeoutMs + 1;
    hb.noteUserActive();
    expect(hb.tick()).toEqual(["b"]);
  });
});

describe("update_state target followup (ORIG-11)", () => {
  it("adds, completes and drops follow-ups through the wrapped tool", async () => {
    const base = [{ name: "update_state", description: "d", readOnly: false, schema: { target: z.enum(["memory", "profile"]), action: z.string() }, handler: async () => ({ text: "base" }) }];
    const m = createFollowupsModule({ settings: { timeZone: () => TZ } } as never, { store, heartbeat: { onSettled: () => {}, noteUserActive: () => {} } as never });
    const [tool] = m.botTools!("b", () => null, base as never);
    expect((tool!.schema.target as unknown as { options: string[] }).options).toEqual(["memory", "profile", "followup"]);
    expect((await tool!.handler({ target: "profile", action: "set" })).text).toBe("base");
    const add = await tool!.handler({ target: "followup", action: "add", what: "Ask if the lease came back", due_at: "2026-09-16T10:00" });
    expect(add.text).toBe("Follow-up saved (id f1, due 2026-09-16 10:00).");
    expect((await tool!.handler({ target: "followup", action: "done", id: "f1" })).text).toBe("Marked f1 done.");
    expect((await tool!.handler({ target: "followup", action: "drop", id: "f9" })).isError).toBe(true);
  });
});

// P5 review minor: a follow-up is only ever saved for a Bot that opted in to proactive follow-ups.
describe("followups.add checks the opt-in", () => {
  it("refuses to save for a Bot that hasn't opted in", async () => {
    const { FollowupStore: Store } = await import("../../followups/store");
    const fs2 = await import("node:fs");
    const os2 = await import("node:os");
    const path2 = await import("node:path");
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "fu-opt-"));
    let on = false;
    const s = new Store(dir, () => 1, () => on);
    expect(() => s.add("b1", { what: "ping", dueAt: 5 })).toThrow(/follow-ups are off/i);
    expect(s.list("b1")).toEqual([]);
    on = true;
    expect(s.add("b1", { what: "ping", dueAt: 5 }).id).toBe("f1");
  });
});
