import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry, UserAttachmentEntry } from "@synapse/shared";
import { mirrorRecord } from "../context/transcript-mirror";
import type { SseHub } from "../gateway/sse-hub";
import { log } from "../util/log";
import { ArchiveNotReady, type ArchiveRow, type HistoryArchive } from "./archive";

/**
 * Feeds the history archive: live transcript entries (from the same hub events the transcript
 * mirror writes), compaction summaries (when a compaction completes) and the text of attached text
 * files, plus a throttled, resumable backfill at host start. Nothing here runs on a turn's path:
 * events only push onto a queue, drained on later ticks. Every write goes through archive.put(),
 * which redacts; this module never opens the database.
 */

export interface RowContext { botName: string; timeZone: string }
export interface Chunk { text: string; section: string }

const DOC_TARGET = 1200;
/** A text file this size or smaller is read whole; larger ones are left to the Bot's own tools. */
const DOC_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|x-ipynb\+json|yaml|xml|mbox))|^message\/rfc822$/;

function stamp(ms: number, timeZone: string): string {
  let tz = timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}
const prefix = (c: RowContext, at: number, ...rest: string[]) => [c.botName, stamp(at, c.timeZone), ...rest].join(" · ");

function speakerOf(e: TranscriptEntry): string {
  if (e.kind === "message") {
    if ("fromAgent" in e && e.fromAgent) return e.fromAgent.name;
    if ("toAgent" in e && e.toAgent) return `you to ${e.toAgent.name}`;
    return e.role === "user" ? "user" : "you";
  }
  if (e.kind === "send-message") return e.author?.name ?? "you";
  if (e.kind === "user-attachment") return "user";
  if (e.kind === "tool-call") return "you (tool)";
  return "app";
}

/** The mirror's own rendering of an entry, as text (so the archive and the mirror say the same thing). */
function textOf(e: TranscriptEntry): string | null {
  const r = mirrorRecord(e) as { message?: { content?: { type: string; text?: string; name?: string; input?: { step?: string } }[] }; event?: unknown; text?: string } | null;
  if (!r) return null;
  const b = r.message?.content?.[0];
  if (b?.type === "text") return b.text ?? null;
  if (b?.type === "tool_use") return `[${b.name}: ${b.input?.step ?? ""}]`;
  if (r.text !== undefined) return r.text;
  if (r.event !== undefined) return `[${JSON.stringify(r.event)}]`;
  return null;
}

/** Pages (form feeds), then paragraphs, packed up to `target` chars; a section is the latest heading or the page. */
export function chunkDocument(text: string, target = DOC_TARGET): Chunk[] {
  const pages = text.split("\f");
  const out: Chunk[] = [];
  let heading = "";
  pages.forEach((page, pi) => {
    const where = () => [heading, pages.length > 1 ? `page ${pi + 1}` : ""].filter(Boolean).join(", ") || "start";
    let buf = "", section = "";
    const flush = () => { if (buf.trim()) out.push({ text: buf.trim(), section }); buf = ""; };
    const pieces: string[] = [];
    for (const para of page.split(/\n\s*\n/)) {
      if (para.length <= target) { pieces.push(para); continue; }
      // An over-long paragraph splits at sentence ends, then at spaces.
      let rest = para;
      while (rest.length > target) {
        const cut = Math.max(rest.lastIndexOf(". ", target - 1) + 1, rest.lastIndexOf(" ", target - 1));
        const at = cut > target / 3 ? cut : target;
        pieces.push(rest.slice(0, at));
        rest = rest.slice(at);
      }
      if (rest.trim()) pieces.push(rest);
    }
    for (const p of pieces) {
      const h = /^\s*#{1,6}\s+(.+)$/m.exec(p);
      if (buf && buf.length + p.length + 2 > target) flush();
      if (h) { if (buf) flush(); heading = h[1]!.trim().slice(0, 80); }
      if (!buf) section = where();
      buf += (buf ? "\n\n" : "") + p;
    }
    flush();
  });
  return out;
}

export function rowsForDocument(c: RowContext, d: { attachmentId: string; title: string; text: string; at: number }): ArchiveRow[] {
  const chunks = chunkDocument(d.text);
  return chunks.map((ch, i) => ({
    src: `d:${d.attachmentId}#${i + 1}`, stream: `doc:${d.attachmentId}`, at: d.at, speaker: "document",
    ctx: prefix(c, d.at, `document "${d.title}"`, `${ch.section} (part ${i + 1} of ${chunks.length})`), body: ch.text,
  }));
}

export function rowsForEntry(c: RowContext, e: TranscriptEntry, docText?: string | null): ArchiveRow[] {
  if (e.kind === "tool-call" && e.status === "running") return [];
  const body = textOf(e);
  if (!body?.trim()) return [];
  const at = e.kind === "tool-call" ? e.endedAt ?? e.startedAt : e.createdAt;
  const speaker = speakerOf(e);
  const row: ArchiveRow = { src: `e:${e.id}`, stream: "chat", at, speaker, ctx: prefix(c, at, speaker), body };
  if (e.kind !== "user-attachment" || !docText?.trim()) return [row];
  return [row, ...rowsForDocument(c, { attachmentId: e.attachmentId, title: e.name, text: docText, at })];
}

export function rowsForSummary(c: RowContext, s: { text: string; at: number; key: string }): ArchiveRow[] {
  if (!s.text.trim()) return [];
  const hash = createHash("sha256").update(s.text).digest("hex").slice(0, 16);
  return [{ src: `s:${hash}`, stream: "summary", at: s.at, speaker: "summary", ctx: prefix(c, s.at, "conversation summary (what was compacted away)"), body: s.text }];
}

/** Every compaction summary in a session file (JSONL), with its timestamp. */
export function summariesIn(jsonl: string): { text: string; at: number; key: string }[] {
  const out: { text: string; at: number; key: string }[] = [];
  for (const l of jsonl.split("\n")) {
    if (!l.includes("isCompactSummary")) continue;
    try {
      const r = JSON.parse(l) as { isCompactSummary?: boolean; uuid?: string; timestamp?: string; message?: { content?: unknown } };
      if (r.isCompactSummary !== true) continue;
      const c = r.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";
      const at = Date.parse(r.timestamp ?? "");
      if (text.trim()) out.push({ text, at: Number.isFinite(at) ? at : 0, key: r.uuid ?? "" });
    } catch { /* a torn line */ }
  }
  return out;
}

function readTextAttachment(e: UserAttachmentEntry): string | null {
  if (!TEXT_MIME.test(e.mime) || e.size > DOC_MAX_BYTES) return null;
  try {
    const buf = fs.readFileSync(e.storePath);
    return buf.length > DOC_MAX_BYTES || buf.includes(0) ? null : buf.toString("utf8");
  } catch { return null; }
}

export interface IndexerDeps {
  archive: HistoryArchive;
  hub?: SseHub;
  nameOf(botId: string): string;
  timeZone(): string;
  botIds(): string[];
  exists(botId: string): boolean;
  /** Every stored entry of a Bot, oldest first (the backfill source). */
  entries(botId: string): TranscriptEntry[];
  /** The Bot's current and rolled-over session files. */
  sessionFiles(botId: string): string[];
  readSession(file: string): string;
  readText?(e: UserAttachmentEntry): string | null;
  /** Rows per backfill batch, and the pause between batches (the throttle). */
  batch?: number; pauseMs?: number;
  /** How long to wait before retrying while the redactor is not ready. */
  retryMs?: number;
}

type Job = { botId: string; live: boolean; run(): void };

export class HistoryIndexer {
  private live: Job[] = [];
  private back: Job[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle: (() => void)[] = [];
  private stopped = false;
  private unsub: (() => void) | null = null;

  constructor(private d: IndexerDeps) {}

  private ctx(botId: string): RowContext { return { botName: this.d.nameOf(botId), timeZone: this.d.timeZone() }; }

  start(): void {
    if (!this.d.hub || this.unsub) return;
    this.unsub = this.d.hub.subscribe((ev) => {
      if (ev.channel === "agents") { this.forget(ev.payload.removedId); return; }
      if (ev.channel !== "transcript" || ev.payload.op === "typing") return;
      const { botId, entry } = ev.payload;
      this.push({ botId, live: true, run: () => this.putEntry(botId, entry) });
    });
  }

  enqueueEntry(botId: string, e: TranscriptEntry): void { this.push({ botId, live: true, run: () => this.putEntry(botId, e) }); }

  /** A compaction finished: index the summaries its session files now hold. */
  compacted(botId: string): void { this.push({ botId, live: true, run: () => this.putSummaries(botId) }); }

  /** Host start: index whatever is not indexed yet, a batch at a time, resuming from each Bot's cursor. */
  backfill(): void {
    for (const botId of this.d.botIds()) {
      this.push({ botId, live: false, run: () => this.backfillStep(botId) });
    }
  }

  /** Resolves once the queue is empty (tests and shutdown). */
  drain(): Promise<void> {
    if (!this.live.length && !this.back.length && !this.timer) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  stop(): void {
    this.stopped = true;
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.live = [];
    this.back = [];
    for (const r of this.idle.splice(0)) r();
  }

  private forget(botId: string): void {
    this.live = this.live.filter((j) => j.botId !== botId);
    this.back = this.back.filter((j) => j.botId !== botId);
    try { this.d.archive.removeBot(botId); } catch (e) { log.warn("history archive purge failed", { botId, error: String(e) }); }
  }

  private push(j: Job): void {
    if (this.stopped) return;
    (j.live ? this.live : this.back).push(j);
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, ms);
    this.timer.unref?.();
  }

  private tick(): void {
    const started = performance.now();
    // Live work first, a few milliseconds at a time; then one backfill step, then a pause.
    while (this.live.length && performance.now() - started < 8) {
      const j = this.live[0]!;
      if (!this.runJob(j)) return this.schedule(this.d.retryMs ?? 1000);
      this.live.shift();
    }
    if (this.live.length) return this.schedule(0);
    const b = this.back[0];
    if (b) {
      if (!this.runJob(b)) return this.schedule(this.d.retryMs ?? 1000);
      this.back.shift();
      return this.schedule(this.back.length ? this.d.pauseMs ?? 25 : 0);
    }
    for (const r of this.idle.splice(0)) r();
  }

  /** false = the redactor is not ready: keep the job and retry later. */
  private runJob(j: Job): boolean {
    if (!this.d.exists(j.botId)) return true;
    try {
      j.run();
      return true;
    } catch (e) {
      if (e instanceof ArchiveNotReady) return false;
      log.warn("history archive index failed", { botId: j.botId, error: String(e) });
      return true;
    }
  }

  private putEntry(botId: string, e: TranscriptEntry): void {
    const doc = e.kind === "user-attachment" ? (this.d.readText ?? readTextAttachment)(e) : null;
    this.d.archive.put(botId, rowsForEntry(this.ctx(botId), e, doc));
  }

  private putSummaries(botId: string): void {
    for (const f of this.d.sessionFiles(botId)) {
      const key = `bf:session:${path.basename(f)}`;
      let text: string;
      try { text = this.d.readSession(f); } catch { continue; }
      if (this.d.archive.getMeta(botId, key) === String(text.length)) continue;
      const c = this.ctx(botId);
      this.d.archive.put(botId, summariesIn(text).flatMap((s) => rowsForSummary(c, s)));
      this.d.archive.setMeta(botId, key, String(text.length));
    }
  }

  /** `list` is read once per backfill run, not once per batch. */
  private backfillStep(botId: string, list?: TranscriptEntry[]): void {
    const all = list ?? this.d.entries(botId);
    let from = Number(this.d.archive.getMeta(botId, "bf:entries") ?? 0);
    if (!(from >= 0 && from <= all.length)) from = 0;
    if (from >= all.length) { this.putSummaries(botId); return; }
    const batch = all.slice(from, from + (this.d.batch ?? 200));
    const c = this.ctx(botId);
    const rows = batch.flatMap((e) => rowsForEntry(c, e, e.kind === "user-attachment" ? (this.d.readText ?? readTextAttachment)(e) : null));
    this.d.archive.put(botId, rows);
    this.d.archive.setMeta(botId, "bf:entries", String(from + batch.length));
    // Not done: queue the next step behind any live work (the throttle is the pause between steps).
    this.back.push({ botId, live: false, run: () => this.backfillStep(botId, all) });
  }
}
