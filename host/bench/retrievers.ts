import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SendMessageEntry, TranscriptEntry, UserMessageEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { loadConfig } from "../config";
import { buildRestoreBlock } from "../context/restore";
import { LOG_HEADER, PROFILE_HEADER, factId, monthOf, renderLine } from "../memory/facts";
import { MemoryStore } from "../memory/memory-store";
import { renderMemorySection } from "../memory/render";
import type { Archive } from "./corpus";
import type { Passage, Retriever } from "./scorer";

const BOX_DATA_ROOT = "/home/box/agent-data";

/**
 * The memory files as MemoryStore lays them out (profile.md, log/YYYY-MM.md, one "- (date) fact"
 * line each), rendered by the real renderMemorySection with the real LIMITS budgets.
 */
export function renderBaselineMemory(c: Archive): Passage {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-mem-"));
  try {
    const cfg = loadConfig({ BOX_HOME: tmp });
    const store = new MemoryStore({ cfg, now: () => Date.parse(`${c.asOf}T12:00:00Z`) });
    const dir = store.dir({ kind: "agent", botId: c.botId });
    fs.mkdirSync(path.join(dir, "log"), { recursive: true });
    const profile = c.memoryFacts.filter((f) => f.tier === "profile");
    fs.writeFileSync(path.join(dir, "profile.md"), PROFILE_HEADER + profile.map((f) => `${renderLine(f)}\n`).join(""));
    const byMonth = new Map<string, string[]>();
    for (const f of c.memoryFacts.filter((x) => x.tier === "log")) byMonth.set(monthOf(f.date), [...(byMonth.get(monthOf(f.date)) ?? []), renderLine(f)]);
    for (const [m, lines] of byMonth) fs.writeFileSync(path.join(dir, "log", `${m}.md`), `${LOG_HEADER}${lines.join("\n")}\n`);
    const r = renderMemorySection({ store, botId: c.botId, nameOf: () => "Bench", dataRoot: BOX_DATA_ROOT });
    const shown = new Set(r.ids);
    return { id: "memory", date: c.asOf, text: r.text, sources: c.memoryFacts.filter((f) => shown.has(factId(f.content))).map((f) => f.source) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The restore block the next turn after a compaction gets, built by the real buildRestoreBlock over the transcript tail. */
export function renderBaselineRestore(c: Archive): Passage {
  const tail = c.turns.slice(-400);
  const entries: TranscriptEntry[] = tail.map((t) => {
    const at = Date.parse(`${t.date}T12:00:00Z`);
    return t.speaker === "user"
      ? ({ kind: "message", id: `t${t.seq}u`, role: "user", content: t.text, createdAt: at } satisfies UserMessageEntry)
      : ({ kind: "send-message", id: `t${t.seq}s`, requestId: `r${t.seq}`, createdAt: at, message: { type: "text", content: t.text } } as SendMessageEntry);
  });
  const lastUser = [...tail].reverse().find((t) => t.speaker === "user")!;
  const bots = {
    tail: () => entries, summary: () => ({ awaiting: null }), confirmedUserSeq: () => lastUser.seq,
    brainKv: <T>(_b: string, _k: string, d: T) => d,
  } as unknown as BotService;
  const text = buildRestoreBlock({ bots, botId: c.botId, dataRoot: BOX_DATA_ROOT });
  const users = tail.filter((t) => t.speaker === "user").slice(-3), sent = tail.filter((t) => t.speaker === "assistant").slice(-3);
  return { id: "restore", date: c.asOf, text, sources: [...users, ...sent].map((t) => t.id) };
}

/**
 * BASELINE: what a Synapse Bot has in context today when asked about its past, with no search:
 * the memory section of its prompt, the latest compaction summary, the turns since that
 * compaction, and the restore block. The same context whatever the question. (The per-turn
 * recalled_memory hook, memory/recall.ts, is a search and is deliberately left out.)
 */
export function baselineRetriever(c: Archive): Retriever {
  const last = c.summaries.at(-1);
  const passages: Passage[] = [
    renderBaselineMemory(c),
    ...(last ? [{ id: last.id, date: last.date, text: last.text, sources: last.sources }] : []),
    ...c.turns.filter((t) => t.seq >= c.lastBoundarySeq).map((t) => ({ id: t.id, date: t.date, text: t.text })),
    renderBaselineRestore(c),
  ];
  return { name: "baseline (memory + latest summary + live tail + restore, no search)", schemaTokens: 0, retrieve: () => ({ passages, fired: false }) };
}

/** UPPER BOUND: every turn, every summary, every document page, loaded for every question. */
export function loadEverythingRetriever(c: Archive): Retriever {
  const passages: Passage[] = [
    ...c.turns.map((t) => ({ id: t.id, date: t.date, text: t.text })),
    ...c.summaries.map((s) => ({ id: s.id, date: s.date, text: s.text, sources: s.sources })),
    ...c.docs.flatMap((d) => d.pages.map((p, i) => ({ id: `doc:${d.id}#p${i + 1}`, date: c.asOf, text: p }))),
  ];
  return { name: "load everything (upper bound)", schemaTokens: 0, retrieve: () => ({ passages, fired: false }) };
}
