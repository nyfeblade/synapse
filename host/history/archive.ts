import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The history archive: every transcript entry, compaction summary and attached-document chunk a Bot
 * has, full-text indexed (SQLite FTS5, BM25 over a contextual prefix and the original wording), so a
 * Bot can find what was summarised away, rather than only grepping its transcript file.
 *
 * Isolation: every Bot runs as the one uid `box`, which can read all of agent-data, so this is ONE
 * file under the host's private directory (bothost, 0700), itself 0600, and every query is scoped
 * by the bot id the HOST resolved. Redaction: `put` is the only writer and cleans every text column
 * (the Phase 3 scanner plus the vault's values); with no scanner yet it refuses to write.
 * Guards: test/history/archive-redaction-guard.test.ts, test/history/archive-isolation.test.ts.
 */

/** One indexed row. Every field is declared in archive-redaction-guard.test.ts as text (redacted) or not. */
export interface ArchiveRow {
  /** Idempotency key, host-generated: "e:<entry id>", "s:<hash>", "d:<attachment id>#<n>". */
  src: string;
  /** "chat", "summary" or "doc:<attachment id>": which sequence `around` walks. */
  stream: string;
  at: number;
  speaker: string;
  /** The contextual prefix: Bot name, date, speaker, conversation, document title and section. */
  ctx: string;
  body: string;
}

export interface ArchiveHit { ref: number; src: string; at: number; stream: string; speaker: string; ctx: string; text: string; truncated: boolean }
export interface SearchQuery { query: string; from?: number; to?: number; limit?: number; maxChars?: number; hitChars?: number }
export interface ArchiveStats { rows: number; approxBytes: number; fileBytes: number; oldestAt: number | null; newestAt: number | null }

/** The redactor returns null while it cannot redact yet (Phase 3 not up): the write is refused. */
export type Redactor = (botId: string, text: string) => string | null;
export class ArchiveNotReady extends Error {
  constructor() { super("history archive: no secret redactor yet; the write is refused"); }
}

export const SEARCH_DEFAULTS = { limit: 8, maxLimit: 20, maxChars: 6000, hitChars: 700 } as const;

const STOP = new Set(("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
  "me my no not of on or our so than that the their them then there these they this to up us was we were what when where which who " +
  "whom why will with would you your yours about any also just more most other some such only own same too very s t don should now " +
  "ll re ve d m o y ever").split(" "));

export function archiveTerms(q: string): string[] {
  const out: string[] = [];
  for (const t of q.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (t.length < 2 || STOP.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === 16) break;
  }
  return out;
}

/**
 * A window of `body` of at most `max` chars around the best cluster of query terms. A term counts
 * 1/(its occurrences in the body), so a rare term ("termination") outweighs one the text repeats
 * ("notice"), and a term the label already shows counts nothing. The window is cut at spaces, so
 * a value is never glued to the ellipsis.
 */
export function snippet(body: string, terms: string[], max: number, label = ""): { text: string; truncated: boolean } {
  if (body.length <= max) return { text: body, truncated: false };
  const lower = body.toLowerCase();
  const hits: { at: number; t: number }[] = [];
  const weight: number[] = terms.map(() => 0);
  terms.forEach((t, i) => {
    for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + 1)) hits.push({ at, t: i });
  });
  for (const h of hits) weight[h.t]! += 1;
  // A term the label already shows (a document title, a speaker) says nothing about where to look.
  const shown = label.toLowerCase();
  const worth = (t: number) => (shown.includes(terms[t]!) ? 0 : 1 / weight[t]!);
  hits.sort((a, b) => a.at - b.at);
  let best = 0, bestScore = -1;
  for (let i = 0; i < hits.length; i++) {
    const seen = new Set<number>();
    for (let j = i; j < hits.length && hits[j]!.at < hits[i]!.at + max * 0.6; j++) seen.add(hits[j]!.t);
    const score = [...seen].reduce((a, t) => a + worth(t), 0);
    if (score > bestScore + 1e-9) { bestScore = score; best = hits[i]!.at; }
  }
  const start = Math.max(0, Math.min(body.length - max, best - Math.floor(max * 0.2)));
  const lo = start === 0 ? 0 : (body.indexOf(" ", start) + 1 || start);
  let hi = Math.min(body.length, lo + max);
  if (hi < body.length) { const sp = body.lastIndexOf(" ", hi); if (sp > lo) hi = sp; }
  return { text: `${lo > 0 ? "… " : ""}${body.slice(lo, hi)}${hi < body.length ? " …" : ""}`, truncated: true };
}

export class HistoryArchive {
  private db: DatabaseSync;

  constructor(readonly file: string, private d: { redact: Redactor; secrets(botId: string): string[] }) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Created 0600 before SQLite opens it: SQLite gives the -wal and -shm files the database's mode.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;");
    } catch {
      throw new Error("node:sqlite was built without FTS5; the history archive needs it");
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-4000;
      CREATE TABLE IF NOT EXISTS archive(id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, src TEXT NOT NULL, stream TEXT NOT NULL,
        at INTEGER NOT NULL, speaker TEXT NOT NULL, ctx TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(bot_id, src));
      CREATE INDEX IF NOT EXISTS archive_stream ON archive(bot_id, stream, at);
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(ctx, body, content='archive', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS archive_ai AFTER INSERT ON archive BEGIN INSERT INTO archive_fts(rowid, ctx, body) VALUES (new.id, new.ctx, new.body); END;
      CREATE TRIGGER IF NOT EXISTS archive_ad AFTER DELETE ON archive BEGIN INSERT INTO archive_fts(archive_fts, rowid, ctx, body) VALUES ('delete', old.id, old.ctx, old.body); END;
      CREATE TRIGGER IF NOT EXISTS archive_au AFTER UPDATE ON archive BEGIN
        INSERT INTO archive_fts(archive_fts, rowid, ctx, body) VALUES ('delete', old.id, old.ctx, old.body);
        INSERT INTO archive_fts(rowid, ctx, body) VALUES (new.id, new.ctx, new.body); END;
      CREATE TABLE IF NOT EXISTS archive_meta(bot_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bot_id, key));
    `);
    for (const f of [`${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }

  /** The ONLY writer of archive rows. Every text column is redacted here; no redactor = no write. */
  put(botId: string, rows: ArchiveRow[]): number {
    if (!rows.length) return 0;
    const secrets = this.d.secrets(botId).filter((v) => v.length >= 4);
    const clean = (text: string): string => {
      let s = this.d.redact(botId, text);
      if (s === null) throw new ArchiveNotReady();
      for (const v of secrets) if (s.includes(v)) s = s.split(v).join("[secret]");
      return s;
    };
    const cleaned = rows.map((r) => ({ src: r.src, stream: r.stream, at: r.at, speaker: clean(r.speaker), ctx: clean(r.ctx), body: clean(r.body) }));
    const ins = this.db.prepare(`INSERT INTO archive(bot_id, src, stream, at, speaker, ctx, body) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, src) DO UPDATE SET stream = excluded.stream, at = excluded.at, speaker = excluded.speaker, ctx = excluded.ctx, body = excluded.body
      WHERE archive.body IS NOT excluded.body OR archive.ctx IS NOT excluded.ctx OR archive.at IS NOT excluded.at`);
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const c of cleaned) n += Number(ins.run(botId, c.src, c.stream, c.at, c.speaker, c.ctx, c.body).changes);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  search(botId: string, q: SearchQuery): ArchiveHit[] {
    const terms = archiveTerms(q.query);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(q.limit ?? SEARCH_DEFAULTS.limit, SEARCH_DEFAULTS.maxLimit));
    const maxChars = q.maxChars ?? SEARCH_DEFAULTS.maxChars;
    const hitChars = q.hitChars ?? SEARCH_DEFAULTS.hitChars;
    const rows = this.db.prepare(
      `SELECT a.id AS ref, a.src, a.stream, a.at, a.speaker, a.ctx, a.body, bm25(archive_fts, 0.4, 1.0) AS score
       FROM archive_fts JOIN archive a ON a.id = archive_fts.rowid
       WHERE archive_fts MATCH ? AND a.bot_id = ? AND a.at >= ? AND a.at < ?
       ORDER BY score LIMIT ?`,
    ).all(terms.map((t) => `"${t}"`).join(" OR "), botId, q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER, limit) as unknown as (Omit<ArchiveHit, "text" | "truncated"> & { body: string })[];
    const out: ArchiveHit[] = [];
    let used = 0;
    for (const r of rows) {
      const s = snippet(r.body, terms, Math.min(hitChars, maxChars - used), r.ctx);
      if (s.text.length < 40 && out.length) break;
      out.push({ ref: r.ref, src: r.src, at: r.at, stream: r.stream, speaker: r.speaker, ctx: r.ctx, ...s });
      used += s.text.length + r.ctx.length;
      if (used >= maxChars) break;
    }
    return out;
  }

  /** The rows just before and after one hit in the same stream (chat, a summary chain, a document). */
  around(botId: string, ref: number, n: number, hitChars = 1500): ArchiveHit[] {
    type R = Omit<ArchiveHit, "text" | "truncated"> & { body: string };
    const center = this.db.prepare("SELECT id AS ref, src, stream, at, speaker, ctx, body FROM archive WHERE bot_id = ? AND id = ?").get(botId, ref) as R | undefined;
    if (!center) return [];
    const k = Math.max(1, Math.min(n, 10));
    const before = this.db.prepare(
      "SELECT id AS ref, src, stream, at, speaker, ctx, body FROM archive WHERE bot_id = ? AND stream = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?",
    ).all(botId, center.stream, center.at, center.at, center.ref, k) as unknown as R[];
    const after = this.db.prepare(
      "SELECT id AS ref, src, stream, at, speaker, ctx, body FROM archive WHERE bot_id = ? AND stream = ? AND (at > ? OR (at = ? AND id > ?)) ORDER BY at ASC, id ASC LIMIT ?",
    ).all(botId, center.stream, center.at, center.at, center.ref, k) as unknown as R[];
    return [...before.reverse(), center, ...after].map((r) => {
      const truncated = r.body.length > hitChars;
      return { ref: r.ref, src: r.src, at: r.at, stream: r.stream, speaker: r.speaker, ctx: r.ctx, text: truncated ? `${r.body.slice(0, hitChars)}…` : r.body, truncated };
    });
  }

  has(botId: string, src: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM archive WHERE bot_id = ? AND src = ?").get(botId, src) !== undefined;
  }

  stats(botId: string): ArchiveStats {
    const r = this.db.prepare("SELECT count(*) AS n, coalesce(sum(length(ctx) + length(body)), 0) AS chars, min(at) AS lo, max(at) AS hi FROM archive WHERE bot_id = ?").get(botId) as { n: number; chars: number; lo: number | null; hi: number | null };
    // Cross-Bot on purpose, and returns one number: the whole file's text, to apportion its bytes.
    const all = this.db.prepare("SELECT total(length(ctx) + length(body)) AS chars FROM archive").get() as { chars: number };
    const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const fileBytes = size(this.file) + size(`${this.file}-wal`);
    return { rows: r.n, approxBytes: all.chars ? Math.round((fileBytes * r.chars) / all.chars) : 0, fileBytes, oldestAt: r.lo, newestAt: r.hi };
  }

  getMeta(botId: string, key: string): string | null {
    return (this.db.prepare("SELECT value FROM archive_meta WHERE bot_id = ? AND key = ?").get(botId, key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(botId: string, key: string, value: string): void {
    this.db.prepare("INSERT INTO archive_meta(bot_id, key, value) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value").run(botId, key, value);
  }

  removeBot(botId: string): void {
    this.db.prepare("DELETE FROM archive WHERE bot_id = ?").run(botId);
    this.db.prepare("DELETE FROM archive_meta WHERE bot_id = ?").run(botId);
  }

  close(): void {
    this.db.close();
  }
}
