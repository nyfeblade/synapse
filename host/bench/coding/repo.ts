import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskById, type Task, type TextEdit } from "./suite";

/** host/bench/coding. The npm entry bundles main.ts elsewhere, so it passes the real dir by env. */
export function benchDir(): string {
  return process.env.BENCH_CODING_DIR ?? path.dirname(fileURLToPath(import.meta.url));
}
export const sampleDir = () => path.join(benchDir(), "sample");
export const taskDir = (id: string) => path.join(benchDir(), "tasks", id);
/** Offline suite only. Runners must never see this directory. */
export const referenceDir = (id: string) => path.join(benchDir(), "reference-solutions", id);

/** The Mac-side node_modules that holds vitest and typescript (the monorepo root's). */
export function macNodeModules(): string {
  return fs.realpathSync(path.resolve(benchDir(), "..", "..", "..", "node_modules"));
}

/** Never copied between states: git internals, dependency links, harness scratch. */
const SKIP = new Set([".git", "node_modules", ".bench-hidden", ".bench-cache", ".bench-verify.config.mjs"]);

export function copyTree(src: string, dst: string, skipGit = true): void {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      const base = path.basename(p);
      if (base === ".git") return !skipGit;
      return !SKIP.has(base) || p === src;
    },
  });
}

export function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bench-coding-${tag}-`));
}

export function linkNodeModules(dir: string, target = macNodeModules()): void {
  const link = path.join(dir, "node_modules");
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link);
}

/** Fixed identity, dates and config, so the same content always gives the same commit SHA. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@example.invalid", GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@example.invalid", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
};

export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${os.devNull}`, "-c", "init.defaultBranch=main", ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAll(dir: string, message: string, tag: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message]);
  git(dir, ["tag", "-f", tag]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export function applyEdit(dir: string, e: TextEdit): void {
  const file = path.join(dir, e.file);
  const src = fs.readFileSync(file, "utf8");
  const n = src.split(e.find).length - 1;
  if (n !== 1) throw new Error(`edit on ${e.file}: expected exactly one match, found ${n}`);
  fs.writeFileSync(file, src.replace(e.find, () => e.replace));
}

function overlay(from: string, dir: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.cpSync(from, dir, { recursive: true });
  return true;
}

export interface Prepared {
  dir: string;
  /** Commit SHA of the starting state (deterministic). */
  startRef: string;
  startTag: string;
}

/**
 * Builds a task's starting repo in `dir`: sample as `base`, then the task's start overlay and edits
 * as `<id>-start`. A follow-up task starts from its predecessor's END state, which only the offline
 * suite can build (from the predecessor's reference solution): pass `references: true` for that.
 */
export function prepareTask(task: Task, dir: string, o: { references?: boolean; nodeModules?: string | null } = {}): Prepared {
  if (task.after) {
    if (!o.references) throw new Error(`${task.id} is a follow-up of ${task.after}: its start state is the end of that run`);
    const prev = prepareTask(taskById(task.after), dir, { ...o, nodeModules: null });
    applyReference(taskById(task.after), dir);
    const startRef = commitAll(dir, `${task.after} reference`, `${task.id}-start`);
    if (o.nodeModules !== null) linkNodeModules(dir, o.nodeModules);
    return { dir: prev.dir, startRef, startTag: `${task.id}-start` };
  }
  copyTree(sampleDir(), dir);
  git(dir, ["init", "-q"]);
  commitAll(dir, "ledger 0.4.0", "base");
  let changed = overlay(path.join(taskDir(task.id), "start"), dir);
  for (const e of task.startEdits ?? []) { applyEdit(dir, e); changed = true; }
  const startTag = changed ? `${task.id}-start` : "base";
  const startRef = changed ? commitAll(dir, `${task.id}: starting state`, startTag) : git(dir, ["rev-parse", "HEAD"]);
  if (o.nodeModules !== null) linkNodeModules(dir, o.nodeModules);
  return { dir, startRef, startTag };
}

/**
 * Offline suite only: lays the task's reference solution over `dir`. A solution is whole files
 * (copied as they are), plus optional `edits.json` (TextEdit[] applied after) and `.delete` (paths).
 */
export function applyReference(task: Task, dir: string): void {
  const from = referenceDir(task.id);
  if (!fs.existsSync(from)) throw new Error(`no reference solution for ${task.id}`);
  const del = path.join(from, ".delete");
  const edits = path.join(from, "edits.json");
  fs.cpSync(from, dir, { recursive: true, filter: (p) => p !== del && p !== edits });
  if (fs.existsSync(edits)) for (const e of JSON.parse(fs.readFileSync(edits, "utf8")) as TextEdit[]) applyEdit(dir, e);
  if (fs.existsSync(del)) for (const rel of fs.readFileSync(del, "utf8").split("\n").filter(Boolean)) fs.rmSync(path.join(dir, rel), { force: true });
}

export type Snapshot = Map<string, string>;

/** Path -> sha256 of every file, skipping git, node_modules and harness scratch. */
export function snapshot(dir: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out.set(path.relative(dir, p).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort();
  return { added, removed, changed };
}

/** The contents of the start state, for mutants: path -> text. */
export function readTexts(dir: string, snap: Snapshot): Map<string, string> {
  return new Map([...snap.keys()].map((k) => [k, fs.readFileSync(path.join(dir, k), "utf8")]));
}

export interface ProcResult { code: number | null; out: string; timedOut: boolean; ms: number }

/** Runs a process with a hard time limit (and an optional abort, e.g. a token budget), capturing stdout+stderr. */
export function run(cmd: string, args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string; onLine?: (l: string) => void; signal?: AbortSignal }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "", buf = "", timedOut = false;
    const onData = (d: Buffer) => {
      const s = d.toString("utf8");
      out += s;
      if (!o.onLine) return;
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { o.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    if (o.input !== undefined) child.stdin!.end(o.input);
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
    o.signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
      if (buf && o.onLine) o.onLine(buf);
      resolve({ code, out, timedOut, ms: Date.now() - t0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: out + String(err), timedOut, ms: Date.now() - t0 });
    });
  });
}
