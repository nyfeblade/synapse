import { z } from "zod";
import type { BotToolDef } from "../types";
import type { RegisteredTool } from "./tool-registry";

/**
 * ToolSearch on Synapse's own loop (0.1.8, the coding token gap): the CLI's own tool name and shape, so the gate
 * classifies it as the CLI's (review/classify.ts: read-only, no card) and the loop guard treats it as a read.
 *
 * A Bot's rarely used tools (most Bot tools, every connector's, WebFetch/WebSearch/TodoWrite) are deferred: the model
 * sees their NAMES in this tool's description, and loads a schema the turn it needs one. What "loaded" means depends on
 * the provider, and neither way changes the request prefix:
 *  - Claude: every tool is sent, the deferred ones with `defer_loading: true` (outside the prompt and its cache prefix);
 *    this tool's result carries `tool_reference` blocks the API expands in place (the tool search docs' custom search).
 *  - Chat Completions: the loaded tools are appended to `tools` from the next call on, after every up-front tool, in
 *    the order they were loaded (ToolRegistry.loadedWireTools). One prefix change per load, then stable again.
 * The loaded set is read from the conversation itself (each result's `toolRefs`), so it survives a restart and a
 * compaction resets it the way the CLI's does.
 */
export const TOOL_SEARCH = "ToolSearch";
const DEFAULT_RESULTS = 5;

export function toolSearchDescription(names: string[]): string {
  return `Loads deferred tools. Not loaded yet (names only): ${names.join(", ")}. Load one here before you call it: query "select:A,B" loads those by name; other words search names and descriptions (max_results, default ${DEFAULT_RESULTS}). A loaded tool stays loaded.`;
}

/** Finds deferred tools: "select:A,B" by name (wire or canonical, any case), else by words in names and descriptions. */
export function searchDeferred(tools: RegisteredTool[], query: string, max = DEFAULT_RESULTS): RegisteredTool[] {
  const q = query.trim();
  const sel = /^select:(.*)$/i.exec(q);
  if (sel) {
    const want = sel[1]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return want.flatMap((w) => tools.filter((t) => t.wireName.toLowerCase() === w || t.canonical.toLowerCase() === w)).slice(0, Math.max(max, want.length));
  }
  const words = q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 2);
  if (!words.length) return [];
  const scored = tools.map((t) => {
    const name = t.wireName.toLowerCase();
    const desc = t.description.toLowerCase();
    const score = words.reduce((a, w) => a + (name === w ? 10 : name.includes(w) ? 3 : 0) + (desc.includes(w) ? 1 : 0), 0);
    return { t, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.t);
}

/** The ToolSearch tool over this turn's deferred tools (the registry is read when the model calls it). */
export function createToolSearchTool(deferred: () => RegisteredTool[], names: string[]): BotToolDef {
  return {
    name: TOOL_SEARCH,
    description: toolSearchDescription(names),
    readOnly: true,
    schema: { query: z.string(), max_results: z.number().int().min(1).optional() },
    handler: async (a) => {
      const found = searchDeferred(deferred(), String(a.query ?? ""), typeof a.max_results === "number" ? a.max_results : DEFAULT_RESULTS);
      if (!found.length) return { text: `No deferred tool matches "${String(a.query ?? "")}". Not loaded yet: ${names.join(", ")}.` };
      return { text: `Loaded: ${found.map((t) => t.wireName).join(", ")}. Call them like any other tool.`, toolRefs: found.map((t) => t.canonical) };
    },
  };
}
