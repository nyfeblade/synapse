import { createHash } from "node:crypto";
import path from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { LIMITS, type FileEventKind, type Trigger } from "@synapse/shared";
import type { RoutineStore } from "../routines/routine-store";
import { log } from "../util/log";
import type { EventQueue } from "./event-queue";
import { isAlwaysIgnored, isMacPath } from "./match";
import type { TriggerEvent } from "./types";

export interface FSWatcherLike {
  on(event: "add" | "change" | "unlink", cb: (p: string, stats?: { size: number; mtimeMs: number }) => void): unknown;
  close(): Promise<void>;
}
export type WatchFactory = (
  paths: string[],
  opts: { ignored: (p: string) => boolean; awaitWriteFinish: { stabilityThreshold: number; pollInterval: number }; ignoreInitial: boolean; alwaysStat: boolean },
) => FSWatcherLike;

export interface FileWatcherDeps {
  store: RoutineStore;
  queue: EventQueue;
  workspace: string;
  isRunActive(botId: string, routineId: string): boolean;
  lastRunEndedAt(botId: string, routineId: string): number | null;
  now(): number;
  watch?: WatchFactory;
}

type FileTrigger = Extract<Trigger, { file: unknown }>["file"];
interface Spec { botId: string; routineId: string; triggers: FileTrigger[] }

const MAGIC = /[*?[{]/;
const defaultWatch: WatchFactory = (paths, opts) => chokidarWatch(paths, opts) as unknown as FSWatcherLike;

export function baseDir(glob: string, workspace: string): string {
  const abs = path.isAbsolute(glob) ? glob : path.join(workspace, glob);
  const segs = abs.split("/");
  const i = segs.findIndex((s) => MAGIC.test(s));
  return i < 0 ? abs.replace(/\/+$/, "") : segs.slice(0, i).join("/") || "/";
}

export function fileEventLine(kind: FileEventKind, p: string, size: number, mtimeMs: number): string {
  return `${kind} ${p} size=${size} mtime=${new Date(mtimeMs).toISOString()}`;
}

function fileTriggersOf(t: Trigger): FileTrigger[] {
  if ("group" in t) return t.group.listeners.flatMap(fileTriggersOf);
  return "file" in t ? [t.file] : [];
}

/** ORIG-04 §04.4: chokidar per file routine; awaitWriteFinish 2 s; self-suppression during the run + 5 s. */
export class FileTriggerWatcher {
  private watchers = new Map<string, FSWatcherLike>();

  constructor(private d: FileWatcherDeps) {}

  sync(): void {
    const want = new Map<string, Spec>();
    for (const r of this.d.store.all()) {
      if (!r.def.enabled || !r.def.trigger) continue;
      // mac: paths are the Mac folder watcher's (mac-folder.ts); this one watches the box workspace only.
      const triggers = fileTriggersOf(r.def.trigger).map((t) => ({ ...t, paths: t.paths.filter((p) => !isMacPath(p)) })).filter((t) => t.paths.length);
      if (triggers.length) want.set(`${r.botId}/${r.id}#${r.defHash}`, { botId: r.botId, routineId: r.id, triggers });
    }
    for (const [k, w] of this.watchers) {
      if (want.has(k)) continue;
      void w.close();
      this.watchers.delete(k);
    }
    for (const [k, spec] of want) if (!this.watchers.has(k)) this.watchers.set(k, this.open(spec));
  }

  async close(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  private open(spec: Spec): FSWatcherLike {
    const ws = this.d.workspace;
    const bases = [...new Set(spec.triggers.flatMap((t) => t.paths.map((g) => baseDir(g, ws))))];
    const w = (this.d.watch ?? defaultWatch)(bases, {
      ignored: (p) => isAlwaysIgnored(p, ws),
      awaitWriteFinish: { stabilityThreshold: LIMITS.fileStabilityMs, pollInterval: 200 },
      ignoreInitial: true,
      alwaysStat: true, // stats (size, mtime) on every add/change, for the eventId and the file_event line
    });
    const on = (kind: FileEventKind) => (p: string, st?: { size: number; mtimeMs: number }) => {
      try {
        this.onFs(spec, kind, p, st);
      } catch (e) {
        log.error("file trigger event failed", { routineId: spec.routineId, error: String(e) });
      }
    };
    w.on("add", on("created"));
    w.on("change", on("modified"));
    w.on("unlink", on("deleted"));
    return w;
  }

  private onFs(spec: Spec, kind: FileEventKind, p: string, st?: { size: number; mtimeMs: number }): void {
    const now = this.d.now();
    if (this.d.isRunActive(spec.botId, spec.routineId)) return;
    const ended = this.d.lastRunEndedAt(spec.botId, spec.routineId);
    if (ended !== null && now - ended < LIMITS.fileSelfSuppressMs) return;
    const abs = path.resolve(p);
    const size = st?.size ?? 0;
    const mtime = st?.mtimeMs ?? 0;
    const ev: TriggerEvent = {
      source: "file", eventId: createHash("sha256").update(`${abs}\0${kind}\0${mtime}\0${size}`).digest("hex"), occurredAt: now,
      kind, path: abs, text: fileEventLine(kind, abs, size, mtime), raw: { event: kind, path: abs, size, mtime },
    };
    this.d.queue.ingest(ev, { botId: spec.botId, routineId: spec.routineId });
  }
}
