import fs from "node:fs";
import path from "node:path";
import { applyEdit, benchDir, copyTree, diffSnapshots, linkNodeModules, macNodeModules, run, snapshot, taskDir, tmpDir, type Snapshot } from "./repo";
import type { Mutant, Task } from "./suite";

export interface Check { name: string; pass: boolean; detail?: string }
export interface Verdict { taskId: string; pass: boolean; checks: Check[] }

export interface StartState {
  snap: Snapshot;
  /** Text of every start-state file, for mutants. */
  texts: Map<string, string>;
}

const TOOL_TIMEOUT = 180_000;

/** The child must not think it is a worker of the vitest run that may be calling us. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(VITEST|TINYPOOL|NODE_OPTIONS$)/.test(k)) env[k] = v;
  return { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
}

/** Runs vitest over `include` (repo-relative globs) with the harness's own config, not the repo's. */
export async function vitest(dir: string, include: string[]): Promise<{ pass: boolean; tail: string }> {
  const cfg = path.join(dir, ".bench-verify.config.mjs");
  fs.writeFileSync(cfg, `export default ${JSON.stringify({ cacheDir: path.join(dir, ".bench-cache"), test: { include, root: dir, watch: false, passWithNoTests: false } })};\n`);
  const bin = path.join(fs.realpathSync(path.join(dir, "node_modules")), "vitest", "vitest.mjs");
  const r = await run(process.execPath, [bin, "run", "--config", cfg], { cwd: dir, env: cleanEnv(), timeoutMs: TOOL_TIMEOUT });
  return { pass: r.code === 0 && !r.timedOut, tail: tail(r.out) };
}

export async function tsc(dir: string): Promise<{ pass: boolean; tail: string }> {
  const bin = path.join(fs.realpathSync(path.join(dir, "node_modules")), "typescript", "bin", "tsc");
  const r = await run(process.execPath, [bin, "-p", "."], { cwd: dir, env: cleanEnv(), timeoutMs: TOOL_TIMEOUT });
  return { pass: r.code === 0 && !r.timedOut, tail: tail(r.out) };
}

function tail(s: string, n = 12): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.trim()).slice(-n).join("\n");
}

function under(p: string, prefix: string): boolean {
  return prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`);
}

/** Mutants apply to the START text of the file, which the task's `unchanged` rule pins anyway. */
function mutate(dir: string, m: Mutant, start: StartState): void {
  if ("edit" in m) {
    const orig = start.texts.get(m.edit.file);
    if (orig === undefined) throw new Error(`mutant ${m.id}: ${m.edit.file} not in start state`);
    fs.writeFileSync(path.join(dir, m.edit.file), orig);
    applyEdit(dir, m.edit);
    return;
  }
  fs.copyFileSync(path.join(benchDir(), m.from), path.join(dir, m.file));
}

/**
 * Hidden verification of `finalDir` for `task`. Works on a private copy, so nothing the agent
 * left (including its own .bench-hidden or vitest config) can influence the result. With
 * `stopOnFail` it returns at the first failed check (enough to prove a start state fails).
 */
export async function verifyTask(task: Task, finalDir: string, start: StartState, o: { stopOnFail?: boolean; nodeModules?: string } = {}): Promise<Verdict> {
  const v = task.verify;
  const work = tmpDir(`verify-${task.id}`);
  const checks: Check[] = [];
  const done = () => ({ taskId: task.id, pass: checks.length > 0 && checks.every((c) => c.pass), checks });
  const add = (c: Check) => { checks.push(c); return !c.pass && o.stopOnFail; };
  try {
    copyTree(finalDir, work);
    linkNodeModules(work, o.nodeModules ?? macNodeModules());
    const snap = snapshot(work);
    const d = diffSnapshots(start.snap, snap);
    const touched = [...d.added, ...d.removed, ...d.changed];

    for (const f of v.requireFiles ?? []) if (add({ name: `exists ${f}`, pass: snap.has(f) })) return done();
    for (const p of v.unchanged ?? []) {
      const bad = touched.filter((t) => under(t, p));
      if (add({ name: `unchanged ${p}`, pass: bad.length === 0, detail: bad.join(", ") || undefined })) return done();
    }
    if (v.onlyChanged) {
      const bad = touched.filter((t) => !v.onlyChanged!.some((p) => under(t, p)));
      if (add({ name: `only ${v.onlyChanged.join(", ")} changed`, pass: bad.length === 0, detail: bad.join(", ") || undefined })) return done();
    }

    const hiddenSrc = path.join(taskDir(task.id), "hidden");
    if (v.hidden ?? fs.existsSync(hiddenSrc)) {
      fs.cpSync(hiddenSrc, path.join(work, ".bench-hidden"), { recursive: true });
      const r = await vitest(work, [".bench-hidden/**/*.test.ts"]);
      fs.rmSync(path.join(work, ".bench-hidden"), { recursive: true, force: true });
      if (add({ name: "hidden tests", pass: r.pass, detail: r.pass ? undefined : r.tail })) return done();
    }
    if (v.visible ?? true) {
      const r = await vitest(work, ["test/**/*.test.ts"]);
      if (add({ name: "repo test suite", pass: r.pass, detail: r.pass ? undefined : r.tail })) return done();
    }
    if (v.typecheck) {
      const r = await tsc(work);
      if (add({ name: "typecheck", pass: r.pass, detail: r.pass ? undefined : r.tail })) return done();
    }
    if (v.mutants) {
      const missing = v.mutants.tests.filter((t) => !snap.has(t));
      if (add({ name: "mutation tests present", pass: missing.length === 0, detail: missing.join(", ") || undefined })) return done();
      const real = await vitest(work, v.mutants.tests);
      if (add({ name: "agent tests pass on the real code", pass: real.pass, detail: real.pass ? undefined : real.tail })) return done();
      for (const m of v.mutants.variants) {
        const target = path.join(work, "edit" in m ? m.edit.file : m.file);
        const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
        mutate(work, m, start);
        const r = await vitest(work, v.mutants.tests);
        if (before) fs.writeFileSync(target, before);
        if (add({ name: `kills mutant ${m.id}`, pass: !r.pass })) return done();
      }
    }
    return done();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
