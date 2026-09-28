import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyEdit, applyReference, benchDir, prepareTask, readTexts, snapshot, tmpDir } from "../../../bench/coding/repo";
import { PILOT, sessionsFor, TASKS, taskById, type TextEdit } from "../../../bench/coding/suite";
import { tsc, verifyTask, vitest } from "../../../bench/coding/verify";

// Offline: builds sample repos in temp dirs and runs vitest/tsc inside them. No model is called.
const made: string[] = [];
const fresh = (tag: string) => { const d = tmpDir(tag); made.push(d); return d; };
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function hashesUnder(dir: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (ent.isFile() && ent.name !== ".delete") out.add(crypto.createHash("sha256").update(fs.readFileSync(path.join(ent.parentPath, ent.name))).digest("hex"));
  }
  return out;
}

describe("the task suite", () => {
  it("has 12-20 tasks with unique ids, every category, two traps, and a 6-task pilot", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(12);
    expect(TASKS.length).toBeLessThanOrEqual(20);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(new Set(TASKS.map((t) => t.category))).toEqual(new Set(["bugfix", "feature", "refactor", "tests", "cross-file", "question", "discover", "follow-up"]));
    expect(TASKS.filter((t) => t.trap)).toHaveLength(2);
    expect(PILOT).toHaveLength(6);
    for (const t of TASKS) expect(["easy", "medium", "hard"]).toContain(t.difficulty);
  });

  it("groups a follow-up into its predecessor's session and pulls the predecessor in", () => {
    expect(sessionsFor(["T11"]).map((s) => s.map((t) => t.id))).toEqual([["T10", "T11"]]);
    expect(sessionsFor(["T01", "T10", "T11"]).map((s) => s.map((t) => t.id))).toEqual([["T01"], ["T10", "T11"]]);
    expect(sessionsFor(["T10"]).map((s) => s.map((t) => t.id))).toEqual([["T10"]]);
    expect(() => taskById("T99")).toThrow(/unknown task/);
  });

  it("the sample repo's own tests and typecheck pass at the base ref", async () => {
    const dir = fresh("base");
    prepareTask(taskById("T04"), dir); // T04 starts at base
    const [t, c] = await Promise.all([vitest(dir, ["test/**/*.test.ts"]), tsc(dir)]);
    expect(t.tail).toMatch(/passed/);
    expect(t.pass).toBe(true);
    expect(c.pass, c.tail).toBe(true);
  }, 120_000);

  it("builds the same starting commit every time", () => {
    const a = prepareTask(taskById("T03"), fresh("sha-a"));
    const b = prepareTask(taskById("T03"), fresh("sha-b"));
    expect(a.startRef).toMatch(/^[0-9a-f]{40}$/);
    expect(a.startRef).toBe(b.startRef);
    expect(a.startTag).toBe("T03-start");
  });

  it("never puts hidden tests or reference solutions into a runner's repo", () => {
    const secret = new Set<string>();
    for (const t of TASKS) {
      for (const h of hashesUnder(path.join(benchDir(), "tasks", t.id, "hidden"))) secret.add(h);
      for (const h of hashesUnder(path.join(benchDir(), "reference-solutions", t.id))) secret.add(h);
    }
    expect(secret.size).toBeGreaterThan(10);
    for (const t of TASKS.filter((x) => !x.after)) {
      const dir = fresh(`leak-${t.id}`);
      prepareTask(t, dir);
      for (const [f, h] of snapshot(dir)) expect([t.id, f, secret.has(h)]).toEqual([t.id, f, false]);
    }
  });
});

describe.concurrent("the two trap tasks: the obvious fix passes the visible tests but fails hidden verification", () => {
  const shallow: Record<string, TextEdit[]> = {
    // leftover cents dumped on the last share
    T02: [{ file: "src/money.ts", find: "  return shares.map((s) => s * sign);", replace: "  shares[shares.length - 1]! += abs - shares.reduce((a, b) => a + b, 0);\n  return shares.map((s) => s * sign);" }],
    // widen the 1-30 bucket instead of fixing daysBetween
    T03: [
      { file: "src/config.ts", find: '{ key: "d1_30", label: "1-30", min: 1, max: 30 }', replace: '{ key: "d1_30", label: "1-30", min: 1, max: 31 }' },
      { file: "src/config.ts", find: '{ key: "d31_60", label: "31-60", min: 31, max: 60 }', replace: '{ key: "d31_60", label: "31-60", min: 32, max: 60 }' },
    ],
  };
  for (const [id, edits] of Object.entries(shallow)) {
    it(id, async () => {
      const task = taskById(id);
      expect(task.trap).toBeTruthy();
      const dir = fresh(`trap-${id}`);
      prepareTask(task, dir);
      const snap = snapshot(dir);
      for (const e of edits) applyEdit(dir, e);
      expect((await vitest(dir, ["test/**/*.test.ts"])).pass).toBe(true);
      const v = await verifyTask(task, dir, { snap, texts: readTexts(dir, snap) });
      expect(v.checks.find((c) => c.name === "hidden tests")?.pass).toBe(false);
      expect(v.pass).toBe(false);
    }, 120_000);
  }
});

describe.concurrent("hidden verification: FAILS at the start ref, PASSES on the reference solution", () => {
  for (const task of TASKS) {
    it(task.id, async () => {
      const dir = fresh(`v-${task.id}`);
      prepareTask(task, dir, { references: true });
      const snap = snapshot(dir);
      const start = { snap, texts: readTexts(dir, snap) };
      const atStart = await verifyTask(task, dir, start, { stopOnFail: true });
      expect(atStart.pass, `${task.id} passes at its start state`).toBe(false);
      applyReference(task, dir);
      const atRef = await verifyTask(task, dir, start);
      expect(atRef.checks.filter((c) => !c.pass)).toEqual([]);
      expect(atRef.pass).toBe(true);
    }, 240_000);
  }
});
