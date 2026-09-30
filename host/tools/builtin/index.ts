import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BotToolDef } from "../../brain/types";
import type { SkillLibrary } from "../../skills/library";
import type { BotFileRunner } from "../../walls/bot-file";
import { createFileTools, seenFor } from "./file-tools";
import { createSearchTools } from "./search-tools";
import { createSkillTool, createTodoWriteTool } from "./todo-skill";
import { createWebFetchTool } from "./web-fetch";
import { createWebSearchTool } from "./web-search";
import type { ProviderId } from "@synapse/shared";

/**
 * The built-in tools of a Bot on a model provider (spec §3), under the Claude CLI's own canonical names, so the gate,
 * the classifier, discipline (outside content) and presence treat them exactly as the CLI's. WebSearch is P1b (§7a).
 */
export const BUILTIN_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Skill"] as const;

export function builtinTools(o: {
  botId: string; files: BotFileRunner; library: SkillLibrary | null; plugins(): string[]; fetch?: FetchLike;
  /** WebSearch (§7a): the Bot's model and which providers are set up; absent = no WebSearch. */
  search?: { botRef(): string; usable(p: ProviderId): boolean };
  /** Where Glob and Grep look when no path is given (absolute); default /workspace. */
  cwd?(): string;
}): { canonical: string; def: BotToolDef }[] {
  const web = o.search ? createWebSearchTool({ botId: o.botId, ...o.search }) : null;
  const defs = [
    ...createFileTools({ botId: o.botId, files: o.files, seen: seenFor(o.botId) }),
    ...createSearchTools({ botId: o.botId, files: o.files, cwd: o.cwd ?? (() => "/workspace") }),
    createWebFetchTool(o.fetch ? { fetch: o.fetch } : {}),
    ...(web ? [web] : []),
    createTodoWriteTool(),
    createSkillTool({ botId: o.botId, library: o.library, plugins: o.plugins }),
  ];
  return defs.map((def) => ({ canonical: def.name, def }));
}
