import { DatabaseSync } from "node:sqlite";
import type { FactKind } from "./facts";

export interface IndexedFact { factId: string; scope: "agent" | "user" | "team" | "project"; owner: string; project: string | null; kind: FactKind; content: string; createdAt: number; importance: number }
export interface Candidate extends IndexedFact { bm25: number }
export interface Visibility { botId: string; projects: string[] }

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

export class RecallIndex {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    try {
      this.db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;");
    } catch {
      throw new Error("node:sqlite was built without FTS5; memory recall and search need it");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, shard TEXT NOT NULL, fact_id TEXT NOT NULL, scope TEXT NOT NULL, owner TEXT NOT NULL,
        project TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, importance REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS facts_shard ON facts(shard);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, content='facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='3');
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content); END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content); END;
    `);
  }

  replaceShard(shard: string, facts: IndexedFact[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM facts WHERE shard = ?").run(shard);
      const ins = this.db.prepare("INSERT INTO facts(shard, fact_id, scope, owner, project, kind, content, created_at, importance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const f of facts) ins.run(shard, f.factId, f.scope, f.owner, f.project, f.kind, f.content, f.createdAt, f.importance);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  shards(): string[] {
    return (this.db.prepare("SELECT DISTINCT shard FROM facts").all() as { shard: string }[]).map((r) => r.shard);
  }

  private visible(v: Visibility): { sql: string; args: string[] } {
    const ps = v.projects.map(() => "?").join(", ");
    return { sql: `((f.scope = 'agent' AND f.owner = ?) OR f.scope IN ('user', 'team')${ps ? ` OR (f.scope = 'project' AND f.project IN (${ps}))` : ""})`, args: [v.botId, ...v.projects] };
  }

  search(terms: string[], v: Visibility, limit = 200): Candidate[] {
    if (!terms.length) return [];
    const vis = this.visible(v);
    const rows = this.db.prepare(
      `SELECT f.fact_id AS factId, f.scope, f.owner, f.project, f.kind, f.content, f.created_at AS createdAt, f.importance, bm25(facts_fts) AS bm25
       FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ? AND ${vis.sql} ORDER BY bm25 LIMIT ?`,
    ).all(terms.map(quote).join(" OR "), ...vis.args, limit) as unknown as Candidate[];
    return rows;
  }

  docFreq(term: string, v: Visibility): number {
    const vis = this.visible(v);
    const r = this.db.prepare(`SELECT count(*) AS n FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? AND ${vis.sql}`).get(quote(term), ...vis.args) as { n: number };
    return r.n;
  }

  count(v: Visibility): number {
    const vis = this.visible(v);
    return (this.db.prepare(`SELECT count(*) AS n FROM facts f WHERE ${vis.sql}`).get(...vis.args) as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
