import { describe, expect, it } from "vitest";
import { BoxOpsLock } from "../../src/main/setup/box-ops-lock";
import { releaseStaleHold, reprovisionIfChanged, provisionVersionDiffers, type ReprovisionStatus } from "../../src/main/setup/reprovision";
import { createSetBoxMaintenance } from "../../../host/computer/restart";

// Portable install, app updates: the box's setup (provision.sh + box/files) is versioned like the host build.
// When the bundle carries a different version than the box records, the app re-runs the idempotent provision
// IN PLACE, then deploys, then verifies. Fix round 1: it never cuts a Bot's turn — new turns are HELD on the
// host for the whole run (queued, answered after) and running ones finish first — it takes the one
// box-operations lock, it only starts on a marker it actually READ, and a failure lets the held turns run.
describe("the provision version compare", () => {
  it("differs only when both sides are known and unequal; an old box with no record counts as different", () => {
    expect(provisionVersionDiffers("aaaa000000000000", "aaaa000000000000")).toBe(false);
    expect(provisionVersionDiffers("aaaa000000000000", "bbbb000000000000")).toBe(true);
    expect(provisionVersionDiffers("aaaa000000000000", null)).toBe(true);
    expect(provisionVersionDiffers(null, "bbbb000000000000")).toBe(false); // a bundle that can't say: never guess
  });
});

describe("re-provisioning in the background", () => {
  function harness(o: {
    bundled?: string | null; read?: { ok: true; version: string | null } | { ok: false };
    running?: number; callLive?: number; failAt?: "provision" | "deploy"; verifyOk?: boolean; lock?: BoxOpsLock; onSleep?: () => void;
  } = {}) {
    const order: string[] = [];
    const status: ReprovisionStatus[] = [];
    let running = o.running ?? 0;
    let callLive = o.callLive ?? 0;
    const lock = o.lock ?? new BoxOpsLock();
    let clock = 0;
    let renewFn: (() => void) | null = null;
    const run = reprovisionIfChanged({
      bundled: () => (o.bundled === undefined ? "bbbb000000000000" : o.bundled),
      boxVersion: async () => { order.push("read"); return o.read ?? { ok: true, version: "aaaa000000000000" }; },
      callLive: () => { if (callLive > 0) { callLive--; order.push("call-live"); return true; } return false; },
      lock,
      hold: async (on) => {
        order.push(on ? "hold" : "unhold");
        if (!on) return { runningBotIds: [] };
        if (running > 0) { running--; return { runningBotIds: ["b1"] }; }
        return { runningBotIds: [] };
      },
      provision: async () => { order.push("provision"); if (o.failAt === "provision") throw new Error("apt failed"); },
      deploy: async () => { order.push("deploy"); if (o.failAt === "deploy") throw new Error("npm failed"); },
      waitHealthy: async () => { order.push("healthy"); },
      verify: async () => { order.push("verify"); return o.verifyOk === false ? { ok: false, failed: ["gh installed"] } : { ok: true, failed: [] }; },
      status: (s) => status.push(s),
      log: () => {},
      sleep: async (ms) => { order.push("sleep"); clock += ms; o.onSleep?.(); },
      now: () => clock,
      renew: (fn, ms) => { order.push(`renew-every:${ms}`); renewFn = fn; return () => { order.push("renew-stop"); renewFn = null; }; },
    });
    return { run, order, status, lock, renewing: () => renewFn };
  }

  it("does nothing when the box is current", async () => {
    const h = harness({ read: { ok: true, version: "bbbb000000000000" } });
    expect(await h.run).toBe("current");
    expect(h.order).toEqual(["read"]);
    expect(h.status).toEqual([]);
  });

  it("does nothing when the bundle can't say what it ships", async () => {
    const h = harness({ bundled: null });
    expect(await h.run).toBe("skipped");
    expect(h.order).toEqual([]);
  });

  it("a marker it couldn't READ is not a difference: retry later, never a full re-provision", async () => {
    const h = harness({ read: { ok: false } });
    expect(await h.run).toBe("retry-later");
    expect(h.order).toEqual(["read"]);
    expect(h.status).toEqual([]);
  });

  it("holds new turns first, waits for the running ones, then provision → deploy → healthy → verify, then lets turns run", async () => {
    const h = harness({ running: 2 });
    expect(await h.run).toBe("reprovisioned");
    expect(h.order).toEqual(["read", "hold", "renew-every:60000", "sleep", "hold", "sleep", "hold", "provision", "deploy", "healthy", "verify", "renew-stop", "unhold"]);
    expect(h.status.map((s) => s.phase)).toEqual(["waiting", "running", "done"]);
    expect(h.lock.holder()).toBeNull();
  });

  it("never starts while a call holds the microphone", async () => {
    const h = harness({ callLive: 2 });
    await h.run;
    expect(h.order.slice(0, 5)).toEqual(["read", "call-live", "sleep", "call-live", "sleep"]);
    expect(h.order.indexOf("hold")).toBeGreaterThan(h.order.lastIndexOf("call-live"));
  });

  it("a failed provision never deploys, lets the held turns run, resets, and says so once", async () => {
    const h = harness({ failAt: "provision" });
    expect(await h.run).toBe("failed");
    expect(h.order).not.toContain("deploy");
    expect(h.order.at(-1)).toBe("unhold");
    const failed = h.status.filter((s) => s.phase === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/apt failed/);
    expect(h.lock.holder()).toBeNull();
  });

  it("a verify failure is reported, not hidden, and the new host stays", async () => {
    const h = harness({ verifyOk: false });
    expect(await h.run).toBe("reprovisioned");
    expect(h.status.at(-1)?.phase).toBe("done-with-warnings");
  });

  it("waits while another box operation (Settings → Update, setup) holds the lock, and never overlaps it", async () => {
    const lock = new BoxOpsLock();
    const release = lock.tryAcquire("update")!;
    let sleeps = 0;
    // The other operation finishes after the re-provision has waited twice.
    const h = harness({ lock, onSleep: () => { if (++sleeps === 2) release(); } });
    expect(await h.run).toBe("reprovisioned");
    expect(h.order.indexOf("hold")).toBeGreaterThan(h.order.indexOf("sleep"));
    expect(lock.holder()).toBeNull();
  });

  // Re-check: the host's hold is a lease the app renews every minute while the operation runs.
  it("renews the hold every minute for the whole operation and stops renewing before letting go", async () => {
    const h = harness();
    await h.run;
    const i = h.order.indexOf("renew-every:60000");
    expect(i).toBe(h.order.indexOf("hold") + 1);
    expect(h.order.indexOf("renew-stop")).toBeGreaterThan(h.order.indexOf("verify"));
    expect(h.renewing()).toBeNull();
  });

  // Re-check: a Bot that keeps working must not keep every other Bot held. After 2 minutes (bug 258; it was 3) the hold
  // is let go (nothing restarted, no turn cut) and the whole re-provision is tried again later.
  it("gives up waiting for running turns after 2 minutes: releases the hold, deploys nothing, retries later", async () => {
    const h = harness({ running: Number.POSITIVE_INFINITY });
    expect(await h.run).toBe("retry-later");
    expect(h.order).not.toContain("provision");
    expect(h.order).not.toContain("deploy");
    expect(h.order.at(-1)).toBe("unhold");
    expect(h.order).toContain("renew-stop");
    expect(h.status.some((s) => s.phase === "failed")).toBe(false);
    expect(h.lock.holder()).toBeNull();
  });
});

describe("a hold nobody is renewing", () => {
  it("on connect, the app lets held turns run unless it is itself running a box operation", async () => {
    const calls: boolean[] = [];
    const hold = async (on: boolean) => { calls.push(on); return { runningBotIds: [] }; };
    const lock = new BoxOpsLock();
    expect(await releaseStaleHold({ lock, hold, log: () => {} })).toBe(true);
    expect(calls).toEqual([false]);
    const release = lock.tryAcquire("re-provision")!;
    expect(await releaseStaleHold({ lock, hold, log: () => {} })).toBe(false);
    expect(calls).toEqual([false]);
    release();
    // A host that can't be reached is not an error on connect.
    expect(await releaseStaleHold({ lock, hold: async () => { throw new Error("down"); }, log: () => {} })).toBe(false);
  });

  it("an app that crashes after provision but before deploy never leaves the Bots held: the next launch lets them go, and so does the lease", async () => {
    let held = false;
    const host = createSetBoxMaintenance({
      runner: { holdNewTurns: (on) => { held = on; } },
      runningBotIds: () => [],
      status: { setMaintenance: () => {} },
    });
    const run = (ttlMs: number) => reprovisionIfChanged({
      bundled: () => "bbbb000000000000",
      boxVersion: async () => ({ ok: true, version: "aaaa000000000000" }),
      callLive: () => false,
      lock: new BoxOpsLock(),
      hold: async (on) => host({ on, ttlMs }),
      provision: async () => {}, // the markers are written…
      deploy: () => new Promise<void>(() => {}), // …and the app dies here: deploy never returns, nothing is released
      waitHealthy: async () => {}, verify: async () => ({ ok: true, failed: [] }),
      status: () => {}, log: () => {},
      renew: () => () => {}, // a dead app renews nothing
    });
    void run(60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toBe(true);
    // The next launch (a new process: a fresh lock that nobody holds) connects and lets go.
    expect(await releaseStaleHold({ lock: new BoxOpsLock(), hold: async (on) => host({ on }), log: () => {} })).toBe(true);
    expect(held).toBe(false);
    // With no next launch at all, the lease runs out on its own.
    void run(40);
    await new Promise((r) => setTimeout(r, 20));
    expect(held).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(held).toBe(false);
  });
});

describe("the box-operations lock", () => {
  it("one operation at a time; a second is refused and told who holds it", () => {
    const lock = new BoxOpsLock();
    const release = lock.tryAcquire("re-provision");
    expect(release).not.toBeNull();
    expect(lock.tryAcquire("update")).toBeNull();
    expect(lock.holder()).toBe("re-provision");
    release!();
    expect(lock.holder()).toBeNull();
    const again = lock.tryAcquire("update");
    expect(again).not.toBeNull();
    release!(); // a stale release from the first holder must not free the second
    expect(lock.holder()).toBe("update");
  });
});
