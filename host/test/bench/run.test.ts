import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { archiveRetriever, buildArchive, hostedAgentModeRetriever } from "../../bench/archive-retriever";
import { SCALES, archiveOf, generateCorpus, goldJsonl, questionsJsonl } from "../../bench/corpus";
import { baselineRetriever, loadEverythingRetriever } from "../../bench/retrievers";
import { corpusTokens, formatReport, score, type ScoreReport } from "../../bench/scorer";

/**
 * The measurement run, outside npm test: `npm run bench:context` (full) or
 * `BENCH_RUN=small npm run bench:context`. The full run rewrites host/bench/questions.jsonl,
 * host/bench/baseline-full.json (baseline + load-everything) and host/bench/archive-full.json
 * (hosted-agent mode + the history archive, with the archive's resource readings), and prints every table.
 */
const scale = process.env.BENCH_RUN as keyof typeof SCALES | undefined;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

describe.skipIf(!scale)("context recall benchmark run", () => {
  it(`scores the baseline, hosted-agent mode, the archive and the load-everything bound at scale ${scale}`, async () => {
    const t0 = performance.now();
    // cost-diet-2 lever 6: BENCH_CAP=120000|150000 replays the same corpus with compaction boundaries scaled from the
    // 180k default (compactEvery 150 turns = the 180k cap) to the smaller cap; nothing pinned is rewritten.
    const cap = Number(process.env.BENCH_CAP ?? 180_000);
    const cfg = { ...SCALES[scale!], compactEvery: Math.round((SCALES[scale!].compactEvery * cap) / 180_000) };
    const c = generateCorpus(cfg);
    const genMs = performance.now() - t0;
    const out: string[] = [
      `history cap ${cap} (compactEvery ${cfg.compactEvery} turns)`,
      `corpus: ${c.turns.length} turns, ${new Set(c.turns.map((t) => t.session)).size} sessions, ${c.summaries.length} summaries, ${c.docs.length} documents / ${c.docs.reduce((a, d) => a + d.pages.length, 0)} pages, ${c.memoryFacts.length} memory facts, ${corpusTokens(c)} tokens; generated in ${Math.round(genMs)} ms`,
    ];
    const archive = archiveOf(c); // retrievers see the archive only: no questions, truth or gold
    const reports: ScoreReport[] = [];
    for (const r of [baselineRetriever(archive), loadEverythingRetriever(archive)]) {
      const rep = await score(c, r);
      reports.push(rep);
      out.push("", formatReport(rep));
    }
    const hosted = await score(c, hostedAgentModeRetriever(archive));
    const build = buildArchive(archive);
    const arch = archiveRetriever(archive, build);
    const rep = await score(c, arch);
    // Resident cost, measured where nothing else lives: a fresh node process opens the archive and
    // answers every question twice (steady state). RSS after, minus the same process before opening.
    const qFile = path.join(build.dir, "questions.json");
    fs.writeFileSync(qFile, JSON.stringify(c.questions.map((q) => q.question)));
    const child = `const fs = await import("node:fs");
      const { HistoryArchive } = await import(${JSON.stringify(fileURLToPath(new URL("../../history/archive.ts", import.meta.url)))});
      const qs = JSON.parse(fs.readFileSync(${JSON.stringify(qFile)}, "utf8"));
      const before = process.memoryUsage().rss;
      const a = new HistoryArchive(${JSON.stringify(build.archive.file)}, { redact: (_b, t) => t, secrets: () => [] });
      for (let k = 0; k < 2; k++) for (const q of qs) a.search(${JSON.stringify(c.botId)}, { query: q });
      process.stdout.write(JSON.stringify({ before, after: process.memoryUsage().rss }));`;
    const rss = JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", child], { encoding: "utf8" })) as { before: number; after: number };
    const resources = {
      rows: build.rows, indexMs: Math.round(build.indexMs), rowsPerSec: Math.round(build.rows / (build.indexMs / 1000)),
      diskBytesTurnsAndSummaries: build.turnsBytes, diskBytesTotal: build.totalBytes,
      diskBytesPer1kTurns: Math.round(build.turnsBytes / (c.turns.length / 1000)),
      rssMB: { archive: Math.round((rss.after - rss.before) / 1e5) / 10, processTotal: Math.round(rss.after / 1e5) / 10 },
      searchMs: { p50: Math.round(pct(arch.latencies, 0.5) * 100) / 100, p95: Math.round(pct(arch.latencies, 0.95) * 100) / 100 },
      schemaTokensPerCall: arch.schemaTokens,
    };
    build.archive.close();
    fs.rmSync(build.dir, { recursive: true, force: true });
    out.push("", formatReport(hosted), "", formatReport(rep), "", `archive resources: ${JSON.stringify(resources)}`);
    process.stdout.write(`${out.join("\n")}\n`);
    if (scale === "full" && cap === 180_000) {
      fs.writeFileSync(new URL("../../bench/questions.jsonl", import.meta.url), questionsJsonl(c));
      fs.writeFileSync(new URL("../../bench/gold-facts.jsonl", import.meta.url), goldJsonl(c));
      const strip = (rs: typeof reports) => rs.map(({ questions: _q, ...rest }) => rest);
      fs.writeFileSync(new URL("../../bench/baseline-full.json", import.meta.url), `${JSON.stringify(strip(reports), null, 2)}\n`);
      fs.writeFileSync(new URL("../../bench/archive-full.json", import.meta.url), `${JSON.stringify({ reports: strip([hosted, rep]), resources }, null, 2)}\n`);
    }
    expect(reports[0]!.overall.weightedExact).toBeLessThanOrEqual(reports[1]!.overall.weightedExact);
  }, 1_800_000);
});
