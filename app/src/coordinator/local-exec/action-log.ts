import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STRAL, macActionMatches, type MacActionFilter, type MacActionKind, type MacActionOutcome, type MacActionVia, type MacActionView, type MacUndoResult } from "@synapse/shared";
import { redactText } from "../../main/crash/redact";
import { SnapshotStore, type FileUndo } from "./snapshots";

/**
 * 5.6: everything a Bot did on this Mac, on this Mac only. One JSON line per event, appended (O_APPEND) and never
 * rewritten; at `maxFileBytes` the file rotates (actions.jsonl → actions.1.jsonl … actions.<keep>.jsonl, the oldest
 * dropped). An undo is its own line, folded in when the log is read.
 *
 * Never in a record: file contents, edit strings, typed input, an app's text. Every string that could carry a secret
 * (a command, a path, a URL, an error) goes through redactText and is cut short.
 */
export const LOG_LIMITS = { maxFileBytes: 1024 ** 2, keep: 4, textMax: 300 };

export interface ActionRecord {
  id: string; at: number; botId: string; kind: MacActionKind; op: string; targets: string[]; outcome: MacActionOutcome; via: MacActionVia;
  act?: string; command?: string; detail?: string; dryRun?: boolean;
  /** The files an undo restores; absent = no undo, and `noUndo` says why. */
  files?: FileUndo[];
  noUndo?: string;
}
interface UndoEvent { type: "undo"; of: string; at: number }
type Line = (ActionRecord & { type?: undefined }) | UndoEvent;

export function clean(s: string, max = LOG_LIMITS.textMax): string {
  const one = s.replace(/[\r\n\t]+/g, " ");
  const r = redactText(one.length > max * 4 ? one.slice(0, max * 4) : one);
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

/** A path the gate resolved: only a segment shaped like a known key or token is hidden (a random-looking folder name,
 *  like macOS's per-user temp folder, is not a secret). */
const TOKEN_SEGMENT = /^(sk-|gh[pousr]_|github_pat_|xox[abprs]-|AIza|AQ\.)/i;
export function cleanPath(p: string, max = LOG_LIMITS.textMax): string {
  const out = p.replace(/[\r\n\t]+/g, " ").split("/").map((seg) => (TOKEN_SEGMENT.test(seg) ? "[redacted]" : seg)).join("/");
  return out.length > max ? `…${out.slice(out.length - max + 1)}` : out;
}

export class ActionLog {
  readonly dir: string;
  readonly snapshots: SnapshotStore;
  private file: string;
  private cache: { records: ActionRecord[]; undone: Set<string> } | null = null;
  private limits: typeof LOG_LIMITS;

  constructor(dir: string, private o: { now?: () => number; limits?: Partial<typeof LOG_LIMITS>; snapshots?: SnapshotStore } = {}) {
    this.dir = dir;
    this.limits = { ...LOG_LIMITS, ...(o.limits ?? {}) };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    this.file = path.join(dir, "actions.jsonl");
    this.snapshots = o.snapshots ?? new SnapshotStore(path.join(dir, "snapshots"), { now: o.now });
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  newId(): string { return `${this.now().toString(36)}-${randomBytes(6).toString("hex")}`; }

  /** Appends one record. Strings are cleaned here, whatever the caller passed. Never throws: a log that can't be
   *  written must not stop the action (the error goes to the caller's log). */
  record(r: Omit<ActionRecord, "id" | "at"> & { id?: string; at?: number; paths?: boolean }): ActionRecord {
    const { paths, ...rest } = r;
    const rec: ActionRecord = {
      ...rest, id: r.id ?? this.newId(), at: r.at ?? this.now(),
      targets: r.targets.slice(0, 16).map((t) => (paths ? cleanPath(t) : clean(t))),
      ...(r.command !== undefined ? { command: clean(r.command) } : {}),
      ...(r.detail !== undefined ? { detail: clean(r.detail, 200) } : {}),
      ...(r.act !== undefined ? { act: clean(r.act, 40) } : {}),
      ...(r.files ? { files: r.files.map((f) => ({ ...f, path: f.path })) } : {}),
    };
    this.append(rec);
    this.cache?.records.push(rec);
    return rec;
  }

  private append(line: Line): void {
    const text = `${JSON.stringify(line)}\n`;
    try {
      const size = (() => { try { return fs.statSync(this.file).size; } catch { return 0; } })();
      if (size > 0 && size + text.length > this.limits.maxFileBytes) this.rotate();
      fs.appendFileSync(this.file, text, { mode: 0o600, flag: "a" });
    } catch (e) {
      console.error(`action-log: couldn't write (${(e as Error).message})`);
    }
  }

  private rotate(): void {
    const n = (i: number) => path.join(this.dir, i === 0 ? "actions.jsonl" : `actions.${i}.jsonl`);
    try { fs.rmSync(n(this.limits.keep), { force: true }); } catch { /* none */ }
    for (let i = this.limits.keep - 1; i >= 0; i--) if (fs.existsSync(n(i))) fs.renameSync(n(i), n(i + 1));
    this.cache = null;
  }

  private load(): { records: ActionRecord[]; undone: Set<string> } {
    if (this.cache) return this.cache;
    const records: ActionRecord[] = [];
    const undone = new Set<string>();
    for (let i = this.limits.keep; i >= 0; i--) {
      const f = path.join(this.dir, i === 0 ? "actions.jsonl" : `actions.${i}.jsonl`);
      let text = "";
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
      for (const l of text.split("\n")) {
        if (!l) continue;
        try {
          const j = JSON.parse(l) as Line;
          if (j.type === "undo") undone.add(j.of);
          else if (typeof j.id === "string" && typeof j.botId === "string") records.push(j);
        } catch { /* a torn last line */ }
      }
    }
    this.cache = { records, undone };
    return this.cache;
  }

  private undoState(r: ActionRecord, undone: Set<string>): Pick<MacActionView, "undo" | "undoNote"> {
    if (undone.has(r.id)) return { undo: "undone" };
    if (!r.files?.length || r.outcome !== "done") return { undo: "none", ...(r.noUndo ? { undoNote: r.noUndo } : {}) };
    if (this.now() - r.at > this.snapshots.retentionMs) return { undo: "expired" };
    if (r.files.some((f) => f.before.snap !== null && !this.snapshots.has(f.before.snap))) return { undo: "expired" };
    return { undo: "available" };
  }

  view(r: ActionRecord, undone = this.load().undone): MacActionView {
    return {
      id: r.id, at: r.at, botId: r.botId, kind: r.kind, op: r.op, targets: r.targets, outcome: r.outcome, via: r.via,
      ...(r.act ? { act: r.act } : {}), ...(r.command ? { command: r.command } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.dryRun ? { dryRun: true } : {}),
      ...this.undoState(r, undone),
    };
  }

  list(q: { botId?: string; filter?: MacActionFilter; before?: number; limit?: number } = {}): { entries: MacActionView[]; more: boolean } {
    const { records, undone } = this.load();
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const out: MacActionView[] = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (q.botId && r.botId !== q.botId) continue;
      if (q.before !== undefined && r.at >= q.before) continue;
      if (q.filter && !macActionMatches(r, q.filter)) continue;
      if (out.length === limit) return { entries: out, more: true };
      out.push(this.view(r, undone));
    }
    return { entries: out, more: false };
  }

  /** The log as JSON lines (the same redacted records, without the snapshot bookkeeping). */
  exportText(botId?: string): string {
    const { records, undone } = this.load();
    return records.filter((r) => !botId || r.botId === botId).map((r) => {
      const v = this.view(r, undone);
      return JSON.stringify({ ...v, time: new Date(v.at).toISOString() });
    }).join("\n") + "\n";
  }

  /**
   * Restores every file the action changed to its state before, or nothing: each must still be exactly as the action
   * left it (a later change, by anyone, is a conflict and nothing is touched).
   */
  async undo(id: string): Promise<MacUndoResult> {
    const { records, undone } = this.load();
    const r = records.find((x) => x.id === id);
    if (!r) return { ok: false, conflict: false, message: "That action isn't in the log." };
    const st = this.undoState(r, undone);
    if (st.undo === "undone") return { ok: false, conflict: false, message: STRAL.undone };
    if (st.undo === "expired") return { ok: false, conflict: false, message: STRAL.expired };
    if (st.undo !== "available") return { ok: false, conflict: false, message: r.noUndo ?? STRAL.noUndoCommand };
    for (const f of r.files!) if (!SnapshotStore.unchanged(f.path, f.after)) return { ok: false, conflict: true, message: STRAL.conflict };
    // Restore in reverse (a move puts its destination's old version back after the source is back).
    for (const f of [...r.files!].reverse()) await this.snapshots.restore(f.path, f.before);
    this.append({ type: "undo", of: r.id, at: this.now() });
    this.load().undone.add(r.id);
    return { ok: true };
  }
}
