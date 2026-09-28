import { describe, expect, it } from "vitest";
import { createPrepareBoxRestart, createSetBoxMaintenance } from "../../computer/restart";

// Portable install, fix round 1: the Mac re-provisions the box only while new turns are held (queued, answered
// after). The host holds them, reports which Bots still have a turn running, and shows a quiet status.
describe("setBoxMaintenance", () => {
  it("holds new turns, reports the running ones, shows the quiet status, and lets go", () => {
    const calls: string[] = [];
    let running = ["bot-a"];
    const set = createSetBoxMaintenance({
      runner: { holdNewTurns: (on) => calls.push(`hold:${on}`) },
      runningBotIds: () => running,
      status: { setMaintenance: (on) => calls.push(`status:${on}`) },
    });
    expect(set({ on: true })).toEqual({ runningBotIds: ["bot-a"] });
    running = [];
    expect(set({ on: true })).toEqual({ runningBotIds: [] });
    expect(set({ on: false })).toEqual({ runningBotIds: [] });
    expect(calls).toEqual(["hold:true", "status:true", "hold:true", "status:true", "hold:false", "status:false"]);
  });

  // Re-check: the hold is a LEASE. An app that crashed or quit mid-operation never leaves every Bot held forever.
  it("a hold that isn't renewed expires by itself, lets the queue run and logs it; a renewal extends it", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const set = createSetBoxMaintenance({
      runner: { holdNewTurns: (on) => calls.push(`hold:${on}`) },
      runningBotIds: () => [],
      status: { setMaintenance: (on) => calls.push(`status:${on}`) },
      log: (l) => logs.push(l),
    });
    set({ on: true, ttlMs: 80 });
    await wait(50);
    set({ on: true, ttlMs: 80 }); // renewed
    await wait(50);
    expect(calls).not.toContain("hold:false"); // 100 ms after the first hold, but only 50 after the renewal
    await wait(80);
    expect(calls.slice(-2)).toEqual(["hold:false", "status:false"]);
    expect(logs.join("\n")).toMatch(/expired/);
    // Released on purpose: no expiry fires later.
    set({ on: true, ttlMs: 30 });
    set({ on: false });
    const n = calls.length;
    await wait(60);
    expect(calls.length).toBe(n);
  });

  it("a hold without a lease still expires (the default lease)", () => {
    const set = createSetBoxMaintenance({ runner: { holdNewTurns: () => {} }, runningBotIds: () => [], status: { setMaintenance: () => {} } });
    expect(set.leaseMs({ on: true })).toBe(5 * 60_000);
    expect(set.leaseMs({ on: true, ttlMs: 10 * 60 * 60_000 })).toBe(30 * 60_000); // capped
  });
});

describe("prepareBoxRestart (CMP-11, EVT-19)", () => {
  it("refuses while Bots are busy unless forced, and enters the phase when it goes ahead", () => {
    const phases: string[] = [];
    let busy = ["bot-a"];
    const prep = createPrepareBoxRestart({ busyBotIds: () => busy, status: { setPhase: (p, s) => phases.push(`${p}:${s}`) } });
    expect(prep({ reason: "update", force: false })).toEqual({ ok: false, busyBotIds: ["bot-a"] });
    expect(phases).toEqual([]);
    expect(prep({ reason: "update", force: true })).toEqual({ ok: true, busyBotIds: ["bot-a"] });
    busy = [];
    expect(prep({ reason: "reset", force: false })).toEqual({ ok: true, busyBotIds: [] });
    expect(phases).toEqual(["updating:getting_ready", "resetting:getting_ready"]);
  });
});
