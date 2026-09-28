import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "@synapse/shared";
import type { SseHub } from "../gateway/sse-hub";
import { log } from "../util/log";

export const mirrorPath = (dataRoot: string, botId: string) => path.join(dataRoot, "agent-transcripts", botId, `${botId}.jsonl`);

const ts = (ms: number) => new Date(ms).toISOString();
const text = (role: "user" | "assistant", uuid: string, at: number, t: string) => ({ type: role, uuid, timestamp: ts(at), message: { role, content: [{ type: "text", text: t }] } });

/** A Claude-style record for the entries a later reader (the Bot grepping its history) needs. Thinking is never stored. */
export function mirrorRecord(e: TranscriptEntry): Record<string, unknown> | null {
  switch (e.kind) {
    case "message": return text("user", e.id, e.createdAt, e.content);
    case "user-attachment": return text("user", e.id, e.createdAt, `[attached ${e.name} (${e.mime}) at ${e.boxPath ?? e.storePath}]`);
    case "send-message": {
      const m = e.message;
      const body = m.type === "text" ? m.content
        : m.type === "attachment" ? `[sent file ${m.name}: ${m.url}]`
        : m.type === "widget" ? `[asked: ${m.widget.question} — options: ${m.widget.options.map((o) => o.label).join(" / ")}]`
        : m.type === "card" ? `[sent ${m.card.kind} card]`
        : m.type === "box-help" ? `[asked the user for help on the computer: ${m.request.instruction}]`
        : m.type === "secret-request" ? `[asked the user for the secret “${m.secret.label}”]`
        : `[approval card: ${m.approval.summary}]`;
      return text("assistant", e.id, e.createdAt, body);
    }
    case "tool-call":
      if (e.status === "running") return null;
      return { type: "assistant", uuid: e.id, timestamp: ts(e.endedAt ?? e.startedAt), message: { role: "assistant", content: [{ type: "tool_use", name: e.name, input: { step: e.step }, status: e.status }] } };
    case "event": return { type: "system", uuid: e.id, timestamp: ts(e.createdAt), event: e.event };
    case "notice": return { type: "system", uuid: e.id, timestamp: ts(e.createdAt), text: e.text };
  }
}

/** I5: d.redact is the secret scanner's redact, applied to each JSON line (JSON-escaped forms included). */
export function startTranscriptMirror(d: { hub: SseHub; dataRoot: string; redact?(botId: string, text: string): string }): () => void {
  return d.hub.subscribe((ev) => {
    try {
      if (ev.channel === "agents") {
        fs.rmSync(path.dirname(mirrorPath(d.dataRoot, ev.payload.removedId)), { recursive: true, force: true });
        return;
      }
      if (ev.channel !== "transcript" || ev.payload.op === "typing") return;
      const e = ev.payload.entry;
      if (ev.payload.op === "update" && e.kind !== "tool-call") return; // only finished tool calls are written on update
      const rec = mirrorRecord(e);
      if (!rec) return;
      const f = mirrorPath(d.dataRoot, ev.payload.botId);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const line = JSON.stringify(rec);
      fs.appendFileSync(f, `${d.redact ? d.redact(ev.payload.botId, line) : line}\n`, { mode: 0o640 });
    } catch (e) {
      log.warn("transcript mirror write failed", { error: String(e) });
    }
  });
}
