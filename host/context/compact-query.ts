import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { meteredQuery, type QueryFn } from "../usage/metered-query";

/** The Bot's own spawn options (same cwd → same session folder, same env and executable), narrowed to a tool-less /compact run. */
export function compactQueryOptions(base: Options, sessionId: string): Options {
  return {
    ...base, resume: sessionId, persistSession: true, tools: [], mcpServers: {}, hooks: {},
    canUseTool: async () => ({ behavior: "deny", message: "No tools during compaction." }),
    includePartialMessages: false, sessionId: undefined,
  };
}

export async function runCompactQuery(d: { options: Options; instructions: string; signal: AbortSignal; queryFn?: QueryFn; botId?: string | null }): Promise<boolean> {
  const ac = new AbortController();
  d.signal.addEventListener("abort", () => ac.abort(), { once: true });
  let boundary = false;
  const q = meteredQuery({ purpose: "compaction", botId: d.botId ?? null }, { prompt: `/compact ${d.instructions}`, options: { ...d.options, abortController: ac } }, d.queryFn);
  try {
    for await (const m of q) {
      const r = m as { type: string; subtype?: string };
      if (r.type === "system" && r.subtype === "compact_boundary") boundary = true;
      if (r.type === "result") break;
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  }
  return boundary && !ac.signal.aborted;
}
