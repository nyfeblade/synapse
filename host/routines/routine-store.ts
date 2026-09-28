import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITS, isSafeFolderId, type RoutineDef, type RoutineRun } from "@synapse/shared";
import type { HostConfig } from "../config";
import { agentsDir, botDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { writeTextAtomic } from "../util/atomic-text";

export interface RoutineRecord { botId: string; id: string; def: RoutineDef; defHash: string }

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/** ORIG-02 §02.1: sha256 of the canonical JSON of {name, prompt, schedule, trigger, enabled}. */
export function defHash(def: Pick<RoutineDef, "name" | "prompt" | "schedule" | "trigger" | "enabled"> & Partial<Pick<RoutineDef, "quietHours">>): string {
  // quietHours joins the hash only when set, so every routine saved without it keeps its hash.
  const c = canonical({ name: def.name, prompt: def.prompt, schedule: def.schedule ?? null, trigger: def.trigger ?? null, enabled: def.enabled, quietHours: def.quietHours || undefined });
  return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}

/** RTN-01: id = slug of the name; collisions get -2…-999, then -<ts>. */
export function slugify(name: string, taken: Set<string>, nowMs: number): string {
  const base =
    name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") ||
    "routine";
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 999; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${nowMs}`;
}

export class RoutineStore {
  private now: () => number;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** onChange: a definition changed (scheduler reindex). onRuns: only run history changed (publish it; no reindex). */
  constructor(private o: {
    cfg: HostConfig;
    now?(): number;
    onChange?(botId: string, routineId: string | null): void;
    onRuns?(botId: string, routineId: string): void;
    /**
     * How watch() gets its recursive file watcher. Production passes nothing and gets fs.watch.
     *
     * Injected by tests because fs.watch(dir, { recursive: true }) is FSEvents on macOS and RETURNS
     * BEFORE THE STREAM IS ARMED: a write in that window is not delivered late, it is never
     * delivered at all. Measured on this repo under load, writing immediately after fs.watch()
     * returned lost the event 2 times in 6; with a 50 ms head start, 0 in 6, and when it did fire it
     * fired in ~10 ms. There is no callback or return value that says "armed", so a test that arms
     * a real watcher and then writes is racing an OS facility with no way to synchronise on it.
     */
    watch?(dir: string, opts: { recursive: true }, cb: (event: string, filename: string | null) => void): { close(): void };
  }) {
    this.now = o.now ?? Date.now;
  }

  private dir(botId: string): string {
    return path.join(botDir(this.o.cfg, botId), "automations");
  }
  private rdir(botId: string, id: string): string {
    if (!isSafeFolderId(id)) throw new Error(`Invalid routine id ${JSON.stringify(id)}`);
    return path.join(this.dir(botId), id);
  }

  get(botId: string, id: string): RoutineRecord | null {
    if (!isSafeFolderId(id)) return null;
    const def = readJson<RoutineDef | null>(path.join(this.dir(botId), id, "automation.json"), null);
    return def ? { botId, id, def, defHash: defHash(def) } : null;
  }

  list(botId: string): RoutineRecord[] {
    const d = this.dir(botId);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this.get(botId, e.name))
      .filter((r): r is RoutineRecord => r !== null)
      .sort((a, b) => a.def.createdAt - b.def.createdAt || a.id.localeCompare(b.id));
  }

  all(): RoutineRecord[] {
    const root = agentsDir(this.o.cfg);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeFolderId(e.name) && fs.existsSync(path.join(root, e.name, "automations")))
      .flatMap((e) => this.list(e.name));
  }

  create(botId: string, def: Omit<RoutineDef, "createdAt">): RoutineRecord | null {
    if (def.name.length > LIMITS.routineNameMax) return null;
    const existing = this.list(botId);
    if (existing.length >= LIMITS.maxRoutinesPerBot) return null;
    const id = slugify(def.name, new Set(existing.map((r) => r.id)), this.now());
    const full: RoutineDef = { ...def, createdAt: this.now() };
    writeJsonAtomic(path.join(this.rdir(botId, id), "automation.json"), full, 0o640);
    this.o.onChange?.(botId, id);
    return { botId, id, def: full, defHash: defHash(full) };
  }

  update(botId: string, id: string, patch: Partial<RoutineDef>): RoutineRecord {
    const cur = this.get(botId, id);
    if (!cur) throw new Error(`No routine ${id}`);
    const next: RoutineDef = { ...cur.def, ...patch };
    if (next.name.length > LIMITS.routineNameMax) throw new Error(`Routine name exceeds ${LIMITS.routineNameMax} characters`);
    writeJsonAtomic(path.join(this.rdir(botId, id), "automation.json"), next, 0o640);
    this.o.onChange?.(botId, id);
    return { botId, id, def: next, defHash: defHash(next) };
  }

  /** The user has confirmed this Bot's automations once (its first save); later saves are reviewed normally. */
  confirmed(botId: string): boolean {
    return fs.existsSync(path.join(this.dir(botId), ".confirmed"));
  }
  markConfirmed(botId: string): void {
    if (this.confirmed(botId)) return;
    fs.mkdirSync(this.dir(botId), { recursive: true });
    fs.writeFileSync(path.join(this.dir(botId), ".confirmed"), String(this.now()), { mode: 0o640 });
  }

  remove(botId: string, id: string): void {
    fs.rmSync(this.rdir(botId, id), { recursive: true, force: true });
    this.o.onChange?.(botId, id);
  }

  removeBot(botId: string): void {
    fs.rmSync(this.dir(botId), { recursive: true, force: true });
    this.o.onChange?.(botId, null);
  }

  runs(botId: string, id: string): RoutineRun[] {
    return readJson<RoutineRun[]>(path.join(this.rdir(botId, id), "runs.json"), []);
  }

  /** RTN-17 / ORIG-02 §02.8: replace in place, else insert newest first; keep 20, archive the overflow (≤1,000 lines). */
  upsertRun(botId: string, id: string, run: RoutineRun): void {
    if (!fs.existsSync(this.rdir(botId, id))) return; // the routine was deleted while the run was in flight
    const runs = this.runs(botId, id);
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = run;
    else runs.unshift(run);
    writeJsonAtomic(path.join(this.rdir(botId, id), "runs.json"), runs.slice(0, LIMITS.runHistoryMax), 0o640);
    const over = runs.slice(LIMITS.runHistoryMax);
    if (over.length) this.archive(botId, id, over.reverse());
    this.o.onRuns?.(botId, id);
  }

  private archive(botId: string, id: string, oldestFirst: RoutineRun[]): void {
    const file = path.join(this.rdir(botId, id), "runs-archive.jsonl");
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    lines.push(...oldestFirst.map((r) => JSON.stringify(r)));
    writeTextAtomic(file, `${lines.slice(-LIMITS.runArchiveMax).join("\n")}\n`, 0o640);
  }

  /** External edits (the Bot editing automation.json with a tool) re-index after a 50 ms debounce (ORIG-02 §02.1). */
  watch(): () => void {
    const root = agentsDir(this.o.cfg);
    const watch = this.o.watch ?? ((dir, opts, cb) => fs.watch(dir, opts, cb));
    const w = watch(root, { recursive: true }, (_ev, f) => {
      if (!f) return;
      const parts = String(f).split(path.sep);
      if (parts.length === 4 && parts[1] === "automations" && parts[3] === "automation.json") this.debounce(parts[0]!, parts[2]!);
    });
    return () => {
      w.close();
      for (const t of this.timers.values()) clearTimeout(t);
      this.timers.clear();
    };
  }

  private debounce(botId: string, id: string): void {
    const key = `${botId}/${id}`;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.o.onChange?.(botId, id);
    }, 50));
  }
}
