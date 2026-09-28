import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type RoutineRun } from "@synapse/shared";
import { RoutineStore, defHash, slugify } from "../../routines/routine-store";
import { agentsDir, botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

function setup(now = () => 1_000) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const botId = randomUUID();
  fs.mkdirSync(botDir(cfg, botId), { recursive: true });
  const changes: [string, string | null][] = [];
  const store = new RoutineStore({ cfg, now, onChange: (b, r) => changes.push([b, r]) });
  return { cfg, botId, store, changes };
}
const def = (name: string) => ({ name, prompt: "Summarize my inbox.", schedule: "0 8 * * *", enabled: true });
const run = (id: string): RoutineRun => ({ id, trigger: "schedule", startedAt: 1, finishedAt: 2, status: "ok", requestId: `req_${id}` });

describe("slugify (RTN-01 ids)", () => {
  it("slugs the name, then -2…-999, then -<ts>", () => {
    expect(slugify("Morning Inbox Sweep!", new Set(), 5)).toBe("morning-inbox-sweep");
    expect(slugify("Morning inbox sweep", new Set(["morning-inbox-sweep"]), 5)).toBe("morning-inbox-sweep-2");
    const taken = new Set(["x"]);
    for (let i = 2; i <= 999; i++) taken.add(`x-${i}`);
    expect(slugify("x", taken, 1_726_000_000_000)).toBe("x-1726000000000");
    expect(slugify("***", new Set(), 5)).toBe("routine");
  });
});

describe("defHash (ORIG-02 §02.1)", () => {
  it("ignores key order and non-definition fields, changes with the definition", () => {
    const a = defHash({ name: "A", prompt: "p", schedule: "0 8 * * *", enabled: true });
    const b = defHash({ enabled: true, schedule: "0 8 * * *", prompt: "p", name: "A" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(defHash({ name: "A", prompt: "p", schedule: "0 9 * * *", enabled: true })).not.toBe(a);
    expect(defHash({ name: "A", prompt: "p", schedule: "0 8 * * *", enabled: false })).not.toBe(a);
  });
});

describe("RoutineStore", () => {
  it("creates automation.json under the Bot folder with createdAt, and lists it", () => {
    const { cfg, botId, store, changes } = setup();
    const r = store.create(botId, def("Morning inbox sweep"));
    expect(r).toMatchObject({ botId, id: "morning-inbox-sweep", def: { name: "Morning inbox sweep", enabled: true, createdAt: 1_000 } });
    const file = path.join(botDir(cfg, botId), "automations", "morning-inbox-sweep", "automation.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).prompt).toBe("Summarize my inbox.");
    expect(store.list(botId).map((x) => x.id)).toEqual(["morning-inbox-sweep"]);
    expect(store.all().map((x) => x.id)).toEqual(["morning-inbox-sweep"]);
    expect(changes).toEqual([[botId, "morning-inbox-sweep"]]);
  });

  it("returns null over the 50-routine cap (RTN-01)", () => {
    const { botId, store } = setup();
    for (let i = 0; i < 50; i++) expect(store.create(botId, def(`r${i}`))).not.toBeNull();
    expect(store.create(botId, def("one more"))).toBeNull();
    expect(store.list(botId)).toHaveLength(50);
  });

  it("updates, removes and removes a whole Bot's routines (RTN-23)", () => {
    const { botId, store } = setup();
    store.create(botId, def("A"));
    const u = store.update(botId, "a", { enabled: false, lastRunAt: 99 });
    expect(u.def).toMatchObject({ enabled: false, lastRunAt: 99, name: "A" });
    expect(u.defHash).toBe(defHash({ ...def("A"), enabled: false }));
    store.remove(botId, "a");
    expect(store.get(botId, "a")).toBeNull();
    store.create(botId, def("B"));
    store.removeBot(botId);
    expect(store.list(botId)).toEqual([]);
    expect(() => store.update(botId, "b", { enabled: true })).toThrow("No routine b");
  });

  it("keeps runs.json newest first, 20 max, and archives the overflow (≤1,000 lines)", () => {
    const { cfg, botId, store } = setup();
    store.create(botId, def("A"));
    for (let i = 1; i <= 25; i++) store.upsertRun(botId, "a", run(`r${i}`));
    const runs = store.runs(botId, "a");
    expect(runs).toHaveLength(20);
    expect(runs[0]!.id).toBe("r25");
    expect(runs[19]!.id).toBe("r6");
    store.upsertRun(botId, "a", { ...run("r25"), status: "error", detail: "x" });
    expect(store.runs(botId, "a")[0]).toMatchObject({ id: "r25", status: "error" });
    const archive = path.join(botDir(cfg, botId), "automations", "a", "runs-archive.jsonl");
    expect(fs.readFileSync(archive, "utf8").trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    for (let i = 26; i <= 1030; i++) store.upsertRun(botId, "a", run(`r${i}`));
    const lines = fs.readFileSync(archive, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[0]!).id).toBe("r11");
    // This loop's ~1,005 archive calls used to need a raised 45 s timeout: archive() does a real
    // fsync+rename per overflow write (fix round 1, finding 1), the suite's workers all queue on
    // the same device, and the fsyncs alone were 2,040 calls and 77.5% of the test's 17 s. The
    // suite runs with SYNAPSE_ATOMIC_FSYNC=off now (host/vitest.config.ts), so this is back on the
    // default budget and measures the archiving logic instead of the disk queue. The fsync is
    // still covered, with durability switched back on, by test/util/durable-writes.test.ts.
  });

  it("reports every run-history write through onRuns, not onChange, so an open detail sees live runs (RTN-18, Task 48)", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const botId = randomUUID();
    fs.mkdirSync(botDir(cfg, botId), { recursive: true });
    const changes: [string, string | null][] = [];
    const runsSeen: [string, string][] = [];
    const store = new RoutineStore({ cfg, now: () => 1_000, onChange: (b, r) => changes.push([b, r]), onRuns: (b, r) => runsSeen.push([b, r]) });
    store.create(botId, def("A"));
    changes.length = 0;
    store.upsertRun(botId, "a", { ...run("r1"), status: "running", finishedAt: null });
    store.upsertRun(botId, "a", run("r1"));
    expect(runsSeen).toEqual([[botId, "a"], [botId, "a"]]);
    expect(changes).toEqual([]); // a run is not a definition change: no scheduler reindex
    store.remove(botId, "a");
    store.upsertRun(botId, "a", run("r2")); // deleted mid-flight: nothing written, nothing reported
    expect(runsSeen).toHaveLength(2);
  });

  it("archives via atomic write (tmp+fsync+rename), never a truncating fs.writeFileSync (fix round 1, finding 1)", () => {
    const { cfg, botId, store } = setup();
    store.create(botId, def("A"));
    const archivePath = path.join(botDir(cfg, botId), "automations", "a", "runs-archive.jsonl");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");
    try {
      for (let i = 1; i <= 25; i++) store.upsertRun(botId, "a", run(`r${i}`));
      expect(writeFileSpy.mock.calls.some((c) => String(c[0]) === archivePath)).toBe(false);
      expect(renameSpy.mock.calls.some((c) => String(c[1]) === archivePath)).toBe(true);
      expect(fs.readFileSync(archivePath, "utf8").trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    } finally {
      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("rejects create() with a name over LIMITS.routineNameMax (fix round 1, finding 2)", () => {
    const { botId, store } = setup();
    const tooLong = "x".repeat(LIMITS.routineNameMax + 1);
    expect(store.create(botId, def(tooLong))).toBeNull();
    expect(store.list(botId)).toEqual([]);
    const exact = "x".repeat(LIMITS.routineNameMax);
    expect(store.create(botId, def(exact))).not.toBeNull();
  });

  it("rejects update() that would push name over LIMITS.routineNameMax (fix round 1, finding 2)", () => {
    const { botId, store } = setup();
    store.create(botId, def("A"));
    const tooLong = "x".repeat(LIMITS.routineNameMax + 1);
    expect(() => store.update(botId, "a", { name: tooLong })).toThrow(new RegExp(String(LIMITS.routineNameMax)));
    expect(store.get(botId, "a")!.def.name).toBe("A");
  });

  /**
   * Why this no longer writes a real file and waits for the OS.
   *
   * It used to arm store.watch() and then immediately write automation.json, polling for up to a
   * hand-picked 2 s. fs.watch(dir, { recursive: true }) on macOS is FSEvents, and it RETURNS BEFORE
   * THE STREAM IS ARMED — a write in that window is not delivered late, it is never delivered.
   * Measured under load in this repo: writing straight after fs.watch() returned lost the event
   * 2 times in 6; with a 50 ms head start, 0 in 6; and when it did fire, it fired in ~10 ms. So the
   * old 2 s was never a speed problem, and no larger number would have fixed it. FSEvents offers no
   * "armed" signal to wait on, which leaves sleeping or retrying — a guess or a papered-over race.
   *
   * The watcher is injected instead. That makes the parts this repo owns — which filenames count,
   * and the 50 ms debounce that coalesces a burst of writes into one reindex — exact and instant,
   * driven by the test rather than by the OS. What is deliberately NOT covered any more is "node's
   * fs.watch really does fire for this directory", which is Node's contract, not this store's, and
   * which the test could never observe reliably anyway. The registration itself is still asserted.
   */
  it("watch() registers one recursive watcher on the agents dir and stops it again", () => {
    const { cfg } = setup();
    const calls: [string, { recursive: true }][] = [];
    let closed = 0;
    const s = new RoutineStore({ cfg, now: () => 1_000, watch: (dir, opts) => { calls.push([dir, opts]); return { close: () => { closed += 1; } }; } });
    const stop = s.watch();
    expect(calls).toEqual([[agentsDir(cfg), { recursive: true }]]);
    stop();
    expect(closed).toBe(1);
  });

  it("watch() reports external edits to automation.json after a 50 ms debounce, and coalesces a burst into one", async () => {
    vi.useFakeTimers();
    try {
      const { cfg, botId, store, changes } = setup();
      store.create(botId, def("A"));
      changes.length = 0;
      let fire: ((event: string, filename: string | null) => void) | null = null;
      const s = new RoutineStore({ cfg, now: () => 1_000, onChange: (b, r) => changes.push([b, r]), watch: (_dir, _opts, cb) => { fire = cb; return { close: () => {} }; } });
      const stop = s.watch();
      const rel = path.join(botId, "automations", "a", "automation.json");

      fire!("change", rel);
      await vi.advanceTimersByTimeAsync(49);
      expect(changes).toEqual([]); // still inside the debounce window
      await vi.advanceTimersByTimeAsync(1);
      expect(changes).toEqual([[botId, "a"]]);

      // A burst of edits is one reindex, not one per write — that is what the debounce is for.
      changes.length = 0;
      for (let i = 0; i < 5; i++) { fire!("change", rel); await vi.advanceTimersByTimeAsync(10); }
      expect(changes).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(changes).toEqual([[botId, "a"]]);

      // Paths that are not a Bot's automation.json are ignored.
      changes.length = 0;
      fire!("change", path.join(botId, "automations", "a", "runs.json"));
      fire!("change", path.join(botId, "automations", "a"));
      fire!("change", path.join(botId, "memory", "a", "automation.json"));
      fire!("change", null);
      await vi.advanceTimersByTimeAsync(200);
      expect(changes).toEqual([]);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
