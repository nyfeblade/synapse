import { KINDS, type Corpus, type Kind, type Question } from "./corpus";
import { norm, readAnswer, type Passage } from "./reader";

export type { Passage } from "./reader";

/** What a retriever hands back for one question. `tokens` defaults to the passages' estimate. */
export interface Retrieval { passages: Passage[]; tokens?: number; fired?: boolean; answer?: string }
/**
 * The pluggable retriever: question → evidence plus tokens loaded. `schemaTokens` is what its tool
 * definition costs on every turn it is offered (0 for context that is simply always there).
 */
export interface Retriever {
  name: string; schemaTokens: number;
  /** Declares that it was built from the gold triples (bench/gold-facts.jsonl): its results are labelled "ceiling". */
  usesGold?: boolean;
  retrieve(q: Ask): Retrieval;
}
/** What a retriever is asked: never the answer, the evidence or the kind. */
export interface Ask { id: string; question: string; asOf: string }

/** Optional LLM judge: OFF unless passed. Tests never pass a model-backed one. */
export type Judge = (q: Question, answer: string, loaded: string) => boolean | Promise<boolean>;
export interface ScoreOptions {
  /** Share of turns on which retrieval fires; measured from `fired` over the questions when left out. */
  firingRate?: number;
  /** Turns the schema is paid on; defaults to the corpus's user turns. */
  turns?: number;
  /** What a turn would load without this retriever; defaults to the whole corpus (the brute-force option). */
  referenceTokens?: number;
  judge?: Judge;
}

export const KIND_WEIGHT: Record<Kind, number> = { buried: 1, summarised: 1, superseded: 3, scattered: 1, document: 1, negative: 1 };

export interface QuestionScore { id: string; kind: Kind; answer: string; exact: boolean; judged: boolean | null; evidenceRecall: number | null; tokens: number; fired: boolean }
export interface KindScore { kind: Kind; n: number; weight: number; evidenceRecall: number | null; exact: number; judged: number | null; tokensMean: number; savingMean: number; netPerTurn: number }
export interface ScoreReport {
  retriever: string; label: "ceiling" | "realistic"; schemaTokens: number; referenceTokens: number; turns: number;
  perKind: Record<Kind, KindScore>;
  overall: { weightedExact: number; weightedRecall: number | null; tokensMean: number; firingRate: number; netPerTurn: number; netTotal: number };
  questions: QuestionScore[];
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function corpusTokens(c: Corpus): number {
  let n = 0;
  for (const t of c.turns) n += estimateTokens(t.text);
  for (const s of c.summaries) n += estimateTokens(s.text);
  for (const d of c.docs) for (const p of d.pages) n += estimateTokens(p);
  return n;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function score(c: Corpus, r: Retriever, o: ScoreOptions = {}): Promise<ScoreReport> {
  const qs: QuestionScore[] = [];
  for (const q of c.questions) {
    const got = r.retrieve({ id: q.id, question: q.question, asOf: q.asOf });
    const answer = got.answer ?? readAnswer(c.truth[q.id]!, got.passages);
    const surfaced = new Set(got.passages.flatMap((p) => [p.id, ...(p.sources ?? [])]));
    const loaded = got.tokens ?? got.passages.reduce((a, p) => a + estimateTokens(p.text), 0);
    qs.push({
      id: q.id, kind: q.kind, answer, exact: norm(answer) === norm(q.answer),
      judged: o.judge ? await o.judge(q, answer, got.passages.map((p) => p.text).join("\n\n")) : null,
      evidenceRecall: q.evidence.length ? q.evidence.filter((e) => surfaced.has(e)).length / q.evidence.length : null,
      tokens: loaded, fired: got.fired ?? false,
    });
  }
  const referenceTokens = o.referenceTokens ?? corpusTokens(c);
  const turns = o.turns ?? c.turns.filter((t) => t.speaker === "user").length;
  const firingRate = o.firingRate ?? mean(qs.map((x) => (x.fired ? 1 : 0)));
  const net = (tokensMean: number) => firingRate * (referenceTokens - tokensMean) - r.schemaTokens;
  const perKind = Object.fromEntries(KINDS.map((k) => {
    const xs = qs.filter((x) => x.kind === k);
    const rec = xs.map((x) => x.evidenceRecall).filter((v): v is number => v !== null);
    const tokensMean = mean(xs.map((x) => x.tokens));
    return [k, {
      kind: k, n: xs.length, weight: KIND_WEIGHT[k], evidenceRecall: rec.length ? mean(rec) : null, exact: mean(xs.map((x) => (x.exact ? 1 : 0))),
      judged: o.judge ? mean(xs.map((x) => (x.judged ? 1 : 0))) : null, tokensMean, savingMean: referenceTokens - tokensMean, netPerTurn: net(tokensMean),
    } satisfies KindScore];
  })) as Record<Kind, KindScore>;
  const w = (x: QuestionScore) => KIND_WEIGHT[x.kind];
  const totalW = qs.reduce((a, x) => a + w(x), 0);
  const recQs = qs.filter((x) => x.evidenceRecall !== null);
  const recW = recQs.reduce((a, x) => a + w(x), 0);
  const tokensMean = mean(qs.map((x) => x.tokens));
  const netPerTurn = net(tokensMean);
  return {
    retriever: r.name, label: r.usesGold ? "ceiling" : "realistic", schemaTokens: r.schemaTokens, referenceTokens, turns, perKind, questions: qs,
    overall: {
      weightedExact: totalW ? qs.reduce((a, x) => a + (x.exact ? w(x) : 0), 0) / totalW : 0,
      weightedRecall: recW ? recQs.reduce((a, x) => a + x.evidenceRecall! * w(x), 0) / recW : null,
      tokensMean, firingRate, netPerTurn, netTotal: netPerTurn * turns,
    },
  };
}

/** A plain-text table, one row per kind: the report the full run prints and writes. */
export function formatReport(r: ScoreReport): string {
  const f = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
  const rows = KINDS.map((k) => {
    const s = r.perKind[k];
    return `| ${k} | ${s.n} | ${s.weight} | ${f(s.evidenceRecall)} | ${f(s.exact)} | ${f(s.judged)} | ${Math.round(s.tokensMean)} | ${Math.round(s.netPerTurn)} |`;
  });
  return [
    `### ${r.retriever} [${r.label}]`, "",
    "| kind | n | weight | evidence recall | exact | judged | tokens loaded | net tokens/turn |", "|---|---|---|---|---|---|---|---|", ...rows,
    `| **overall (weighted)** | ${r.questions.length} | | ${f(r.overall.weightedRecall)} | ${f(r.overall.weightedExact)} | | ${Math.round(r.overall.tokensMean)} | ${Math.round(r.overall.netPerTurn)} |`,
    "", `firing rate ${f(r.overall.firingRate)}, schema ${r.schemaTokens} tokens/turn, reference ${r.referenceTokens} tokens, ${r.turns} turns → net ${Math.round(r.overall.netTotal)} tokens`,
  ].join("\n");
}
