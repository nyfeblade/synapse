import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanonMessage, CanonPart, CanonToolCall } from "./adapters/types";
import type { ToolImage } from "../types";

/**
 * ProviderSessionStore (spec §7): a provider Bot's conversation, as canonical messages, in
 * `hostPrivate/provider-sessions/<botId>/prov-<uuid>.jsonl` (owned by bothost; a Bot can't edit its own history).
 *
 * Records use the Claude Code JSONL shape (user / assistant / tool_result content blocks with the canonical tool
 * names, a compact_boundary system record) so the history indexer, SearchHistory and rollover read them unchanged.
 * Two extra fields carry what only the provider path needs: `providerMeta` (opaque, echoed back to the provider, e.g.
 * Gemini thought signatures) and `rawArguments` (the model's exact argument string, so a re-sent history is
 * byte-identical for prompt caching).
 */
export const PROVIDER_SESSION_PREFIX = "prov-";
export const PROVIDER_SESSIONS_DIR = "provider-sessions";

export function isProviderSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith(PROVIDER_SESSION_PREFIX);
}
export function newProviderSessionId(): string {
  return `${PROVIDER_SESSION_PREFIX}${randomUUID()}`;
}
export function providerSessionFile(hostPrivate: string, botId: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId) || !/^prov-[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("bad provider session path");
  return path.join(hostPrivate, PROVIDER_SESSIONS_DIR, botId, `${sessionId}.jsonl`);
}
export function isProviderSessionPath(hostPrivate: string, p: string): boolean {
  const root = path.join(hostPrivate, PROVIDER_SESSIONS_DIR) + path.sep;
  return path.resolve(p).startsWith(root);
}

type Block = Record<string, unknown>;
interface BaseRecord { uuid: string; parentUuid: string | null; sessionId: string; timestamp: string; isSidechain: false }
type Rec = BaseRecord & Record<string, unknown>;

function partToBlock(p: CanonPart): Block {
  return p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } };
}

function parseInput(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Canonical message → Claude JSONL record body (without the base fields). */
export function toRecord(m: CanonMessage, extra: { model?: string; usage?: Record<string, number> } = {}): Record<string, unknown> {
  if (m.role === "user") return { type: "user", message: { role: "user", content: m.parts.map(partToBlock) } };
  if (m.role === "assistant") {
    const content: Block[] = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: parseInput(c.arguments) });
    const calls: Record<string, { rawArguments: string; providerMeta?: unknown }> = {};
    for (const c of m.toolCalls) calls[c.id] = { rawArguments: c.arguments, ...(c.providerMeta !== undefined ? { providerMeta: c.providerMeta } : {}) };
    return {
      type: "assistant",
      message: { role: "assistant", type: "message", model: extra.model ?? null, content, ...(extra.usage ? { usage: extra.usage } : {}) },
      provider: { calls, ...(m.providerMeta !== undefined ? { providerMeta: m.providerMeta } : {}) },
    };
  }
  const content: Block[] = [{ type: "text", text: m.text }, ...(m.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))];
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content, is_error: m.isError }] }, provider: { toolName: m.name } };
}

/** Claude JSONL records (after the last compact boundary) → canonical messages. Unknown records are skipped. */
export function fromRecords(records: Record<string, unknown>[]): CanonMessage[] {
  let start = 0;
  records.forEach((r, i) => { if (r.type === "system" && r.subtype === "compact_boundary") start = i + 1; });
  const out: CanonMessage[] = [];
  const names = new Map<string, string>();
  for (const r of records.slice(start)) {
    const msg = r.message as { role?: string; content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as Block[]) : typeof msg?.content === "string" ? [{ type: "text", text: msg.content }] : [];
    const prov = (r.provider ?? {}) as { calls?: Record<string, { rawArguments?: string; providerMeta?: unknown }>; providerMeta?: unknown; toolName?: string };
    if (r.type === "assistant") {
      const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");
      const toolCalls: CanonToolCall[] = content.filter((b) => b.type === "tool_use").map((b) => {
        const id = String(b.id);
        const c = prov.calls?.[id];
        names.set(id, String(b.name));
        return { id, name: String(b.name), arguments: c?.rawArguments ?? JSON.stringify(b.input ?? {}), ...(c?.providerMeta !== undefined ? { providerMeta: c.providerMeta } : {}) };
      });
      out.push({ role: "assistant", text, toolCalls, ...(prov.providerMeta !== undefined ? { providerMeta: prov.providerMeta } : {}) });
    } else if (r.type === "user") {
      const results = content.filter((b) => b.type === "tool_result");
      if (results.length) {
        for (const b of results) {
          const inner = Array.isArray(b.content) ? (b.content as Block[]) : [{ type: "text", text: String(b.content ?? "") }];
          const images: ToolImage[] = inner.filter((x) => x.type === "image").map((x) => {
            const s = x.source as { media_type: ToolImage["mimeType"]; data: string };
            return { mimeType: s.media_type, data: s.data };
          });
          const id = String(b.tool_use_id);
          out.push({
            role: "tool", toolCallId: id, name: prov.toolName ?? names.get(id) ?? "", isError: b.is_error === true,
            text: inner.filter((x) => x.type === "text").map((x) => String(x.text ?? "")).join("\n"), ...(images.length ? { images } : {}),
          });
        }
      } else {
        const parts: CanonPart[] = content.flatMap((b): CanonPart[] => {
          if (b.type === "text") return [{ type: "text", text: String(b.text ?? "") }];
          if (b.type === "image") { const s = b.source as { media_type: string; data: string }; return [{ type: "image", mediaType: s.media_type, dataBase64: s.data }]; }
          return [];
        });
        if (parts.length) out.push({ role: "user", parts });
      }
    }
  }
  return out;
}

export class ProviderSessionStore {
  private last = new Map<string, string | null>();
  private versions = new Map<string, number>();
  /** Bumps on every compact boundary: a brain holding a cached history reloads it. */
  version(sessionId: string): number { return this.versions.get(sessionId) ?? 0; }
  constructor(private hostPrivate: string, private now: () => number = Date.now) {}

  file(botId: string, sessionId: string): string {
    return providerSessionFile(this.hostPrivate, botId, sessionId);
  }

  /** The conversation since its last compact boundary. A missing file is an empty conversation. */
  load(botId: string, sessionId: string): CanonMessage[] {
    let text: string;
    try { text = fs.readFileSync(this.file(botId, sessionId), "utf8"); } catch { return []; }
    const records: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { /* a torn last line from a crash */ }
    }
    const lastUuid = [...records].reverse().find((r) => typeof r.uuid === "string")?.uuid;
    this.last.set(sessionId, typeof lastUuid === "string" ? lastUuid : null);
    return fromRecords(records);
  }

  append(botId: string, sessionId: string, msgs: CanonMessage[], extra: { model?: string; usage?: Record<string, number> } = {}): void {
    if (!msgs.length) return;
    const f = this.file(botId, sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    let parent = this.last.get(sessionId) ?? null;
    const lines: string[] = [];
    for (const m of msgs) {
      const uuid = randomUUID();
      const rec: Rec = { uuid, parentUuid: parent, sessionId, timestamp: new Date(this.now()).toISOString(), isSidechain: false, ...toRecord(m, m.role === "assistant" ? extra : {}) };
      lines.push(JSON.stringify(rec));
      parent = uuid;
    }
    fs.appendFileSync(f, `${lines.join("\n")}\n`, { mode: 0o600 });
    this.last.set(sessionId, parent);
  }

  /** A compaction boundary: everything before it is no longer sent (spec §7, compaction). */
  appendBoundary(botId: string, sessionId: string): void {
    const f = this.file(botId, sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const uuid = randomUUID();
    fs.appendFileSync(f, `${JSON.stringify({ type: "system", subtype: "compact_boundary", uuid, parentUuid: this.last.get(sessionId) ?? null, sessionId, timestamp: new Date(this.now()).toISOString(), isSidechain: false })}\n`, { mode: 0o600 });
    this.last.set(sessionId, uuid);
    this.versions.set(sessionId, this.version(sessionId) + 1);
  }
}
