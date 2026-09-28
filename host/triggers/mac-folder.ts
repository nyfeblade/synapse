import { LIMITS, LIMITS_SCHED, type Trigger } from "@synapse/shared";
import type { RoutineStore } from "../routines/routine-store";
import { log } from "../util/log";
import type { EventQueue } from "./event-queue";
import { MAC_PREFIX, isMacPath } from "./match";
import type { TriggerEvent } from "./types";

type FileTrigger = Extract<Trigger, { file: unknown }>["file"];

/** "mac:~/Downloads/" → "~/Downloads": the folder key the watcher and RoutineHealth share. */
export const macFolderOf = (p: string) => p.slice(MAC_PREFIX.length).replace(/\/+$/, "");

function fileTriggersOf(t: Trigger): FileTrigger[] {
  if ("group" in t) return t.group.listeners.flatMap(fileTriggersOf);
  return "file" in t ? [t.file] : [];
}

/**
 * A folder on the user's Mac ("mac:~/Downloads" in a file trigger), watched by listing it over the local bridge each
 * minute while the Mac is reachable. Names only (the bridge's list-directory), so it reports created and deleted files;
 * the first listing is the baseline. No model call: the event queue matches and dedupes.
 */
export class MacFolderWatch {
  private folders = new Map<string, string>(); // folder → a Bot that watches it (the bridge request is made as that Bot)
  private seen = new Map<string, Set<string> | null>();
  private timer: unknown = null;
  /** Bug 115: consecutive failed listings per folder (a Mac that is away is not a failure). */
  private fails = new Map<string, number>();
  /** Bug 115: a folder crossed the failure threshold, or listed again after it (phase4 re-checks the rows). */
  onHealthChange: ((botIds: string[]) => void) | undefined;

  constructor(private d: {
    store: RoutineStore;
    queue: EventQueue;
    /** The folder's entries, one per line (directories end in "/"), or null when the Mac is not reachable.
     *  Throws when the listing itself failed (the folder is gone, or isn't one it may list). */
    list(folder: string, botId: string): Promise<string | null>;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
    everyMs?: number;
  }) {}

  /** Bug 115: false after LIMITS.imapFailHealthAfter failed listings of this folder in a row. */
  folderReachable(folder: string): boolean {
    return (this.fails.get(folder) ?? 0) < LIMITS.imapFailHealthAfter;
  }

  sync(): void {
    const want = new Map<string, string>();
    for (const r of this.d.store.all()) {
      if (!r.def.enabled || !r.def.trigger) continue;
      for (const f of fileTriggersOf(r.def.trigger)) for (const p of f.paths) if (isMacPath(p)) want.set(macFolderOf(p), r.botId);
    }
    for (const f of [...this.seen.keys()]) if (!want.has(f)) this.seen.delete(f);
    for (const f of [...this.fails.keys()]) if (!want.has(f)) this.fails.delete(f);
    this.folders = want;
    if (want.size && this.timer === null) this.arm();
    if (!want.size) this.stop();
  }

  stop(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.timer = this.d.setTimer(() => {
      void this.pollOnce()
        .catch((e) => log.warn("mac folder poll crashed", { error: String((e as Error).message ?? e).slice(0, 200) }))
        .finally(() => { if (this.timer !== null && this.folders.size) this.arm(); else this.timer = null; });
    }, this.d.everyMs ?? LIMITS_SCHED.macFolderPollMs);
  }

  async pollOnce(): Promise<number> {
    let n = 0;
    for (const [folder, botId] of this.folders) {
      let out: string | null;
      try {
        out = await this.d.list(folder, botId);
      } catch (e) {
        // Bug 115: retried next minute; after N in a row RoutineHealth says so on the routine's row, with a tray entry.
        this.noteFails(folder, botId, (this.fails.get(folder) ?? 0) + 1);
        log.warn("mac folder poll failed", { folder, botId, routineIds: this.routinesOf(folder).map((r) => r.routineId), error: String((e as Error).message ?? e).slice(0, 200) });
        continue;
      }
      if (out === null) continue; // Mac asleep or not connected: keep the old baseline, report nothing
      this.noteFails(folder, botId, 0);
      const now = new Set(out.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/")));
      const before = this.seen.get(folder);
      this.seen.set(folder, now);
      if (!before) continue;
      const at = this.d.now();
      for (const name of [...now].filter((x) => !before.has(x)).sort()) { this.emit("created", folder, name, at); n++; }
      for (const name of [...before].filter((x) => !now.has(x)).sort()) { this.emit("deleted", folder, name, at); n++; }
    }
    return n;
  }

  private noteFails(folder: string, botId: string, n: number): void {
    const before = this.fails.get(folder) ?? 0;
    if (n === 0) this.fails.delete(folder); else this.fails.set(folder, n);
    if ((before >= LIMITS.imapFailHealthAfter) !== (n >= LIMITS.imapFailHealthAfter)) {
      this.onHealthChange?.([...new Set([botId, ...this.routinesOf(folder).map((r) => r.botId)])]);
    }
  }

  /** The enabled routines that watch this Mac folder. */
  private routinesOf(folder: string): { botId: string; routineId: string }[] {
    return this.d.store.all().filter((r) => r.def.enabled && r.def.trigger && fileTriggersOf(r.def.trigger).some((f) => f.paths.some((p) => isMacPath(p) && macFolderOf(p) === folder))).map((r) => ({ botId: r.botId, routineId: r.id }));
  }

  private emit(kind: "created" | "deleted", folder: string, name: string, at: number): void {
    const p = `${MAC_PREFIX}${folder}/${name}`;
    const ev: TriggerEvent = { source: "file", eventId: `${kind}:${p}@${at}`, occurredAt: at, kind, path: p, subject: name, text: `${kind} ${p} (on the Mac)`, raw: { mac: true } };
    this.d.queue.ingest(ev);
  }
}
