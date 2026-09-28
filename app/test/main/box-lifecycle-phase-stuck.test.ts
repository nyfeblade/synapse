import { describe, expect, it } from "vitest";
import { STRC } from "@synapse/shared";
import { BoxLifecycle, type BoxOps, type LifecycleState } from "../../src/main/box-lifecycle";

function setup(o: { prepareRejects?: boolean; latestThrows?: boolean } = {}) {
  const states: LifecycleState[] = [];
  const ops: BoxOps = {
    restartMachine: async () => {}, recreateMachine: async () => {}, provision: async () => {},
    deploy: async () => {}, waitHealthy: async () => {},
  };
  const call = (async (cmd: string) => {
    if (cmd === "prepareBoxRestart") {
      if (o.prepareRejects) throw new Error("fetch failed");
      return { ok: true, busyBotIds: [] };
    }
    return {};
  }) as never;
  const snap = { id: "snap-abc123", createdAt: 1, bytes: 1, reason: "before_update" as const, parts: ["workspace", "home"] as const, sha256: "x" };
  const sink = {
    backupNow: async () => snap as never,
    push: async () => {},
    latest: () => { if (o.latestThrows) throw new Error("snapshots unreadable"); return snap as never; },
  };
  const lc = new BoxLifecycle({ ops, call, sink, publish: (s) => states.push(s), afterReconnect: async () => {} });
  return { lc, states };
}

// index.ts's backup timer only fires `if (lifecycle?.state().phase === "ready")`, and nothing ever
// re-publishes the phase on reconnect (startBoxOps only calls setDeps). A rejection before the
// try/catch therefore pinned the phase at resetting/updating for the life of the process and
// silently stopped every scheduled snapshot.
describe("BoxLifecycle never strands the phase when an early step rejects", () => {
  it("Reset: a rejected prepareBoxRestart returns the phase to ready with an error", async () => {
    const s = setup({ prepareRejects: true });
    await expect(s.lc.reset({ alsoBots: false })).rejects.toThrow("fetch failed");
    expect(s.lc.state().phase).toBe("ready");
    expect(s.lc.state().error).toContain(STRC.resetFailed);
    expect(s.states.at(-1)).toMatchObject({ phase: "ready", step: null });
  });

  it("Reset: a throwing sink.latest() returns the phase to ready with an error", async () => {
    const s = setup({ latestThrows: true });
    await expect(s.lc.reset({ alsoBots: false })).rejects.toThrow();
    expect(s.lc.state().phase).toBe("ready");
    expect(s.lc.state().error).toBeTruthy();
  });

  it("Update: a rejected prepareBoxRestart returns the phase to ready with an error", async () => {
    const s = setup({ prepareRejects: true });
    await expect(s.lc.update({ force: false })).rejects.toThrow("fetch failed");
    expect(s.lc.state().phase).toBe("ready");
    expect(s.lc.state().error).toContain(STRC.updateFailed);
  });

  it("a failed Reset leaves the lifecycle usable, so the next one can run", async () => {
    const s = setup({ prepareRejects: true });
    await expect(s.lc.reset({ alsoBots: false })).rejects.toThrow();
    expect(s.lc.state().phase).toBe("ready");
    await expect(s.lc.recover()).resolves.toBeUndefined();
    expect(s.lc.state()).toEqual({ phase: "ready", step: null, error: null });
  });
});
