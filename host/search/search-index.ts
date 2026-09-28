import { DatabaseSync } from "node:sqlite";
import { LIMITS, SNIPPET_CLOSE, SNIPPET_OPEN, type BotSummary, type SearchResult, type TranscriptEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { SseHub } from "../gateway/sse-hub";
import { log } from "../util/log";

type DocKind = "message" | "file" | "link" | "bot";
interface Doc { kind: DocKind; title: string; body: string; createdAt: number }

export function searchTerms(q: string): string[] {
  return (q.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, LIMITS.searchTermsMax);
}
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>()"']+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/** A message doc plus one link doc per URL found in its text. Shared by both message-shaped docsFor() branches. */
export function textDoc(text: string, createdAt: number): Doc[] {
  const body = text.slice(0, LIMITS.searchBodyMax);
  return [{ kind: "message", title: "", body, createdAt }, ...linksIn(text).map((u) => ({ kind: "link" as const, title: u, body: u, createdAt }))];
}

function docsFor(e: TranscriptEntry): Doc[] {
  if (e.kind === "message") return textDoc(e.content, e.createdAt);
  if (e.kind === "user-attachment") return [{ kind: "file", title: e.name, body: e.name, createdAt: e.createdAt }];
  if (e.kind === "send-message") {
    const m = e.message;
    if (m.type === "text") return textDoc(m.content, e.createdAt);
    if (m.type === "attachment") return [{ kind: "file", title: m.name, body: `${m.name} ${m.caption ?? ""}`, createdAt: e.createdAt }];
    if (m.type === "card" && m.card.kind === "link") return [{ kind: "link", title: m.card.url, body: `${m.card.title ?? ""} ${m.card.description ?? ""}`, createdAt: e.createdAt }];
  }
  return [];
}

export class SearchIndex {
  private db: DatabaseSync;
  private redact: (botId: string, text: string) => string;
  /** I5: o.redact is the secret scanner's redact; every stored title and body goes through it. */
  constructor(file: string, o: { redact?(botId: string, text: string): string } = {}) {
    this.redact = o.redact ?? ((_b, t) => t);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, entry_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS docs_entry ON docs(bot_id, entry_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2', prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN INSERT INTO docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    `);
  }

  private replace(botId: string, entryId: string, docs: Doc[]): void {
    this.db.prepare("DELETE FROM docs WHERE bot_id = ? AND entry_id = ?").run(botId, entryId);
    const ins = this.db.prepare("INSERT INTO docs(bot_id, entry_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const d of docs) ins.run(botId, entryId, d.kind, this.redact(botId, d.title), this.redact(botId, d.body), d.createdAt);
  }
  upsertEntry(botId: string, e: TranscriptEntry): void {
    const docs = docsFor(e);
    if (docs.length) this.replace(botId, e.id, docs);
  }
  upsertBot(b: BotSummary): void {
    this.replace(b.id, "@bot", [{ kind: "bot", title: b.profile.name, body: b.profile.description, createdAt: b.updatedAt }]);
  }
  removeBot(botId: string): void {
    this.db.prepare("DELETE FROM docs WHERE bot_id = ?").run(botId);
  }

  search(query: string): SearchResult[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(" ");
    // Note: FTS5 aux functions (snippet/bm25) need the live FTS cursor and can't be evaluated
    // inside a query that also uses a window function — so the aux functions run in the
    // innermost subquery, and ROW_NUMBER() partitions over the already-materialized rows.
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT botId, entryId, kind, title, createdAt, snip, score,
               ROW_NUMBER() OVER (PARTITION BY botId ORDER BY score) AS rn
        FROM (
          SELECT d.bot_id AS botId, d.entry_id AS entryId, d.kind, d.title, d.created_at AS createdAt,
                 snippet(docs_fts, 1, ?, ?, '…', ?) AS snip, bm25(docs_fts) AS score
          FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ?
        )
      )
      WHERE rn <= ? ORDER BY score LIMIT ?`,
    ).all(SNIPPET_OPEN, SNIPPET_CLOSE, LIMITS.searchSnippetTokens, match, LIMITS.searchPerBot, LIMITS.searchResultsMax) as { botId: string; entryId: string; kind: DocKind; title: string; createdAt: number; snip: string }[];
    return rows.map((r): SearchResult => {
      if (r.kind === "bot") return { kind: "bot", botId: r.botId, title: r.title, subtitle: r.snip };
      if (r.kind === "file") return { kind: "file", botId: r.botId, entryId: r.entryId, name: r.title, snippet: r.snip, createdAt: r.createdAt };
      if (r.kind === "link") return { kind: "link", botId: r.botId, entryId: r.entryId, url: r.title, snippet: r.snip, createdAt: r.createdAt };
      return { kind: "message", botId: r.botId, entryId: r.entryId, snippet: r.snip, createdAt: r.createdAt };
    });
  }

  close(): void {
    this.db.close();
  }
}

export function startSearchSync(d: { hub: SseHub; index: SearchIndex }): () => void {
  return d.hub.subscribe((ev) => {
    try {
      if (ev.channel === "transcript" && ev.payload.op !== "typing") d.index.upsertEntry(ev.payload.botId, ev.payload.entry);
      else if (ev.channel === "agent-upserted") d.index.upsertBot(ev.payload.agent);
      else if (ev.channel === "agents") d.index.removeBot(ev.payload.removedId);
    } catch (e) {
      log.warn("search index update failed", { error: String(e) });
    }
  });
}

/** Boot: rebuild from every Bot's stored transcript. */
export function reindexSearch(d: { index: SearchIndex; bots: BotService }): void {
  for (const id of d.bots.ids()) {
    d.index.removeBot(id);
    d.index.upsertBot(d.bots.summary(id));
    for (const e of d.bots.tail(id, 100_000)) d.index.upsertEntry(id, e);
  }
}
