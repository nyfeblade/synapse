import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { archiveRetriever, buildArchive, hostedAgentModeRetriever, HOSTED_WINDOW_TOKENS, searchHistorySchemaTokens } from "../../bench/archive-retriever";
import { KINDS, SCALES, archiveOf, generateCorpus } from "../../bench/corpus";
import { baselineRetriever } from "../../bench/retrievers";
import { estimateTokens, score } from "../../bench/scorer";

const corpus = generateCorpus(SCALES.small);
const archive = archiveOf(corpus);
const build = buildArchive(archive);
afterAll(() => { build.archive.close(); fs.rmSync(build.dir, { recursive: true, force: true }); });
const r4 = (v: number | null) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const pinOf = async (r: Parameters<typeof score>[1]) => {
  const s = await score(corpus, r);
  return { perKind: Object.fromEntries(KINDS.map((k) => [k, { recall: r4(s.perKind[k].evidenceRecall), exact: r4(s.perKind[k].exact), tokens: Math.round(s.perKind[k].tokensMean) }])), weightedExact: r4(s.overall.weightedExact) };
};

describe("history archive retriever (the production archive, one SearchHistory call per question)", () => {
  it("indexes with the production row builders: every turn, every summary, the documents' chunks", () => {
    const docChunks = build.rows - corpus.turns.length - corpus.summaries.length;
    expect(docChunks).toBeGreaterThanOrEqual(corpus.docs.reduce((a, d) => a + d.pages.length, 0));
  });

  it("sees only the Ask: its result depends on the question, not on the answer key", () => {
    const r = archiveRetriever(archive, build);
    const a = r.retrieve({ id: "x", question: "What is the zzz qqq?", asOf: corpus.asOf });
    const b = r.retrieve({ id: corpus.questions[0]!.id, question: "What is the zzz qqq?", asOf: corpus.asOf });
    expect(a.passages).toEqual(b.passages);
  });

  it("charges the tool's schema on every call, as measured from its definition", () => {
    const t = searchHistorySchemaTokens();
    expect(t).toBeGreaterThan(150);
    expect(archiveRetriever(archive, build).schemaTokens).toBe(t);
  });

  it("is pinned, and beats the baseline without loading hosted-agent mode's window", async () => {
    const got = await pinOf(archiveRetriever(archive, build));
    expect(got).toEqual(PINNED_ARCHIVE);
    const base = await score(corpus, baselineRetriever(archive));
    expect(got.weightedExact!).toBeGreaterThan(base.overall.weightedExact);
  });
});

describe("hosted-agent mode (raw history up to its 90%-of-200k point + memory, no search)", () => {
  it("loads at most the window plus memory, the newest turns, and no documents", () => {
    const ps = hostedAgentModeRetriever(archive).retrieve({ id: "q", question: "anything", asOf: corpus.asOf }).passages;
    const turns = ps.filter((p) => p.id.startsWith("turn:"));
    expect(turns.at(-1)!.id).toBe(corpus.turns.at(-1)!.id);
    expect(turns.reduce((a, p) => a + estimateTokens(p.text), 0)).toBeLessThanOrEqual(HOSTED_WINDOW_TOKENS);
    expect(ps.some((p) => p.id.startsWith("doc:"))).toBe(false);
    expect(ps[0]!.text).toContain("# Memory");
  });

  it("is pinned", async () => {
    expect(await pinOf(hostedAgentModeRetriever(archive))).toEqual(PINNED_HOSTED);
  });
});

// Pinned from the first small-scale run (seed in SCALES.small). Small scale fits whole in hosted-agent
// mode's window and is easy for search; it is a regression net, not the measurement. The full-scale
// numbers are in host/bench/archive-full.json (npm run bench:context). Change only with a reason
// in docs/decisions.md.
const PINNED_ARCHIVE = {
  perKind: {
    buried: { recall: 1, exact: 1, tokens: 4111 },
    summarised: { recall: 1, exact: 1, tokens: 3889 },
    superseded: { recall: 1, exact: 1, tokens: 4008 },
    scattered: { recall: 1, exact: 1, tokens: 3991 },
    document: { recall: 1, exact: 1, tokens: 4827 },
    negative: { recall: null, exact: 1, tokens: 4017 },
  },
  weightedExact: 1,
};
const PINNED_HOSTED = {
  perKind: {
    buried: { recall: 1, exact: 1, tokens: 16901 },
    summarised: { recall: 1, exact: 1, tokens: 16901 },
    superseded: { recall: 1, exact: 1, tokens: 16901 },
    scattered: { recall: 1, exact: 1, tokens: 16901 },
    document: { recall: 0, exact: 0, tokens: 16901 },
    negative: { recall: null, exact: 1, tokens: 16901 },
  },
  weightedExact: 0.875,
};
