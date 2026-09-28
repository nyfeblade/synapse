import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptEntry } from "@synapse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SseHub } from "../../gateway/sse-hub";
import { HistoryArchive } from "../../history/archive";
import { HistoryIndexer, chunkDocument, rowsForEntry, rowsForSummary } from "../../history/indexer";

const B = "bot-a";
const at = Date.UTC(2023, 3, 11, 14, 2);
const msg = (id: string, content: string, t = at): TranscriptEntry => ({ kind: "message", id, role: "user", content, createdAt: t });
const sent = (id: string, content: string, t = at): TranscriptEntry => ({ kind: "send-message", id, requestId: "r", createdAt: t, message: { type: "text", content } });
const ctx = { botName: "Nova", timeZone: "UTC" };

let open: { a: HistoryArchive; ix?: HistoryIndexer }[] = [];
afterEach(() => { for (const o of open) { o.ix?.stop(); o.a.close(); } open = []; });

function setup(over: Partial<ConstructorParameters<typeof HistoryIndexer>[0]> = {}, redact: (b: string, t: string) => string | null = (_b, t) => t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hist-ix-"));
  const a = new HistoryArchive(path.join(dir, "history.db"), { redact, secrets: () => [] });
  const hub = new SseHub();
  const entries = new Map<string, TranscriptEntry[]>();
  const sessions = new Map<string, string>();
  const ix = new HistoryIndexer({
    archive: a, hub, nameOf: () => "Nova", timeZone: () => "UTC", botIds: () => [...entries.keys()], exists: () => true,
    entries: (id) => entries.get(id) ?? [], sessionFiles: (id) => [...sessions.keys()].filter((f) => f.includes(id)), readSession: (f) => sessions.get(f) ?? "",
    pauseMs: 1, retryMs: 5, ...over,
  });
  open.push({ a, ix });
  return { a, hub, ix, entries, sessions, dir };
}

describe("rows for the archive", () => {
  it("a user message and a Bot reply carry a contextual prefix and the original wording", () => {
    const [u] = rowsForEntry(ctx, msg("t1u", "For the record, the Halvor budget is $40k."));
    expect(u).toMatchObject({ src: "e:t1u", stream: "chat", at, speaker: "user", body: "For the record, the Halvor budget is $40k." });
    expect(u!.ctx).toBe("Nova · 2023-04-11 Tue 14:02 · user");
    expect(rowsForEntry(ctx, sent("t1s1", "Noted."))[0]).toMatchObject({ speaker: "you", body: "Noted." });
    expect(rowsForEntry(ctx, { kind: "tool-call", id: "t1a1", requestId: "r", segmentId: "s", hidden: false, name: "Bash", step: "Ran ls", icon: "terminal", metric: null, status: "running", startedAt: at })).toEqual([]);
    expect(rowsForEntry(ctx, { kind: "tool-call", id: "t1a1", requestId: "r", segmentId: "s", hidden: false, name: "Bash", step: "Ran ls", icon: "terminal", metric: null, status: "done", startedAt: at, endedAt: at })[0]!.body).toContain("Ran ls");
  });

  it("an attached text document becomes titled, sectioned chunks after the attachment line", () => {
    const e: TranscriptEntry = { kind: "user-attachment", id: "t2ua1", batchId: "b", attachmentId: "abc.md", name: "Acme contract.md", size: 10, mime: "text/markdown", storePath: "/x", boxPath: null, createdAt: at };
    const text = `# Terms\n\n${"The retainer is paid monthly. ".repeat(60)}\n\n# Termination\n\nEither side may end it with 30 days notice.`;
    const rows = rowsForEntry(ctx, e, text);
    expect(rows[0]).toMatchObject({ src: "e:t2ua1", stream: "chat" });
    const docs = rows.slice(1);
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.every((r) => r.stream === "doc:abc.md" && r.ctx.includes("Acme contract.md"))).toBe(true);
    expect(docs.at(-1)!.ctx).toContain("Termination");
    expect(new Set(docs.map((r) => r.src)).size).toBe(docs.length);
  });

  it("chunks a document by page and paragraph, under the target size, losing no text", () => {
    const pages = Array.from({ length: 5 }, (_, i) => `Page ${i + 1} para one. ${"word ".repeat(150)}\n\nPara two of page ${i + 1}.`);
    const chunks = chunkDocument(pages.join("\f"), 1200);
    expect(chunks.every((c) => c.text.length <= 1200)).toBe(true);
    expect(chunks.map((c) => c.section)).toContain("page 3");
    const squash = (s: string) => s.replace(/\s+/g, "");
    expect(squash(chunks.map((c) => c.text).join(""))).toBe(squash(pages.join("")));
  });

  it("a compaction summary is its own dated row", () => {
    const [s] = rowsForSummary(ctx, { text: "## Decisions\n- the Halvor budget is $40k", at, key: "sess1:u9" });
    expect(s).toMatchObject({ stream: "summary", speaker: "summary", at });
    expect(s!.ctx).toContain("conversation summary");
  });
});

describe("HistoryIndexer", () => {
  it("indexes live entries asynchronously (never inside the publish) and idempotently", async () => {
    const { a, hub, ix } = setup();
    ix.start();
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: msg("t1u", "the Halvor budget is $40k") } });
    expect(a.has(B, "e:t1u"), "indexing ran inside the publish, on the turn's path").toBe(false);
    await ix.drain();
    expect(a.has(B, "e:t1u")).toBe(true);
    hub.publish({ channel: "transcript", payload: { botId: B, op: "update", entry: msg("t1u", "the Halvor budget is $40k") } });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "typing", typing: true } as never });
    await ix.drain();
    expect(a.stats(B).rows).toBe(1);
  });

  it("holds writes while there is no redactor and indexes them once there is", async () => {
    let ready = false;
    const { a, hub, ix } = setup({}, (_b, t) => (ready ? t : null));
    ix.start();
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: msg("t1u", "hello there") } });
    await new Promise((r) => setTimeout(r, 30));
    expect(a.stats(B).rows).toBe(0);
    ready = true;
    await ix.drain();
    expect(a.stats(B).rows).toBe(1);
  });

  it("backfills existing transcripts and summaries in batches, resumably, without duplicates", async () => {
    const { a, ix, entries, sessions, dir } = setup({ batch: 10 });
    entries.set(B, Array.from({ length: 35 }, (_, i) => msg(`t${i}u`, `message number ${i}`, at + i)));
    sessions.set(`/s/${B}/one.jsonl`, [
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "b1" }),
      JSON.stringify({ type: "user", isCompactSummary: true, uuid: "u9", timestamp: new Date(at).toISOString(), message: { content: "## Decisions\n- the Halvor budget is $40k" } }),
    ].join("\n"));
    ix.backfill();
    await ix.drain();
    expect(a.stats(B).rows).toBe(36);
    expect(a.getMeta(B, "bf:entries")).toBe("35");
    // a second host start: nothing new, nothing duplicated
    const ix2 = new HistoryIndexer({ archive: a, nameOf: () => "Nova", timeZone: () => "UTC", botIds: () => [B], exists: () => true, entries: (id) => entries.get(id) ?? [], sessionFiles: () => [`/s/${B}/one.jsonl`], readSession: (f) => sessions.get(f)!, pauseMs: 1 });
    open.push({ a: { close: () => {} } as never, ix: ix2 });
    entries.get(B)!.push(msg("t35u", "one more"));
    ix2.backfill();
    await ix2.drain();
    expect(a.stats(B).rows).toBe(37);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("resumes a backfill from its cursor after a stop", async () => {
    const { a, ix, entries } = setup({ batch: 5, pauseMs: 20 });
    entries.set(B, Array.from({ length: 40 }, (_, i) => msg(`t${i}u`, `message number ${i}`, at + i)));
    ix.backfill();
    await new Promise((r) => setTimeout(r, 30));
    ix.stop();
    const done = Number(a.getMeta(B, "bf:entries"));
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(40);
    const ix2 = new HistoryIndexer({ archive: a, nameOf: () => "Nova", timeZone: () => "UTC", botIds: () => [B], exists: () => true, entries: (id) => entries.get(id) ?? [], sessionFiles: () => [], readSession: () => "", pauseMs: 1, batch: 5 });
    open.push({ a: { close: () => {} } as never, ix: ix2 });
    ix2.backfill();
    await ix2.drain();
    expect(a.stats(B).rows).toBe(40);
  });

  it("indexes compaction summaries when told a compaction finished, once", async () => {
    const { a, ix, sessions } = setup();
    sessions.set(`/s/${B}/one.jsonl`, JSON.stringify({ type: "user", isCompactSummary: true, uuid: "u1", timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text: "summary text about the Halvor budget" }] } }));
    ix.compacted(B);
    ix.compacted(B);
    await ix.drain();
    expect(a.search(B, { query: "halvor" }).map((h) => h.stream)).toEqual(["summary"]);
  });

  it("reads an attached text file's content, and only the attachment line for a binary one", async () => {
    const { a, hub, ix, dir } = setup();
    ix.start();
    const f = path.join(dir, "notes.txt");
    fs.writeFileSync(f, "The Tamsin offsite city is Osaka.");
    const att = (id: string, name: string, mime: string, storePath: string): TranscriptEntry => ({ kind: "user-attachment", id, batchId: "b", attachmentId: `${id}.x`, name, size: 30, mime, storePath, boxPath: null, createdAt: at });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: att("t1ua1", "notes.txt", "text/plain", f) } });
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: att("t1ua2", "scan.pdf", "application/pdf", f) } });
    await ix.drain();
    expect(a.search(B, { query: "tamsin osaka" }).map((h) => h.stream)).toEqual(["doc:t1ua1.x"]);
    expect(a.has(B, "e:t1ua2")).toBe(true);
    expect(a.stats(B).rows).toBe(3);
  });

  it("purges a deleted Bot and drops its queued work", async () => {
    const { a, hub, ix } = setup();
    ix.start();
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: msg("t1u", "hello") } });
    await ix.drain();
    hub.publish({ channel: "transcript", payload: { botId: B, op: "append", entry: msg("t2u", "again") } });
    hub.publish({ channel: "agents", payload: { removedId: B, activeAgentId: null } });
    await ix.drain();
    expect(a.stats(B).rows).toBe(0);
  });
});
