import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { factKey } from "./fact-key";
import type { Scope } from "./memory-store";

/**
 * Memory provenance: the bi-temporal fact ledger (docs/decisions.md, "SHARED TEAM MEMORY WITH PROVENANCE").
 *
 * One host-private SQLite file (<hostPrivate>/memory-ledger.db, in every backup through the online backup API).
 * The markdown memory files stay the CURRENT view the prompt and recall read; the ledger adds what they can't hold:
 *   - world time:  valid_from (the day it was learned to be true) / valid_to (when it stopped being true)
 *   - record time: recorded_at (when we learned it) / superseded_at + superseded_by (when and by what it was replaced)
 *   - provenance:  which Bot, which chat and message, the source type, a confidence, and the scope.
 * A contradiction ends the old row; it never deletes it. Only the user's Forget (and clearing a scope, or deleting
 * a Bot) removes rows. Scoping is enforced here, in the host: a private row is readable by its Bot only.
 */
export type SourceType = "user" | "email" | "doc" | "web" | "inferred" | "migrated";
export const SOURCE_TYPES: readonly SourceType[] = ["user", "email", "doc", "web", "inferred", "migrated"];
export type LedgerScope = "private" | "user" | "team" | "project";
export interface Provenance { botId: string | null; chatId?: string | null; messageId?: string | null; source: SourceType; confidence: number }
export interface LedgerRef { shard: string; scope: LedgerScope; owner: string; project: string | null }
export interface LedgerRow extends LedgerRef {
  id: string; factId: string; text: string; subject: string | null; predicate: string | null; value: string | null;
  validFrom: number; validTo: number | null; recordedAt: number; supersededAt: number | null; supersededBy: string | null;
  botId: string | null; chatId: string | null; messageId: string | null; source: SourceType; confidence: number;
}
export interface Visibility { botId: string; projects: string[] }

/** The same shard keys the recall index uses (recall-sync.ts). */
export function shardKey(s: Scope): string {
  return s.kind === "project" ? `project:${s.slug}:${s.botId}` : `${s.kind}:${s.botId}`;
}
export function ledgerRef(s: Scope): LedgerRef {
  return { shard: shardKey(s), scope: s.kind === "agent" ? "private" : s.kind, owner: s.botId, project: s.kind === "project" ? s.slug : null };
}

const SCHEMA_VERSION = 1;
const COL_LIST = ["id", "shard", "scope", "owner", "project", "fact_id AS factId", "text", "subject", "predicate", "value", "valid_from AS validFrom", "valid_to AS validTo",
  "recorded_at AS recordedAt", "superseded_at AS supersededAt", "superseded_by AS supersededBy", "bot_id AS botId", "chat_id AS chatId", "message_id AS messageId", "source", "confidence"];
const COLS = COL_LIST.join(", ");
const L_COLS = COL_LIST.map((c) => `l.${c}`).join(", ");
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

export class FactLedger {
  private db: DatabaseSync;
  private now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger(
        rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, shard TEXT NOT NULL, scope TEXT NOT NULL, owner TEXT NOT NULL, project TEXT,
        fact_id TEXT NOT NULL, text TEXT NOT NULL, subject TEXT, predicate TEXT, value TEXT,
        valid_from INTEGER NOT NULL, valid_to INTEGER, recorded_at INTEGER NOT NULL, superseded_at INTEGER, superseded_by TEXT,
        bot_id TEXT, chat_id TEXT, message_id TEXT, source TEXT NOT NULL, confidence REAL NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_current ON ledger(shard, fact_id) WHERE superseded_at IS NULL;
      CREATE INDEX IF NOT EXISTS ledger_key ON ledger(subject, predicate) WHERE superseded_at IS NULL;
      CREATE INDEX IF NOT EXISTS ledger_by ON ledger(superseded_by);
      CREATE INDEX IF NOT EXISTS ledger_owner ON ledger(owner);
      CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(text, content='ledger', content_rowid='rid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS ledger_ai AFTER INSERT ON ledger BEGIN INSERT INTO ledger_fts(rowid, text) VALUES (new.rid, new.text); END;
      CREATE TRIGGER IF NOT EXISTS ledger_ad AFTER DELETE ON ledger BEGIN INSERT INTO ledger_fts(ledger_fts, rowid, text) VALUES ('delete', old.rid, old.text); END;
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Idempotent: a fact already current in the shard keeps its row (and its first provenance). */
  record(ref: LedgerRef, f: { factId: string; text: string; date: string }, p: Provenance): LedgerRow {
    const cur = this.current(ref.shard, f.factId);
    if (cur) return cur;
    const k = factKey(f.text);
    const id = randomUUID();
    const validFrom = Date.parse(`${f.date}T00:00:00Z`);
    this.db.prepare(`INSERT INTO ledger(id, shard, scope, owner, project, fact_id, text, subject, predicate, value, valid_from, recorded_at, bot_id, chat_id, message_id, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, ref.shard, ref.scope, ref.owner, ref.project, f.factId, f.text, k?.subject ?? null, k?.predicate ?? null, k?.value ?? null,
      Number.isNaN(validFrom) ? this.now() : validFrom, this.now(), p.botId, p.chatId ?? null, p.messageId ?? null, p.source, clamp(p.confidence));
    return this.byId(id)!;
  }

  byId(id: string): LedgerRow | null {
    return (this.db.prepare(`SELECT ${COLS} FROM ledger WHERE id = ?`).get(id) as LedgerRow | undefined) ?? null;
  }
  current(shard: string, factId: string): LedgerRow | null {
    return (this.db.prepare(`SELECT ${COLS} FROM ledger WHERE shard = ? AND fact_id = ? AND superseded_at IS NULL`).get(shard, factId) as LedgerRow | undefined) ?? null;
  }
  currentIn(shard: string): LedgerRow[] {
    return this.db.prepare(`SELECT ${COLS} FROM ledger WHERE shard = ? AND superseded_at IS NULL ORDER BY rid`).all(shard) as unknown as LedgerRow[];
  }
  /** Current rows with this subject and predicate in any of the shards. */
  withKey(shards: string[], subject: string, predicate: string): LedgerRow[] {
    if (!shards.length) return [];
    return this.db.prepare(`SELECT ${COLS} FROM ledger WHERE superseded_at IS NULL AND subject = ? AND predicate = ? AND shard IN (${shards.map(() => "?").join(", ")}) ORDER BY rid`)
      .all(subject, predicate, ...shards) as unknown as LedgerRow[];
  }

  /** Ends the current row: no longer true (valid_to) and no longer current (superseded_at), replaced by `by` or by nothing (a retraction). */
  end(shard: string, factId: string, by: string | null): LedgerRow | null {
    const cur = this.current(shard, factId);
    if (!cur) return null;
    const at = this.now();
    this.db.prepare("UPDATE ledger SET superseded_at = ?, valid_to = ?, superseded_by = ? WHERE id = ?").run(at, at, by, cur.id);
    return this.byId(cur.id);
  }

  /** What this row replaced, newest first (following superseded_by back). */
  history(id: string, limit = 20): LedgerRow[] {
    return this.db.prepare(`WITH RECURSIVE chain(id, depth) AS (SELECT id, 1 FROM ledger WHERE superseded_by = ?
        UNION ALL SELECT l.id, c.depth + 1 FROM ledger l JOIN chain c ON l.superseded_by = c.id WHERE c.depth < ?)
      SELECT ${COLS} FROM ledger WHERE id IN (SELECT id FROM chain) ORDER BY superseded_at DESC, rid DESC`).all(id, limit) as unknown as LedgerRow[];
  }

  /** The user's Forget: the current row and everything it replaced are deleted. Returns the rows removed. */
  forget(shard: string, factId: string): number {
    const cur = this.current(shard, factId);
    if (!cur) return 0;
    const ids = [cur.id, ...this.history(cur.id, 1000).map((r) => r.id)];
    this.db.prepare(`DELETE FROM ledger WHERE id IN (${ids.map(() => "?").join(", ")})`).run(...ids);
    return ids.length;
  }
  clearShard(shard: string): number {
    return Number(this.db.prepare("DELETE FROM ledger WHERE shard = ?").run(shard).changes);
  }
  /** A deleted Bot: every row in its shards (private, user, team, project) goes with it. */
  clearOwner(botId: string): number {
    return Number(this.db.prepare("DELETE FROM ledger WHERE owner = ?").run(botId).changes);
  }

  private visible(v: Visibility): { sql: string; args: string[] } {
    const ps = v.projects.map(() => "?").join(", ");
    return { sql: `((l.scope = 'private' AND l.owner = ?) OR l.scope IN ('user', 'team')${ps ? ` OR (l.scope = 'project' AND l.project IN (${ps}))` : ""})`, args: [v.botId, ...v.projects] };
  }

  /** Rows that are no longer current (replaced or retracted) matching any term, best match first, that this Bot may read. */
  searchPast(terms: string[], v: Visibility, limit = 20): LedgerRow[] {
    if (!terms.length) return [];
    const vis = this.visible(v);
    return this.db.prepare(`SELECT ${L_COLS} FROM ledger_fts JOIN ledger l ON l.rid = ledger_fts.rowid
      WHERE ledger_fts MATCH ? AND l.superseded_at IS NOT NULL AND ${vis.sql} ORDER BY bm25(ledger_fts) LIMIT ?`)
      .all(terms.map(quote).join(" OR "), ...vis.args, limit) as unknown as LedgerRow[];
  }

  /** Best-effort import of facts written before the ledger (or outside it): provenance "migrated". Idempotent. */
  migrate(ref: LedgerRef, facts: { id: string; content: string; date: string }[]): number {
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const f of facts) {
        if (this.current(ref.shard, f.id)) continue;
        this.record(ref, { factId: f.id, text: f.content, date: f.date }, { botId: ref.owner, source: "migrated", confidence: 0.6 });
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  dispose(): void {
    this.db.close();
  }
}

function clamp(c: number): number {
  return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
}
