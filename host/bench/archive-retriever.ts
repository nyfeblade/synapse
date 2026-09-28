import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SendMessageEntry, TranscriptEntry, UserMessageEntry } from "@synapse/shared";
import { HistoryArchive } from "../history/archive";
import { z } from "zod";
import { createHistoryToolExtension, formatHits } from "../history/history-tool";
import { chunkDocument, rowsForDocument, rowsForEntry, rowsForSummary, type RowContext } from "../history/indexer";
import type { Archive } from "./corpus";
import { baselineRetriever, renderBaselineMemory } from "./retrievers";
import { estimateTokens, type Passage, type Retriever } from "./scorer";

const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);

/**
 * What SearchHistory's definition costs on EVERY model call: its wire form (the same measure as
 * test/perf/prompt-budget.test.ts) at the CLI's measured ~2.0 chars per token for tool schemas.
 */
export function searchHistorySchemaTokens(): number {
  const t = createHistoryToolExtension({ archive: null as never }).extraTools!("bench", () => null)[0]!;
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(z.object(t.schema as never), { io: "input" })));
  return Math.ceil(JSON.stringify({ name: `mcp__bot__${t.name}`, description: t.description, input_schema: schema }).length / 2);
}

/** A bench turn as the transcript entry the host would have stored for it. */
export function turnEntry(t: Archive["turns"][number]): TranscriptEntry {
  const at = noon(t.date) + (t.seq % 86_400) * 1000; // keeps the same-day order
  return t.speaker === "user"
    ? ({ kind: "message", id: t.id, role: "user", content: t.text, createdAt: at } satisfies UserMessageEntry)
    : ({ kind: "send-message", id: t.id, requestId: `r${t.seq}`, createdAt: at, message: { type: "text", content: t.text } } satisfies SendMessageEntry);
}

export interface ArchiveBuild { dir: string; archive: HistoryArchive; indexMs: number; turnsBytes: number; totalBytes: number; rows: number }

/**
 * Indexes the bench archive with the PRODUCTION code: HistoryArchive, and the indexer's own row
 * builders (contextual prefix, document chunking). Only the redactor is an identity (the corpus is
 * synthetic and holds no secrets). Sizes are measured after a WAL checkpoint: turns + summaries
 * first, then documents, so disk per 1k turns is not inflated by the documents.
 */
export function buildArchive(c: Archive): ArchiveBuild & { srcToPassage: Map<string, { id: string; sources?: string[] }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-archive-"));
  const file = path.join(dir, "history.db");
  const archive = new HistoryArchive(file, { redact: (_b, t) => t, secrets: () => [] });
  const ctx: RowContext = { botName: "Bench", timeZone: "UTC" };
  const srcToPassage = new Map<string, { id: string; sources?: string[] }>();
  const size = () => {
    const db = new DatabaseSync(file);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
    return fs.statSync(file).size;
  };
  const t0 = performance.now();
  const B = 500;
  for (let i = 0; i < c.turns.length; i += B) {
    const rows = c.turns.slice(i, i + B).flatMap((t) => rowsForEntry(ctx, turnEntry(t)));
    archive.put(c.botId, rows);
  }
  for (const t of c.turns) srcToPassage.set(`e:${t.id}`, { id: t.id });
  for (const s of c.summaries) {
    const rows = rowsForSummary(ctx, { text: s.text, at: noon(s.date), key: s.id });
    archive.put(c.botId, rows);
    for (const r of rows) srcToPassage.set(r.src, { id: s.id, sources: s.sources });
  }
  const turnsBytes = size();
  for (const d of c.docs) {
    const text = d.pages.join("\f");
    const rows = rowsForDocument(ctx, { attachmentId: d.id, title: d.title, text, at: noon(c.asOf) });
    chunkDocument(text).forEach((ch, i) => {
      const page = /page (\d+)/.exec(ch.section)?.[1] ?? "1";
      srcToPassage.set(rows[i]!.src, { id: `doc:${d.id}#p${page}` });
    });
    for (let i = 0; i < rows.length; i += B) archive.put(c.botId, rows.slice(i, i + B));
  }
  const indexMs = performance.now() - t0;
  return { dir, archive, indexMs, turnsBytes, totalBytes: size(), rows: archive.stats(c.botId).rows, srcToPassage };
}

/**
 * ARCHIVE: what a Synapse Bot has with this branch. Everything the baseline has (memory, latest
 * summary, live tail, restore block) plus ONE SearchHistory call with the question as the query,
 * at the tool's defaults (8 hits, ~1.5k tokens). Tokens = baseline context + the tool's result text.
 */
export function archiveRetriever(c: Archive, build = buildArchive(c)): Retriever & { build: typeof build; latencies: number[] } {
  const base = baselineRetriever(c);
  const latencies: number[] = [];
  return {
    name: "archive (baseline + SearchHistory: FTS5 BM25 over prefixed turns, summaries, document chunks)",
    schemaTokens: searchHistorySchemaTokens(), build, latencies,
    retrieve: (q) => {
      const b = base.retrieve(q);
      const t0 = performance.now();
      const hits = build.archive.search(c.botId, { query: q.question });
      latencies.push(performance.now() - t0);
      const passages: Passage[] = hits.map((h) => {
        const p = build.srcToPassage.get(h.src);
        return { id: p?.id ?? h.src, date: new Date(h.at).toISOString().slice(0, 10), text: formatHits([h]), sources: p?.sources };
      });
      const tool = `${hits.length} matches, oldest first:\n${formatHits(hits)}`;
      const baseTokens = b.passages.reduce((a, p) => a + estimateTokens(p.text), 0);
      return { passages: [...b.passages, ...passages], tokens: baseTokens + estimateTokens(tool), fired: true };
    },
  };
}

/**
 * HOSTED-AGENT MODE (the honest comparison target): a hosted agent that self-summarises at 90% of a 200k window
 * so at its fullest it holds ~180k tokens of raw recent history, plus memory, and no search. This
 * is the raw turns, newest back, up to 180k tokens, plus the memory section. Its documents are not
 * in the turns, so they are not in context either.
 */
export const HOSTED_WINDOW_TOKENS = 180_000;
export function hostedAgentModeRetriever(c: Archive): Retriever {
  const tail: Passage[] = [];
  let used = 0;
  for (let i = c.turns.length - 1; i >= 0; i--) {
    const t = c.turns[i]!;
    const n = estimateTokens(t.text);
    if (used + n > HOSTED_WINDOW_TOKENS) break;
    used += n;
    tail.push({ id: t.id, date: t.date, text: t.text });
  }
  const passages = [renderBaselineMemory(c), ...tail.reverse()];
  return { name: `hosted-agent mode (raw history up to ${HOSTED_WINDOW_TOKENS / 1000}k tokens + memory, no search)`, schemaTokens: 0, retrieve: () => ({ passages, fired: false }) };
}
