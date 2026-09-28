import { describe, expect, it } from "vitest";
import type { ProcState, SupervisedBrain } from "../../brain/types";
import { deriveCaps, deriveMaxWarm } from "../../supervisor/caps";
import { Supervisor } from "../../supervisor/supervisor";

const GiB = 1024 ** 3;

class StubBrain implements SupervisedBrain {
  procState: ProcState = "cold";
  lastActiveAt = 0;
  lastEventAt = 0;
  turnStartedAt = 0;
  toolInFlight = false;
  pid: number | null = null;
  sessionId = null;
  cooled: string[] = [];
  interrupted = 0;
  private ls = new Set<(s: ProcState, p: ProcState) => void>();
  constructor(readonly botId: string) {}
  set(s: ProcState) { const p = this.procState; this.procState = s; for (const l of this.ls) l(s, p); }
  onStateChange(cb: (s: ProcState, p: ProcState) => void) { this.ls.add(cb); return () => this.ls.delete(cb); }
  async runTurn(): Promise<never> { throw new Error("not used"); }
  pushUserMessage() {}
  async interrupt() { this.interrupted++; }
  async cool(reason: string) { this.cooled.push(reason); this.set("cold"); }
  async dispose() { this.set("cold"); }
}

function setup(caps: Partial<{ maxLive: number; maxRunning: number; maxWarm: number }> = {}) {
  let t = 1_000_000;
  const brains = new Map<string, StubBrain>();
  const preempted: string[] = [];
  const backoff: string[] = [];
  const sup = new Supervisor({
    caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000, ...caps },
    brainFactory: (id) => { const b = new StubBrain(id); brains.set(id, b); return b; },
    now: () => t,
    onPreempt: (id) => preempted.push(id),
    onCrashBackoff: (id) => backoff.push(id),
  });
  return { sup, brains, preempted, backoff, advance: (ms: number) => { t += ms; }, now: () => t };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("caps (ORIG-16 §16.4)", () => {
  it("derives maxLive and maxRunning", () => {
    expect(deriveCaps(8 * GiB, 4)).toEqual({ maxLive: 9, maxRunning: 6 });
    expect(deriveCaps(16 * GiB, 8)).toEqual({ maxLive: 22, maxRunning: 10 });
    expect(deriveCaps(4 * GiB, 2)).toEqual({ maxLive: 3, maxRunning: 4 });
  });
});

describe("warm cap (TTFT war room: warm sessions back on, RAM bounded)", () => {
  it("sizes the warm pool from RAM: ~10% of what's left after the host, at the measured ~400 MB per CLI, 1…3", () => {
    expect(deriveMaxWarm(16 * GiB)).toBe(3); // the box VM
    expect(deriveMaxWarm(4 * GiB)).toBe(1);
    expect(deriveMaxWarm(64 * GiB)).toBe(3);
  });
  it("keeps at most maxWarm idle processes: the least recently used ones cool first", async () => {
    const { sup, brains, advance, now } = setup({ maxWarm: 2 });
    for (const id of ["a", "b", "c"]) {
      const l = await sup.acquire(id, "user", 1);
      brains.get(id)!.set("warm_idle");
      brains.get(id)!.lastActiveAt = now() - { a: 30, b: 10, c: 20 }[id]!;
      l.release();
    }
    advance(1000);
    await sup.tick();
    expect(brains.get("a")!.cooled).toEqual(["warm cap"]);
    expect(brains.get("b")!.cooled).toEqual([]);
    expect(brains.get("c")!.cooled).toEqual([]);
  });
  it("a Bot leased while an earlier cool is still running is never cooled mid-turn (review fix round 1)", async () => {
    const { sup, brains, now } = setup({ maxWarm: 0 });
    for (const id of ["a", "b"]) {
      const l = await sup.acquire(id, "user", 1);
      brains.get(id)!.set("warm_idle");
      brains.get(id)!.lastActiveAt = now() - (id === "a" ? 20 : 10);
      l.release();
    }
    // "a" (LRU) cools first; its exit takes a while, and "b" gets a turn meanwhile.
    let lb: { release(): void } | null = null;
    const a = brains.get("a")!;
    a.cool = async (reason: string) => { a.cooled.push(reason); lb = await sup.acquire("b", "user", 2); a.set("cold"); };
    await sup.tick();
    expect(a.cooled).toEqual(["warm cap"]);
    expect(lb).not.toBeNull();
    expect(brains.get("b")!.cooled).toEqual([]); // leased mid-cap: left alone
    lb!.release();
  });
  it("a live voice call lowers the ceiling to 1, and the reviewer's warm pool counts against it", async () => {
    let call = false;
    let reviewerPool = 0;
    const brains = new Map<string, StubBrain>();
    const t = 1_000_000;
    const sup = new Supervisor({
      caps: { maxLive: 9, maxRunning: 6, warmIdleMs: 600_000, userPreemptAfterMs: 15_000, maxWarm: 3 },
      brainFactory: (id) => { const b = new StubBrain(id); brains.set(id, b); return b; }, now: () => t,
      warmLimit: () => (call ? 1 : 3), externalWarm: () => reviewerPool,
    });
    for (const [i, id] of ["a", "b", "c"].entries()) {
      const l = await sup.acquire(id, "user", 1);
      brains.get(id)!.set("warm_idle");
      brains.get(id)!.lastActiveAt = t - 30 + i;
      l.release();
    }
    await sup.tick();
    expect([...brains.values()].filter((b) => b.procState === "warm_idle").length).toBe(3);
    reviewerPool = 1;
    await sup.tick();
    expect(brains.get("a")!.cooled).toEqual(["warm cap"]);
    call = true;
    reviewerPool = 0;
    await sup.tick();
    expect(brains.get("b")!.cooled).toEqual(["warm cap"]);
    expect(brains.get("c")!.procState).toBe("warm_idle");
  });
  it("never cools a running or leased process for the cap", async () => {
    const { sup, brains, now } = setup({ maxWarm: 1 });
    const la = await sup.acquire("a", "user", 1);
    brains.get("a")!.set("warm_idle"); // leased: its turn is still being settled
    brains.get("a")!.lastActiveAt = now() - 50;
    const lb = await sup.acquire("b", "user", 1);
    brains.get("b")!.set("warm_idle");
    brains.get("b")!.lastActiveAt = now();
    lb.release();
    await sup.tick();
    expect(brains.get("a")!.cooled).toEqual([]);
    expect(brains.get("b")!.cooled).toEqual([]);
    la.release();
  });
});

describe("Supervisor admission", () => {
  it("creation spawns nothing; brainFor returns a cold brain", () => {
    const { sup } = setup();
    expect(sup.brainFor("a").procState).toBe("cold");
    expect(sup.counts()).toEqual({ live: 0, running: 0, queued: 0 });
  });

  it("respects maxRunning and admits the next waiter on release", async () => {
    const { sup } = setup({ maxRunning: 2 });
    const a = await sup.acquire("a", "user", 1);
    await sup.acquire("b", "user", 2);
    let cGranted = false;
    void sup.acquire("c", "user", 3).then(() => { cGranted = true; });
    await flush();
    expect(cGranted).toBe(false);
    a.release();
    await flush();
    expect(cGranted).toBe(true);
  });

  it("admits by lane (user > agent > background), then acceptedAt", async () => {
    const { sup } = setup({ maxRunning: 1 });
    const first = await sup.acquire("x", "background", 1);
    const order: string[] = [];
    void sup.acquire("bg", "background", 2).then((l) => { order.push("bg"); l.release(); });
    void sup.acquire("ag", "agent", 3).then((l) => { order.push("ag"); l.release(); });
    void sup.acquire("us", "user", 4).then((l) => { order.push("us"); l.release(); });
    await flush();
    first.release();
    for (let i = 0; i < 10; i++) await flush();
    expect(order).toEqual(["us", "ag", "bg"]);
  });

  it("evicts the least-recently-used warm Bot when maxLive is reached", async () => {
    const { sup, brains } = setup({ maxLive: 2 });
    for (const [id, at] of [["a", 10], ["b", 20]] as const) {
      const l = await sup.acquire(id, "user", at);
      const b = brains.get(id)!;
      b.set("warm_idle");
      b.lastActiveAt = at;
      l.release();
    }
    await sup.acquire("c", "user", 30);
    expect(brains.get("a")!.cooled).toEqual(["evicted (LRU)"]);
    expect(brains.get("b")!.cooled).toEqual([]);
  });

  it("asks to preempt the youngest background turn after a user waits 15 s", async () => {
    const { sup, preempted, advance } = setup({ maxRunning: 1 });
    await sup.acquire("routine-bot", "background", 1);
    void sup.acquire("user-bot", "user", 2);
    await flush();
    advance(14_000);
    await sup.tick();
    expect(preempted).toEqual([]);
    advance(2_000);
    await sup.tick();
    await sup.tick();
    expect(preempted).toEqual(["routine-bot"]);
  });

  it("backs a Bot off for 60 s after 3 crashes in 10 min", async () => {
    const { sup, brains, backoff, advance } = setup();
    const l = await sup.acquire("a", "user", 1);
    const b = brains.get("a")!;
    for (let i = 0; i < 3; i++) { b.set("crashed"); b.set("cold"); }
    l.release();
    expect(backoff).toEqual(["a"]);
    let granted = false;
    void sup.acquire("a", "user", 2).then(() => { granted = true; });
    await flush();
    expect(granted).toBe(false);
    advance(60_001);
    await sup.tick();
    await flush();
    expect(granted).toBe(true);
  });

  it("cools warm Bots idle for 10 minutes", async () => {
    const { sup, brains, advance, now } = setup();
    const l = await sup.acquire("a", "user", 1);
    brains.get("a")!.set("warm_idle");
    brains.get("a")!.lastActiveAt = now();
    l.release();
    advance(600_001);
    await sup.tick();
    expect(brains.get("a")!.cooled).toEqual(["idle"]);
  });
});
