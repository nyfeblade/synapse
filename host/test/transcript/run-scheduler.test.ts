import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lane } from "../../brain/types";
import { RunScheduler, type RunTask } from "../../transcript/run-scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function task(id: string, lane: Lane, run: () => Promise<void> = async () => {}, groupMember = false): RunTask {
  return { id, lane, source: "user", acceptedAtMs: 0, groupMember, run };
}
const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };

// Portable install, box maintenance (fix round 1, blocker 1): while the Bots' computer is being re-provisioned,
// NEW runs are held — queued, never started, never dropped — and the one already running finishes. Released,
// the queue runs in the usual order.
describe("RunScheduler hold (box maintenance)", () => {
  it("queues new runs while held, lets the running one finish, and runs the queue on resume", async () => {
    let held = false;
    const order: string[] = [];
    const gate = deferred();
    const s = new RunScheduler({ onWatchdogInterrupt: () => {}, onEscape: () => {}, hold: () => held });
    s.enqueue(task("running", "user", async () => { order.push("running"); await gate.p; }));
    held = true;
    s.enqueue(task("queued", "user", async () => { order.push("queued"); }));
    gate.resolve();
    await vi.runAllTimersAsync();
    expect(order).toEqual(["running"]);
    expect(s.running()).toBe(false);
    expect(s.pending("user").map((t) => t.id)).toEqual(["queued"]);
    held = false;
    s.resume();
    await vi.runAllTimersAsync();
    expect(order).toEqual(["running", "queued"]);
    expect(s.isIdle()).toBe(true);
  });
});

describe("RunScheduler", () => {
  it("runs one task at a time in lane order user > agent > background, non-group user first", async () => {
    const order: string[] = [];
    const gate = deferred();
    const s = new RunScheduler({ onWatchdogInterrupt: () => {}, onEscape: () => {} });
    s.enqueue(task("first", "background", async () => { order.push("first"); await gate.p; }));
    s.enqueue(task("bg", "background", async () => { order.push("bg"); }));
    s.enqueue(task("ag", "agent", async () => { order.push("ag"); }));
    s.enqueue(task("grp", "user", async () => { order.push("grp"); }, true));
    s.enqueue(task("us", "user", async () => { order.push("us"); }));
    expect(s.active?.id).toBe("first");
    gate.resolve();
    await vi.runAllTimersAsync();
    expect(order).toEqual(["first", "us", "grp", "ag", "bg"]);
    expect(s.isIdle()).toBe(true);
  });

  it("head enqueue jumps the lane queue", async () => {
    const order: string[] = [];
    const gate = deferred();
    const s = new RunScheduler({ onWatchdogInterrupt: () => {}, onEscape: () => {} });
    s.enqueue(task("a", "user", async () => { await gate.p; }));
    s.enqueue(task("b", "user", async () => { order.push("b"); }));
    s.enqueue(task("nudge", "user", async () => { order.push("nudge"); }), { head: true });
    gate.resolve();
    await vi.runAllTimersAsync();
    expect(order).toEqual(["nudge", "b"]);
  });

  it("arms the watchdog only when a user task waits, interrupts after 120 s and escapes after 30 s more", async () => {
    const interrupts: string[] = [];
    const escapes: string[] = [];
    const ran: string[] = [];
    const s = new RunScheduler({ onWatchdogInterrupt: (t) => interrupts.push(t.id), onEscape: (t) => escapes.push(t.id) });
    s.enqueue(task("wedged", "background", () => new Promise<void>(() => {})));
    await vi.advanceTimersByTimeAsync(200_000);
    expect(interrupts).toEqual([]);
    s.enqueue(task("user", "user", async () => { ran.push("user"); }));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(interrupts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(interrupts).toEqual(["wedged"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(escapes).toEqual(["wedged"]);
    await vi.runAllTimersAsync();
    expect(ran).toEqual(["user"]);
  });

  it("calls onIdle when the queues drain and supports drop()", async () => {
    let idle = 0;
    const gate = deferred();
    const ran: string[] = [];
    const s = new RunScheduler({ onWatchdogInterrupt: () => {}, onEscape: () => {}, onIdle: () => { idle++; } });
    s.enqueue(task("a", "user", async () => { await gate.p; }));
    s.enqueue(task("b", "background", async () => { ran.push("b"); }));
    s.drop((t) => t.id === "b");
    gate.resolve();
    await vi.runAllTimersAsync();
    expect(ran).toEqual([]);
    expect(idle).toBe(1);
  });
});
