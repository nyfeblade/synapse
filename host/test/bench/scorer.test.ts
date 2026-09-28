import { describe, expect, it } from "vitest";
import { KINDS, SCALES, generateCorpus, type Question } from "../../bench/corpus";
import { readAnswer } from "../../bench/reader";
import { baselineRetriever, loadEverythingRetriever } from "../../bench/retrievers";
import { KIND_WEIGHT, estimateTokens, formatReport, score, type Passage, type Retriever } from "../../bench/scorer";

const corpus = generateCorpus(SCALES.small);
const q = (kind: string): Question => corpus.questions.find((x) => x.kind === kind)!;
const p = (id: string, date: string, text: string, sources: string[] = []): Passage => ({ id, date, text, sources });
const byQ = new Map(corpus.questions.map((x) => [x.id, x]));
/** Test retrievers may peek at the answer key through the question id; real ones only get the Ask. */
const fixed = (name: string, fn: (q: Question) => Passage[], extra: Partial<Retriever> = {}): Retriever => ({ name, schemaTokens: 0, retrieve: (x) => ({ passages: fn(byQ.get(x.id)!) }), ...extra });

describe("deterministic exact-match reader", () => {
  it("reads '<key> is <value>' and prefers the latest-dated statement", () => {
    const truth = { key: "Halvor budget", mode: "latest" as const, stale: ["$40k"] };
    const ps = [p("a", "2024-01-02", "Update: the Halvor budget is $55k. Thanks."), p("b", "2022-05-01", "- (2022-05-01) the Halvor budget is $40k")];
    expect(readAnswer(truth, ps)).toBe("$55k");
    // a dated line inside an older passage still wins by its own date
    expect(readAnswer(truth, [p("m", "2021-01-01", "- (learned 2025-02-02) The user said the Halvor budget is $70k.\n- (learned 2020-01-01) x"), ...ps])).toBe("$70k");
  });
  it("lists every value oldest first in 'all' mode, and says so when nothing matches", () => {
    const truth = { key: "Tamsin offsite city", mode: "all" as const, stale: [] };
    const ps = [p("b", "2023-03-01", "one Tamsin offsite city is Osaka."), p("a", "2022-01-01", "a Tamsin offsite city is Lisbon."), p("c", "2023-04-01", "the Tamsin offsite city is Osaka.")];
    expect(readAnswer(truth, ps)).toBe("Lisbon, Osaka");
    expect(readAnswer({ key: "Nobody retainer", mode: "latest", stale: [] }, ps)).toBe("not in the data");
  });
});

describe("scorer", () => {
  it("scores a perfect-evidence retriever at recall 1, and an empty one at recall 0 but right on negatives", async () => {
    const byId = new Map(corpus.turns.map((t) => [t.id, t]));
    const oracle = fixed("oracle", (x) => x.evidence.map((e) => {
      const t = byId.get(e);
      if (t) return p(t.id, t.date, t.text);
      const [, doc, page] = /^doc:(.+)#p(\d+)$/.exec(e)!;
      return p(e, corpus.asOf, corpus.docs.find((d) => d.id === doc)!.pages[Number(page) - 1]!);
    }));
    const r = await score(corpus, oracle);
    for (const k of KINDS) expect(r.perKind[k].exact).toBe(1);
    for (const k of KINDS.filter((k) => k !== "negative")) expect(r.perKind[k].evidenceRecall).toBe(1);
    expect(r.perKind.negative.evidenceRecall).toBeNull();

    const empty = await score(corpus, fixed("empty", () => []));
    for (const k of KINDS.filter((k) => k !== "negative")) {
      expect(empty.perKind[k].evidenceRecall).toBe(0);
      expect(empty.perKind[k].exact).toBe(0);
    }
    expect(empty.perKind.negative.exact).toBe(1);
    expect(empty.overall.tokensMean).toBe(0);
  });

  it("credits evidence through a derived passage's sources (a summary or memory line that carries the fact)", async () => {
    const x = q("buried");
    const r = await score(corpus, fixed("derived", (y) => (y.id === x.id ? [p("summary:1", "2020-01-01", "stuff", x.evidence)] : [])));
    expect(r.questions.find((s) => s.id === x.id)!.evidenceRecall).toBe(1);
  });

  it("weights superseded 3x in the overall score", async () => {
    expect(KIND_WEIGHT.superseded).toBe(3);
    for (const k of KINDS.filter((k) => k !== "superseded")) expect(KIND_WEIGHT[k]).toBe(1);
    const onlyNeg = await score(corpus, fixed("empty", () => []));
    const n = SCALES.small.perKind;
    expect(onlyNeg.overall.weightedExact).toBeCloseTo(n / (n * 5 + n * 3), 10);
  });

  it("computes net tokens: firing rate x (reference - loaded) - schema cost per turn, times turns", async () => {
    const r = await score(corpus, fixed("tool", () => [p("x", "2020-01-01", "a".repeat(400))], { schemaTokens: 250 }), { firingRate: 0.2, turns: 1000, referenceTokens: 5100 });
    expect(r.overall.tokensMean).toBe(100);
    expect(r.overall.firingRate).toBe(0.2);
    expect(r.overall.netPerTurn).toBeCloseTo(0.2 * (5100 - 100) - 250, 10);
    expect(r.overall.netTotal).toBeCloseTo((0.2 * 5000 - 250) * 1000, 6);
    // measured firing rate when none is configured: the share of questions where the retriever fired
    const half = await score(corpus, { name: "half", schemaTokens: 0, retrieve: (y) => ({ passages: [], fired: Number(y.id.slice(2)) % 2 === 0 }) });
    expect(half.overall.firingRate).toBeCloseTo(0.5, 10);
  });

  it("leaves the LLM judge off by default and reports its verdicts only when a judge is supplied", async () => {
    const off = await score(corpus, fixed("empty", () => []));
    for (const k of KINDS) expect(off.perKind[k].judged).toBeNull();
    const calls: string[] = [];
    const on = await score(corpus, fixed("empty", () => []), { judge: (x) => { calls.push(x.id); return x.kind === "negative"; } });
    expect(calls).toHaveLength(corpus.questions.length);
    expect(on.perKind.negative.judged).toBe(1);
    expect(on.perKind.buried.judged).toBe(0);
  });

  it("asks a retriever only the id, the question and asOf: never the answer, evidence or kind", async () => {
    const seen: string[][] = [];
    await score(corpus, { name: "spy", schemaTokens: 0, retrieve: (a) => { seen.push(Object.keys(a).sort()); return { passages: [] }; } });
    expect(seen).toHaveLength(corpus.questions.length);
    for (const k of seen) expect(k).toEqual(["asOf", "id", "question"]);
  });

  it("labels a retriever that declares it used the gold triples as the ceiling, every other one realistic", async () => {
    expect((await score(corpus, fixed("plain", () => []))).label).toBe("realistic");
    const ceiling = await score(corpus, fixed("ledger-gold", () => [], { usesGold: true }));
    expect(ceiling.label).toBe("ceiling");
    expect(formatReport(ceiling)).toContain("[ceiling]");
  });

  it("estimates tokens as chars / 4, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("load-everything upper bound (validates the instrument)", () => {
  it("gets every kind right with full evidence recall", async () => {
    const r = await score(corpus, loadEverythingRetriever(corpus));
    for (const k of KINDS) expect(r.perKind[k].exact, k).toBe(1);
    for (const k of KINDS.filter((k) => k !== "negative")) expect(r.perKind[k].evidenceRecall, k).toBe(1);
  });
});

describe("baseline: what Synapse loads today (memory section + latest summary + live tail + restore block, no search)", () => {
  it("loads the real memory render, the latest summary, and the real restore block", () => {
    const b = baselineRetriever(corpus);
    const ps = b.retrieve(q("buried")).passages;
    const text = ps.map((x) => x.text).join("\n");
    expect(text).toContain("# Memory");
    expect(text).toContain("<context_restore>");
    expect(ps.some((x) => x.id === corpus.summaries.at(-1)!.id && x.text === corpus.summaries.at(-1)!.text)).toBe(true);
    expect(ps.filter((x) => x.id.startsWith("summary:"))).toHaveLength(1);
    expect(ps.filter((x) => x.id.startsWith("turn:")).map((x) => x.id)).toEqual(corpus.turns.filter((t) => t.seq >= corpus.lastBoundarySeq).map((t) => t.id));
    expect(ps.some((x) => x.id.startsWith("doc:"))).toBe(false);
    // no search: the same context whatever the question
    expect(b.retrieve(q("negative")).passages).toEqual(ps);
  });

  it("is pinned: a regression in the baseline shows here", async () => {
    const r = await score(corpus, baselineRetriever(corpus));
    const r4 = (v: number | null) => (v === null ? null : Math.round(v * 1e4) / 1e4);
    const got = Object.fromEntries(KINDS.map((k) => [k, { recall: r4(r.perKind[k].evidenceRecall), exact: r4(r.perKind[k].exact), tokens: r.perKind[k].tokensMean }]));
    expect({ perKind: got, weightedExact: r4(r.overall.weightedExact) }).toEqual(PINNED_BASELINE);
    const all = await score(corpus, loadEverythingRetriever(corpus));
    expect(r.overall.weightedExact).toBeLessThan(all.overall.weightedExact);
    expect(r.overall.tokensMean).toBeLessThan(all.overall.tokensMean);
  });
});

// Pinned from the first run of the small-scale corpus (seed in SCALES.small). Change only with a
// stated reason in docs/decisions.md: a move here means the baseline or the corpus changed.
// Small scale does not saturate memory the way five real years do; the full-scale numbers are in
// host/bench/baseline-full.json (npm run bench:context).
const PINNED_BASELINE = {
  perKind: {
    buried: { recall: 0.3333, exact: 0.3333, tokens: 3673 },
    summarised: { recall: 0.1667, exact: 0.1667, tokens: 3673 },
    superseded: { recall: 0.8333, exact: 0.8333, tokens: 3673 },
    scattered: { recall: 0.6417, exact: 0.1667, tokens: 3673 },
    document: { recall: 0, exact: 0, tokens: 3673 },
    negative: { recall: null, exact: 1, tokens: 3673 },
  },
  weightedExact: 0.5208, // (2 + 1 + 3·5 + 1 + 0 + 6) / 48
};
