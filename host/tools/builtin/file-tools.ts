import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../../brain/types";
import type { BotFileRunner } from "../../walls/bot-file";

/**
 * Read, Write and Edit for a Bot on a model provider (spec 2026-09-29 §3), in the Claude Code CLI's own shapes and
 * rules, so the gate classifies them exactly as it classifies the CLI's (review/classify.ts: Read, Edit/Write). Every
 * request goes through the Bot's BotFileRunner: the bot-file root helper as the Bot's own uid, or the same-uid
 * fallback behind the same path walls.
 *
 * The CLI's "read before you write" rule: an existing file is written or edited only when the Bot read (or wrote) it
 * in this host session and it hasn't changed since (the runner compares the sha256 it last saw).
 */
export interface FileToolsDeps { botId: string; files: BotFileRunner; seen: Map<string, string> }

const err = (text: string): BotToolResult => ({ text: `<tool_use_error>${text}</tool_use_error>`, isError: true });
/** The CLI's own Read cap (25,000 tokens), in characters at ~4 a token: past it the model is asked to read in parts. */
export const READ_MAX_CHARS = 100_000;

/** Per-Bot memory of what each Bot last saw of each file (path -> sha256). */
const seenByBot = new Map<string, Map<string, string>>();
export function seenFor(botId: string): Map<string, string> {
  let m = seenByBot.get(botId);
  if (!m) { m = new Map(); seenByBot.set(botId, m); }
  return m;
}

export function createFileTools(d: FileToolsDeps): BotToolDef[] {
  return [
    {
      name: "Read",
      description: "Reads a file from your computer. file_path must be absolute. By default up to 2000 lines from the start; pass offset and limit for more. Lines come numbered. PNG, JPEG and WebP images come back as images.",
      readOnly: true,
      schema: { file_path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() },
      handler: async (a) => {
        const p = String(a.file_path);
        const r = await d.files(d.botId, { op: "read", path: p, ...(a.offset ? { offset: Number(a.offset) } : {}), ...(a.limit ? { limit: Number(a.limit) } : {}) });
        if (!r.ok) return err(r.error);
        if ("kind" in r && r.kind === "image") {
          d.seen.set(p, r.sha);
          return { text: `Image ${p}`, images: [{ data: r.data, mimeType: r.mime }] };
        }
        if (!("kind" in r) || r.kind !== "text") return err("Unexpected answer.");
        if (r.text.length > READ_MAX_CHARS) return err(`This part of the file is ${r.text.length} characters (about ${Math.ceil(r.text.length / 4)} tokens), over the ${READ_MAX_CHARS / 4} token limit. Read it in parts with offset and limit, or Grep for what you need.`);
        d.seen.set(p, r.sha);
        if (r.total === 0) return { text: "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>" };
        return { text: r.cut ? `${r.text}\n\n(The file has ${r.total} lines; this shows ${r.lines}. Use offset and limit to read the rest.)` : r.text };
      },
    },
    {
      name: "Write",
      description: "Writes a file on your computer, replacing it if it exists. file_path must be absolute. An existing file must be read first. Prefer Edit for changes to an existing file.",
      readOnly: false,
      schema: { file_path: z.string(), content: z.string() },
      handler: async (a) => {
        const p = String(a.file_path);
        const r = await d.files(d.botId, { op: "write", path: p, content: String(a.content), expect: d.seen.get(p) ?? null });
        if (!r.ok) return err(r.error);
        if (!("sha" in r)) return err("Unexpected answer.");
        d.seen.set(p, r.sha);
        return { text: "created" in r && r.created ? `File created successfully at: ${p}` : `The file ${p} has been updated.` };
      },
    },
    {
      name: "Edit",
      description: "Replaces exact text in a file on your computer. file_path must be absolute; read the file first. old_string must appear exactly once unless replace_all is set.",
      readOnly: false,
      schema: { file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
      handler: async (a) => {
        const p = String(a.file_path);
        const r = await d.files(d.botId, { op: "edit", path: p, old: String(a.old_string), new: String(a.new_string), all: a.replace_all === true, expect: d.seen.get(p) ?? null });
        if (!r.ok) return err(r.error);
        if (!("sha" in r)) return err("Unexpected answer.");
        d.seen.set(p, r.sha);
        const n = "count" in r ? r.count ?? 1 : 1;
        return { text: `The file ${p} has been updated.${n > 1 ? ` ${n} replacements.` : ""}` };
      },
    },
  ];
}
