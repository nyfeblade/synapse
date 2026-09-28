import { describe, expect, it } from "vitest";
import { CoordinatorHost, type CoordinatorProcess } from "../../src/main/coordinator-host";

type Handlers = { message?: (m: never) => void; exit?: (code: number) => void; error?: (e: unknown) => void };

function fakeFork() {
  const procs: { posted: { message: unknown; transfer?: unknown[] }[]; killed: boolean; h: Handlers }[] = [];
  const fork = (): CoordinatorProcess => {
    const h: Handlers = {};
    const p = { posted: [] as { message: unknown; transfer?: unknown[] }[], killed: false, h };
    procs.push(p);
    return {
      on: (ev: string, cb: never) => { (h as Record<string, unknown>)[ev] = cb; },
      postMessage: (message: unknown, transfer?: unknown[]) => p.posted.push({ message, transfer }),
      kill: () => { p.killed = true; },
    } as CoordinatorProcess;
  };
  return { procs, fork };
}

function setup() {
  const f = fakeFork();
  const timers: { fn: () => void; ms: number }[] = [];
  const messages: unknown[] = [];
  const respawns: number[] = [];
  const host = new CoordinatorHost({
    fork: f.fork,
    onMessage: (m) => messages.push(m),
    onRespawn: () => respawns.push(f.procs.length),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    now: () => 0,
  });
  const runTimers = () => { const ts = timers.splice(0); for (const t of ts) t.fn(); };
  return { ...f, host, timers, messages, respawns, runTimers };
}

describe("the coordinator process is supervised (concurrency)", () => {
  it("forks once and passes coordinator messages on", () => {
    const s = setup();
    expect(s.procs).toHaveLength(1);
    s.procs[0]!.h.message?.({ type: "badge", count: 2 } as never);
    expect(s.messages).toEqual([{ type: "badge", count: 2 }]);
  });

  it("re-forks after the coordinator dies, re-wires the renderer port and replays the connection", () => {
    const s = setup();
    s.host.postMessage({ type: "connect", baseUrl: "http://h", token: "t" });
    s.host.postMessage({ type: "focus", focused: true });
    s.procs[0]!.h.exit?.(1);
    expect(s.procs).toHaveLength(1); // backed off, not immediate
    s.runTimers();
    expect(s.procs).toHaveLength(2);
    expect(s.respawns).toEqual([2]); // main re-wires the MessagePort into the fresh process
    expect(s.procs[1]!.posted.map((p) => p.message)).toContainEqual({ type: "connect", baseUrl: "http://h", token: "t" });
    // Later traffic goes to the new process, not the dead one.
    s.host.postMessage({ type: "focus", focused: false });
    expect(s.procs[0]!.posted.map((p) => p.message)).not.toContainEqual({ type: "focus", focused: false });
    expect(s.procs[1]!.posted.map((p) => p.message)).toContainEqual({ type: "focus", focused: false });
  });

  it("a spawn error is treated like a death", () => {
    const s = setup();
    s.procs[0]!.h.error?.(new Error("fork failed"));
    s.runTimers();
    expect(s.procs).toHaveLength(2);
  });

  it("reports the death once, not once per listener", () => {
    const s = setup();
    s.procs[0]!.h.error?.(new Error("boom"));
    s.procs[0]!.h.exit?.(1);
    s.runTimers();
    expect(s.procs).toHaveLength(2);
  });

  it("does not re-fork after kill() on quit", () => {
    const s = setup();
    s.host.kill();
    expect(s.procs[0]!.killed).toBe(true);
    s.procs[0]!.h.exit?.(0);
    s.runTimers();
    expect(s.procs).toHaveLength(1);
  });
});
