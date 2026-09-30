import type { Usage } from "../coding/types";

export type Mode = "screenshots" | "live";
export const MODES: Mode[] = ["screenshots", "live"];

export interface TranscriptMetrics {
  usage: Usage;
  /** Distinct assistant message ids = model calls. */
  calls: number;
  /** Images returned to the model inside tool results (screenshots, crops). */
  images: number;
  /** Tool name -> calls. */
  tools: Record<string, number>;
}

/**
 * Reads one child session transcript (.jsonl): a Claude Code session, or a provider child's session (the same record
 * shape, host/brain/provider/session-store.ts). The CLI writes one line per content block, so an assistant message's
 * usage repeats on each of its lines: count it once per message id. A provider record has no message id: one record is
 * one model call, keyed by its record uuid.
 */
export function transcriptMetrics(jsonl: string): TranscriptMetrics {
  const usage: Usage = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const seen = new Set<string>();
  const tools: Record<string, number> = {};
  let images = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const msg = ev?.message;
    if (!msg) continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    if (ev.type === "assistant") {
      for (const b of content) if (b?.type === "tool_use" && b.name) tools[b.name] = (tools[b.name] ?? 0) + 1;
      const id = String(msg.id ?? ev.uuid ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const u = msg.usage ?? {};
      usage.fresh += u.input_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
    } else if (ev.type === "user") {
      for (const b of content) {
        if (b?.type === "image") images += 1;
        if (b?.type === "tool_result" && Array.isArray(b.content)) images += b.content.filter((c: any) => c?.type === "image").length;
      }
    }
  }
  return { usage, calls: seen.size, images, tools };
}

export const tokensOf = (u: Usage) => u.fresh + u.cacheRead + u.cacheWrite + u.output;
