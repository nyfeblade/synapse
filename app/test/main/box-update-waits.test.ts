/**
 * Bug 258 item 3: box-update waits. The maintenance hold waits at most 2 minutes for running turns per update, and a
 * background re-provision doesn't start while the user has sent a message in the last 5 minutes: it is deferred and
 * tried again later. The host decides "recently" itself, atomically with taking the hold.
 */
import { describe, expect, it } from "vitest";
import { BoxOpsLock } from "../../src/main/setup/box-ops-lock";
import { HOLD_WAIT_CAP_MS, USER_QUIET_MS, reprovisionIfChanged } from "../../src/main/setup/reprovision";
import { DEFER_CAP_MS, createSetBoxMaintenance } from "../../../host/computer/restart";

describe("the hold is capped at 2 minutes per update", () => {
  it("HOLD_WAIT_CAP_MS is 2 minutes and the quiet window 5", () => {
    expect(HOLD_WAIT_CAP_MS).toBe(2 * 60_000);
    expect(USER_QUIET_MS).toBe(5 * 60_000);
  });

  it("lets go after 2 minutes of waiting for a busy Bot, not 3", async () => {
    let clock = 0;
    const order: string[] = [];
    const r = await reprovisionIfChanged({
      bundled: () => "b", boxVersion: async () => ({ ok: true, version: "a" }), callLive: () => false, lock: new BoxOpsLock(),
      hold: async (on) => { order.push(on ? `hold@${clock}` : "unhold"); return { runningBotIds: on ? ["b1"] : [] }; },
      provision: async () => { order.push("provision"); }, deploy: async () => {}, waitHealthy: async () => {}, verify: async () => ({ ok: true, failed: [] }),
      status: () => {}, log: () => {}, sleep: async (ms) => { clock += ms; }, now: () => clock, renew: () => () => {},
    });
    expect(r).toBe("retry-later");
    expect(order).not.toContain("provision");
    const lastHold = Number(order.filter((x) => x.startsWith("hold@")).at(-1)!.slice(5));
    expect(lastHold).toBeGreaterThanOrEqual(2 * 60_000);
    expect(lastHold).toBeLessThan(2 * 60_000 + 10_000);
  });
});

describe("no background re-provision right after the user wrote", () => {
  function hostWith(lastUserMessageAt: (number | null) | (() => number | null), now: number | (() => number)) {
    let held = false;
    const set = createSetBoxMaintenance({
      runner: { holdNewTurns: (on) => { held = on; } },
      runningBotIds: () => [],
      status: { setMaintenance: () => {} },
      lastUserMessageAt: typeof lastUserMessageAt === "function" ? lastUserMessageAt : () => lastUserMessageAt,
      now: typeof now === "function" ? now : () => now,
    });
    return { set, held: () => held };
  }

  it("host redeploy path: a deferred attempt that throws and releases (on:false) doesn't reset the 1-hour cap", () => {
    let t = 1_000_000;
    const h = hostWith(() => t - 60_000, () => t);
    // Each redeploy attempt: hold(true, quietMs) → deferred → throws → the catch releases (even the old code's
    // unconditional hold(false)) → retried 10 minutes later.
    const attempt = () => { const r = h.set({ on: true, quietMs: USER_QUIET_MS }); if (r.deferred) h.set({ on: false }); return r; };
    for (let i = 0; i < 6; i++) { expect(attempt().deferred, `attempt ${i}`).toBe(true); t += 10 * 60_000; }
    // Six attempts, 60 minutes: the cap fires now, even though every attempt released.
    expect(attempt().deferred).toBeFalsy();
    expect(h.held()).toBe(true);
  });

  it("after an hour of deferring, it goes ahead even while the user keeps chatting", () => {
    let t = 1_000_000;
    // The user keeps writing — always 1 minute ago, so always inside the quiet window.
    const h = hostWith(() => t - 60_000, () => t);
    expect(h.set({ on: true, quietMs: USER_QUIET_MS }).deferred).toBe(true);
    t += DEFER_CAP_MS - 1;
    expect(h.set({ on: true, quietMs: USER_QUIET_MS }).deferred).toBe(true); // still under the hour
    t += 2;
    expect(h.set({ on: true, quietMs: USER_QUIET_MS }).deferred).toBeFalsy(); // over the hour: it holds now
    expect(h.held()).toBe(true);
  });

  it("the host defers the hold when a user message came in the last 5 minutes, and takes it otherwise", () => {
    const busy = hostWith(1_000_000 - 60_000, 1_000_000);
    expect(busy.set({ on: true, quietMs: USER_QUIET_MS })).toMatchObject({ deferred: true, runningBotIds: [] });
    expect(busy.held()).toBe(false);
    const quiet = hostWith(1_000_000 - 6 * 60_000, 1_000_000);
    expect(quiet.set({ on: true, quietMs: USER_QUIET_MS }).deferred).toBeFalsy();
    expect(quiet.held()).toBe(true);
    const never = hostWith(null, 1_000_000);
    expect(never.set({ on: true, quietMs: USER_QUIET_MS }).deferred).toBeFalsy();
  });

  it("a renewal of a hold already taken is never deferred", () => {
    const h = hostWith(1_000_000 - 60_000, 1_000_000);
    const first = hostWith(null, 0);
    first.set({ on: true, quietMs: USER_QUIET_MS });
    expect(h.set({ on: true }).deferred).toBeFalsy();
    expect(h.held()).toBe(true);
  });

  it("re-provision asks for the quiet window, and a deferral releases the lock, starts nothing and retries later", async () => {
    const lock = new BoxOpsLock();
    const order: string[] = [];
    const r = await reprovisionIfChanged({
      bundled: () => "b", boxVersion: async () => ({ ok: true, version: "a" }), callLive: () => false, lock,
      hold: async (on, opts) => { order.push(on ? `hold:${opts?.quietMs ?? "-"}` : "unhold"); return on && opts?.quietMs ? { runningBotIds: [], deferred: true } : { runningBotIds: [] }; },
      provision: async () => { order.push("provision"); }, deploy: async () => {}, waitHealthy: async () => {}, verify: async () => ({ ok: true, failed: [] }),
      status: () => {}, log: () => {}, sleep: async () => {}, now: () => 0, renew: () => () => {},
    });
    expect(r).toBe("retry-later");
    expect(order).toEqual([`hold:${USER_QUIET_MS}`]);
    expect(lock.holder()).toBeNull();
  });

  it("when the user has been quiet it goes ahead as before", async () => {
    const order: string[] = [];
    const r = await reprovisionIfChanged({
      bundled: () => "b", boxVersion: async () => ({ ok: true, version: "a" }), callLive: () => false, lock: new BoxOpsLock(),
      hold: async (on) => { order.push(on ? "hold" : "unhold"); return { runningBotIds: [] }; },
      provision: async () => { order.push("provision"); }, deploy: async () => { order.push("deploy"); }, waitHealthy: async () => {}, verify: async () => ({ ok: true, failed: [] }),
      status: () => {}, log: () => {}, sleep: async () => {}, now: () => 0, renew: () => () => {},
    });
    expect(r).toBe("reprovisioned");
    expect(order).toContain("provision");
  });
});
