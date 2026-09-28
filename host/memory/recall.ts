import { LIMITS } from "@synapse/shared";
import type { TurnHooks } from "../runner/hooks";
import { TRIVIAL } from "./extractor";
import type { MemoryStore, Scope } from "./memory-store";
import type { FactLedger, LedgerRow } from "./ledger";
import type { Candidate, RecallIndex, Visibility } from "./recall-index";

const DAY = 86_400_000;
export const normalizeTerm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export function queryTerms(text: string): string[] {
  const out: string[] = [];
  for (const t of normalizeTerm(text).match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (TRIVIAL.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === LIMITS.recallMaxTerms) break;
  }
  return out;
}

export interface ScoredFact extends Candidate { s: number; bm25n: number; matched: string[] }

export function scoreCandidates(c: Candidate[], ctx: { now: number; terms: string[]; reinforced(c: Candidate): boolean }): ScoredFact[] {
  if (!c.length) return [];
  const raw = c.map((x) => -x.bm25); // FTS5 bm25() is lower-is-better
  const lo = Math.min(...raw), hi = Math.max(...raw);
  return c.map((x, i) => {
    const bm25n = hi === lo ? 1 : (raw[i]! - lo) / (hi - lo);
    const toks = new Set(normalizeTerm(x.content).match(/[\p{L}\p{N}]+/gu) ?? []);
    const matched = ctx.terms.filter((t) => toks.has(t));
    const recency = 0.5 ** (Math.max(0, ctx.now - x.createdAt) / DAY / 30);
    const s = bm25n + 0.3 * recency + 0.2 * Math.log2(x.importance) + 0.1 * (ctx.reinforced(x) ? 1 : 0);
    return { ...x, s, bm25n, matched };
  });
}

export function selectRecall(scored: ScoredFact[], ctx: { frozen: Set<string>; rare: Set<string> }): ScoredFact[] {
  return scored
    .filter((f) => !ctx.frozen.has(f.factId))
    .filter((f) => f.bm25n >= LIMITS.recallMinBm25n && (f.matched.length >= 2 || (f.matched.length === 1 && ctx.rare.has(f.matched[0]!))))
    .sort((a, b) => b.s - a.s)
    .slice(0, LIMITS.recallMaxFacts);
}


const prefix = (f: ScoredFact) => (f.kind === "note" ? "[note] " : f.kind === "episode" ? "[episode] " : "");
function via(f: { scope: string; owner: string; project: string | null }, nameOf: (id: string) => string, botId: string): string {
  if (f.scope === "user" && f.owner !== botId) return `[via ${nameOf(f.owner)}] `;
  if (f.scope === "team") return f.owner !== botId ? `[team via ${nameOf(f.owner)}] ` : "[team] ";
  return f.scope === "project" ? `[project ${f.project}] ` : "";
}
export function recallLine(f: ScoredFact, nameOf: (id: string) => string, botId: string): string {
  return `- (learned ${new Date(f.createdAt).toISOString().slice(0, 10)}) ${via(f, nameOf, botId)}${prefix(f)}${f.content}`;
}
/** A fact the ledger has ended: dated by when it stopped being true, so the Bot never mistakes it for the current one. */
export function pastLine(r: LedgerRow, nameOf: (id: string) => string, botId: string): string {
  const scope = r.scope === "private" ? "agent" : r.scope;
  return `- (until ${new Date(r.validTo ?? r.supersededAt ?? 0).toISOString().slice(0, 10)}) ${via({ scope, owner: r.owner, project: r.project }, nameOf, botId)}${r.text}`;
}

/** "What did it use to be": only such a question gets ended facts back (the lab's asOf rule, read from the words). */
const PAST = /\b(?:before|previous(?:ly)?|former(?:ly)?|originally|used to|use to|earlier|no longer|any ?more|last (?:year|month|time)|in the past|history of|what was|who was|where was|when was|what were|who were|did (?:i|we|they|you) (?:have|use))\b/i;
export function asksAboutThePast(text: string): boolean {
  return PAST.test(text);
}
const PAST_MAX = 3;

export function renderRecall(lines: string[]): string {
  if (!lines.length) return "";
  return `<system_reminder><recalled_memory>\nPossibly relevant memories not shown above (check before relying on them):\n${lines.join("\n")}\n</recalled_memory></system_reminder>`;
}

export interface RecallDeps { index: RecallIndex; store: MemoryStore; ledger?: FactLedger; frozen(botId: string): Set<string>; nameOf(botId: string): string; now(): number }

const scopeOf = (f: Candidate): Scope => (f.scope === "project" ? { kind: "project", botId: f.owner, slug: f.project! } : { kind: f.scope, botId: f.owner });

/**
 * Per-turn recall (ORIG-05 §05.3): current facts from the index; with the ledger and a question about the past, also
 * up to PAST_MAX ended facts, first. Both share the one budget: ≤ LIMITS.recallMaxFacts lines, ≤ LIMITS.recallMaxChars.
 */
export function recallFor(d: RecallDeps, botId: string, text: string): { block: string | null; facts: ScoredFact[]; past: LedgerRow[] } {
  const none = { block: null, facts: [], past: [] };
  const terms = queryTerms(text);
  if (!terms.length) return none;
  const v: Visibility = { botId, projects: d.store.projects(botId) };
  const cands = d.index.search(terms, v);
  const pastRows = d.ledger && asksAboutThePast(text) ? d.ledger.searchPast(terms, v) : [];
  if (!cands.length && !pastRows.length) return none;
  const now = d.now();
  const metaCache = new Map<string, Record<string, { confirmedAt?: number }>>();
  const meta = (c: Candidate) => {
    const s = scopeOf(c);
    const k = JSON.stringify(s);
    if (!metaCache.has(k)) metaCache.set(k, d.store.meta(s));
    return metaCache.get(k)![c.factId] ?? {};
  };
  const total = d.index.count(v);
  const rareCut = Math.max(1, Math.floor(total * 0.1)); // "IDF in the top decile": appears in ≤10% of readable facts
  const rare = new Set(terms.filter((t) => d.index.docFreq(t, v) <= rareCut));
  const lines: string[] = [];
  let chars = 0;
  const fits = (l: string) => lines.length < LIMITS.recallMaxFacts && chars + l.length + 1 <= LIMITS.recallMaxChars;
  const take = (l: string) => { lines.push(l); chars += l.length + 1; };

  // The same relevance bar as current facts: two query terms, or one rare one.
  const past: LedgerRow[] = [];
  for (const r of pastRows) {
    if (past.length === PAST_MAX) break;
    const toks = new Set(normalizeTerm(r.text).match(/[\p{L}\p{N}]+/gu) ?? []);
    const matched = terms.filter((t) => toks.has(t));
    if (!(matched.length >= 2 || (matched.length === 1 && rare.has(matched[0]!)))) continue;
    const l = pastLine(r, d.nameOf, botId);
    if (!fits(l)) break;
    past.push(r);
    take(l);
  }

  const picked: ScoredFact[] = [];
  const scored = scoreCandidates(cands, { now, terms, reinforced: (c) => now - (meta(c).confirmedAt ?? 0) <= 30 * DAY });
  for (const f of selectRecall(scored, { frozen: d.frozen(botId), rare })) {
    const l = recallLine(f, d.nameOf, botId);
    if (!fits(l)) break;
    picked.push(f);
    take(l);
  }
  if (!lines.length) return none;
  const byScope = new Map<string, { s: Scope; ids: string[] }>();
  for (const f of picked) {
    const s = scopeOf(f);
    const k = JSON.stringify(s);
    byScope.set(k, { s, ids: [...(byScope.get(k)?.ids ?? []), f.factId] });
  }
  for (const { s, ids } of byScope.values()) d.store.touchRecalled(s, ids);
  return { block: renderRecall(lines), facts: picked, past };
}

/** Phase 2 wake sources: only visible user turns get recall (routine and heartbeat wakes join in Phases 4–5). */
export function createRecallHooks(d: RecallDeps & { enabled(): boolean }): TurnHooks {
  return {
    turnBlocks: (botId, t) => {
      if (!d.enabled() || t.source !== "user" || t.hidden) return [];
      const r = recallFor(d, botId, t.queryText);
      return r.block ? [{ text: r.block }] : [];
    },
  };
}
