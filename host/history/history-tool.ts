import { z } from "zod";
import { toolError, type BotToolExtensions } from "../tools/registry";
import { searchMemory } from "../memory/memory-search";
import type { MemoryStore } from "../memory/memory-store";
import type { ArchiveHit, HistoryArchive } from "./archive";

/** Bug #61: remembered facts shown ahead of the archive hits, at most this many. */
const MEMORY_HITS = 5;

/** "[#ref] <date> · <speaker or document>: <original wording>". The Bot name is dropped: it is the Bot's own. */
export function formatHits(hits: ArchiveHit[]): string {
  return hits.map((h) => `[#${h.ref}] ${h.ctx.split(" · ").slice(1).join(" · ")}: ${h.text}`).join("\n");
}

const DAY = 86_400_000;
function parseDay(v: unknown, end: boolean): number | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(v).trim());
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
  if (!end) return start;
  return m[3] ? start + DAY : Date.UTC(Number(m[1]), Number(m[2]), 1);
}

/**
 * SearchHistory: the Bot's own archive (host/history/archive.ts). The bot id is the one this tool
 * was built for, never an argument, so a Bot can only ever read its own rows. Retrieval only:
 * nothing from the archive is put into a prompt unless the Bot asks for it here.
 */
export function createHistoryToolExtension(d: { archive: HistoryArchive; memory?: MemoryStore }): BotToolExtensions {
  return {
    extraTools: (botId) => [{
      name: "SearchHistory",
      description: "Search your whole history with the user and your memory, including what was summarised away and attached text files. Returns dated quotes; around=\"#id\" shows what surrounds one.",
      readOnly: true,
      schema: { query: z.string().optional(), around: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.number().optional() },
      handler: async (a) => {
        if (a.around !== undefined && String(a.around).trim()) {
          const ref = Number(String(a.around).replace(/^#/, ""));
          if (!Number.isInteger(ref)) return toolError('around takes a hit id like "#123".');
          const rows = d.archive.around(botId, ref, 3);
          return { text: rows.length ? formatHits(rows) : `No message #${ref} in your history.` };
        }
        const query = String(a.query ?? "").trim();
        if (!query) return toolError("Give a query (or around=\"#id\" from an earlier result).");
        const from = parseDay(a.from, false), to = parseDay(a.to, true);
        if (from === null || to === null) return toolError("from and to are dates like 2024-06-01 (or 2024-06).");
        const hits = d.archive.search(botId, { query, from, to, limit: typeof a.limit === "number" ? a.limit : undefined });
        // Bug #61: the Bot's own memory files are host-private now, so facts its memory section didn't show come from here.
        const mem = d.memory && from === undefined && to === undefined ? searchMemory(d.memory, botId, query) : [];
        const memText = mem.length ? `Remembered (${mem.length}${mem.length > MEMORY_HITS ? `, newest ${MEMORY_HITS}` : ""}):\n${mem.slice(0, MEMORY_HITS).map(({ f, where }) => `- (${f.date}, ${where}) ${f.content}`).join("\n")}\n` : "";
        if (!hits.length && memText) return { text: memText.trimEnd() };
        if (!hits.length) return { text: `No matches in your history for "${query}". It may not have been said here; try other words or a wider date range.` };
        hits.sort((x, y) => x.at - y.at || x.ref - y.ref);
        return { text: `${memText}${hits.length} matches, oldest first:\n${formatHits(hits)}` };
      },
    }],
  };
}
