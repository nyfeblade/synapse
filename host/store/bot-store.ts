import { DatabaseSync } from "node:sqlite";
import type { TranscriptEntry } from "@synapse/shared";

export class BotStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entry TEXT NOT NULL);
    `);
  }

  getKv<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  deleteKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  append(entry: TranscriptEntry): void {
    this.db.prepare("INSERT INTO transcript_entries(id, entry) VALUES(?, ?)").run(entry.id, JSON.stringify(entry));
  }

  update(entry: TranscriptEntry): void {
    this.db.prepare("UPDATE transcript_entries SET entry = ? WHERE id = ?").run(JSON.stringify(entry), entry.id);
  }

  get(id: string): TranscriptEntry | null {
    const row = this.db.prepare("SELECT entry FROM transcript_entries WHERE id = ?").get(id) as { entry: string } | undefined;
    return row ? (JSON.parse(row.entry) as TranscriptEntry) : null;
  }

  tail(limit: number): TranscriptEntry[] {
    const rows = this.db.prepare("SELECT entry FROM transcript_entries ORDER BY seq DESC LIMIT ?").all(limit) as { entry: string }[];
    return rows.reverse().map((r) => JSON.parse(r.entry) as TranscriptEntry);
  }

  /** PAL-02 §4.5: a page of entries around `aroundId`, with `before`/`after` counts and whether more exist on either side. */
  page(aroundId: string, before: number, after: number): { entries: TranscriptEntry[]; hasOlder: boolean; hasNewer: boolean } {
    const row = this.db.prepare("SELECT seq FROM transcript_entries WHERE id = ?").get(aroundId) as { seq: number } | undefined;
    if (!row) return { entries: [], hasOlder: false, hasNewer: false };
    const older = this.db.prepare("SELECT entry FROM transcript_entries WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(row.seq, before + 1) as { entry: string }[];
    const newer = this.db.prepare("SELECT entry FROM transcript_entries WHERE seq >= ? ORDER BY seq ASC LIMIT ?").all(row.seq, after + 2) as { entry: string }[];
    const hasOlder = older.length > before;
    const hasNewer = newer.length > after + 1;
    const entries = [...older.slice(0, before).reverse(), ...newer.slice(0, after + 1)].map((r) => JSON.parse(r.entry) as TranscriptEntry);
    return { entries, hasOlder, hasNewer };
  }

  close(): void {
    this.db.close();
  }
}
