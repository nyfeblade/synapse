import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingWakes } from "../../background/pending-wakes";
import { Revivals } from "../../background/revivals";
import type { HiddenSpec } from "../../runner/turn-runner";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pw-")), "host-pending-wakes.json");

describe("PendingWakes (EVT-16)", () => {
  it("persists markers in the spec shape and prunes entries older than 48 h", () => {
    let t = 1_000;
    const f = file();
    const p = new PendingWakes(f, () => t);
    p.add({ kind: "shell", botId: "b", taskId: "shell-1" });
    t += 49 * 3_600_000;
    p.add({ kind: "subagent", botId: "b", taskId: "subagent-x" });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ version: 1, pending: [
      { kind: "shell", botId: "b", taskId: "shell-1", createdAt: 1_000 },
      { kind: "subagent", botId: "b", taskId: "subagent-x", createdAt: 1_000 + 49 * 3_600_000 },
    ] });
    const pruned = new PendingWakes(f, () => t).prune();
    expect(pruned.map((w) => w.taskId)).toEqual(["shell-1"]);
    expect(new PendingWakes(f, () => t).list().map((w) => w.taskId)).toEqual(["subagent-x"]);
  });
});

describe("Revivals (EVT-02 #9, #10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches completions of one kind per Bot into one silence-allowed background turn, dedupes by task id, clears markers", () => {
    const p = new PendingWakes(file());
    p.add({ kind: "subagent", botId: "b", taskId: "subagent-1" });
    p.add({ kind: "subagent", botId: "b", taskId: "subagent-2" });
    const got: { botId: string; spec: HiddenSpec }[] = [];
    const r = new Revivals({ enqueueHidden: (botId, spec) => got.push({ botId, spec }), pending: p, batchMs: 1000 });
    r.complete({ kind: "subagent", botId: "b", taskId: "subagent-1", block: "Task “A” — done." });
    r.complete({ kind: "subagent", botId: "b", taskId: "subagent-1", block: "Task “A” — done." });
    vi.advanceTimersByTime(500);
    r.complete({ kind: "subagent", botId: "b", taskId: "subagent-2", block: "Task “B” — error." });
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(got).toHaveLength(1);
    expect(got[0]!.spec).toMatchObject({ source: "subagent-done", lane: "background", silenceAllowed: true });
    expect(got[0]!.spec.text).toBe("[Background task finished]\nTask “A” — done.\n\nTask “B” — error.\nTell the user about this only if it's new or relevant to what they asked; otherwise end your turn without a message.");
    got[0]!.spec.onStart?.(); // the revival turn actually started; only now is the result the Bot's
    expect(p.list()).toEqual([]);
  });

  // EVT-16: between flush() and the turn actually running, the revival exists only as an in-memory
  // RunScheduler task holding the rendered block. A quit or a crash in that window discards it, so
  // the durable marker is the only thing that can get the Bot its exit code / report back at boot.
  it("keeps the durable marker until the revival turn starts", () => {
    const p = new PendingWakes(file());
    p.add({ kind: "shell", botId: "b", taskId: "shell-1" });
    const got: HiddenSpec[] = [];
    const r = new Revivals({ enqueueHidden: (_b, s) => got.push(s), pending: p, batchMs: 1000 });
    r.complete({ kind: "shell", botId: "b", taskId: "shell-1", block: "Command `make` (shell-1) — exit code 0." });
    r.flushAll();

    expect(got).toHaveLength(1);
    expect(p.list().map((w) => w.taskId)).toEqual(["shell-1"]); // still replayable at boot
    got[0]!.onStart?.();
    expect(p.list()).toEqual([]);
  });

  it("shell completions use wake #10 and never mix with subagent batches", () => {
    const got: HiddenSpec[] = [];
    const r = new Revivals({ enqueueHidden: (_b, s) => got.push(s), pending: new PendingWakes(file()), batchMs: 1000 });
    r.complete({ kind: "shell", botId: "b", taskId: "shell-3", block: "Command `make` (shell-3) — exit code 0 after 12 s.\nFull output: /workspace/.bot/terminals/shell-3.txt" });
    r.complete({ kind: "subagent", botId: "b", taskId: "subagent-9", block: "Task “C” — done." });
    r.flushAll();
    expect(got.map((s) => s.source).sort()).toEqual(["shell-done", "subagent-done"]);
    expect(got.find((s) => s.source === "shell-done")!.text).toBe("[Background command finished]\nCommand `make` (shell-3) — exit code 0 after 12 s.\nFull output: /workspace/.bot/terminals/shell-3.txt");
  });
});
