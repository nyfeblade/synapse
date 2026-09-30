import path from "node:path";
import { z } from "zod";
import type { BotToolDef, BotToolResult } from "../../brain/types";
import type { BotFileRunner, GrepMode } from "../../walls/bot-file";

/**
 * Glob and Grep for a Bot on a model provider and for a provider-loop coding agent, in the Claude Code CLI's shapes, so
 * the gate classifies them as it classifies the CLI's (review/classify.ts: Read, Glob, Grep). They are walled exactly
 * like Read: every search goes through the Bot's BotFileRunner (the bot-file root helper as the Bot's own uid, or the
 * same-uid fallback behind the same path walls), which walks the folder without following links into other folders
 * and drops anything whose real path is another Bot's or the host's.
 */
export interface SearchToolsDeps {
  botId: string;
  files: BotFileRunner;
  /** The folder a search without `path` looks in, and what a relative `path` is relative to (absolute). */
  cwd(): string;
}

const err = (text: string): BotToolResult => ({ text: `<tool_use_error>${text}</tool_use_error>`, isError: true });
const TRUNCATED = "(Results are truncated. Consider a more specific path or pattern.)";

export function createSearchTools(d: SearchToolsDeps): BotToolDef[] {
  const where = (p: unknown) => {
    const base = d.cwd();
    return typeof p === "string" && p.trim() ? path.resolve(base, p.trim()) : base;
  };
  return [
    {
      name: "Glob",
      description: "Finds files by name with a glob pattern, like \"**/*.ts\" or \"src/**/*.test.ts\". path is the folder to search (default: the current folder). Returns matching file paths, newest first.",
      readOnly: true,
      schema: { pattern: z.string(), path: z.string().optional() },
      handler: async (a) => {
        const r = await d.files(d.botId, { op: "glob", path: where(a.path), pattern: String(a.pattern) });
        if (!r.ok) return err(r.error);
        if (!("kind" in r) || r.kind !== "paths") return err("Unexpected answer.");
        if (!r.paths.length) return { text: "No files found" };
        return { text: `${r.paths.join("\n")}${r.cut ? `\n${TRUNCATED}` : ""}` };
      },
    },
    {
      name: "Grep",
      description: "Searches file contents with a regular expression. path is a file or folder (default: the current folder); glob filters files (\"*.ts\", \"src/**/*.tsx\"). output_mode: files_with_matches (default, paths newest first), content (matching lines as path:line:text, with -C lines of context), or count. -i ignores case. head_limit caps the lines returned.",
      readOnly: true,
      schema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        "-i": z.boolean().optional(),
        "-C": z.number().int().min(0).optional(),
        "-n": z.boolean().optional(),
        head_limit: z.number().int().min(1).optional(),
      },
      handler: async (a) => {
        const mode: GrepMode = a.output_mode === "content" ? "content" : a.output_mode === "count" ? "count" : "files";
        const r = await d.files(d.botId, {
          op: "grep", path: where(a.path), pattern: String(a.pattern), mode,
          ...(typeof a.glob === "string" && a.glob ? { glob: a.glob } : {}),
          ...(a["-i"] === true ? { ignoreCase: true } : {}),
          ...(typeof a["-C"] === "number" ? { context: a["-C"] } : {}),
          ...(typeof a.head_limit === "number" ? { limit: a.head_limit } : {}),
        });
        if (!r.ok) return err(r.error);
        if (!("kind" in r) || r.kind !== "grep") return err("Unexpected answer.");
        if (!r.matches) return { text: "No matches found" };
        const more = r.cut ? `\n${TRUNCATED}` : "";
        if (mode === "files") return { text: `Found ${r.files} file${r.files === 1 ? "" : "s"}\n${r.text}${more}` };
        if (mode === "count") return { text: `${r.text}\n\nFound ${r.matches} total occurrence${r.matches === 1 ? "" : "s"} across ${r.files} file${r.files === 1 ? "" : "s"}.${more}` };
        return { text: `${r.text}${more}` };
      },
    },
  ];
}
