import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SdkOneShot, type OneShotModel } from "../../brain/one-shot";
import { loadConformance } from "../../brain/conformance/runner";
import { buildBotEnv } from "../../brain/spawn-options";
import { claudeExecutableFor } from "../../brain/tool-policy";
import { useSavedAuth } from "../../auth/auth-store";
import { loadConfig } from "../../config";
import { parseExtraction, MemoryExtractor } from "../../memory/extractor";
import { FactLedger } from "../../memory/ledger";
import { migrateMemoryToLedger } from "../../memory/ledger-migrate";
import { MemoryStore } from "../../memory/memory-store";
import { recallFor } from "../../memory/recall";
import { RecallIndex } from "../../memory/recall-index";
import { reindexAll } from "../../memory/recall-sync";
import { LOG_HEADER, renderLine } from "../../memory/facts";
import { writeTextAtomic } from "../../util/atomic-text";
import { fillTemplate, loadPrompt } from "../../prompts/index";
import { initLayout } from "../../store/layout";
import { generateRecallCorpus } from "./recall-gen";
import { episodeRubric, scoreExtraction, type ExtractionCase } from "./score";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOT = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";

function tmpStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mem-eval-"));
  const cfg = loadConfig({ DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host"), WORKSPACE: d });
  initLayout(cfg);
  fs.mkdirSync(path.join(cfg.dataRoot, "agents", BOT), { recursive: true });
  return { cfg, store: new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) }) };
}

/** Offline and deterministic: runs in `npm test`. */
export function runRecallEval(o: { ledger?: boolean } = {}): { precision: number; maxChars: number; emptyViolations: number; migrated: number } {
  const { cfg, store } = tmpStore();
  const index = new RecallIndex(path.join(cfg.hostPrivate, "memory-index.db"));
  const g = generateRecallCorpus(7);
  // Write the month files directly and index once (2,000 store.add calls would re-read and re-index the shard each time).
  const byMonth = new Map<string, string[]>();
  for (const f of g.facts) byMonth.set(f.date.slice(0, 7), [...(byMonth.get(f.date.slice(0, 7)) ?? []), renderLine({ date: f.date, kind: "fact", content: f.content })]);
  for (const [m, lines] of byMonth) writeTextAtomic(path.join(store.dir({ kind: "agent", botId: BOT }), "log", `${m}.md`), `${LOG_HEADER}${lines.join("\n")}\n`);
  reindexAll({ index, store, botIds: [BOT] });
  // With the ledger: the boot migration imports the 2,000 facts (provenance "migrated"); recall then reads both.
  const ledger = o.ledger ? new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => Date.UTC(2026, 8, 20)) : undefined;
  const migrated = ledger ? migrateMemoryToLedger({ store, ledger, botIds: [BOT] }) : 0;
  const deps = { index, store, ledger, frozen: () => new Set<string>(), nameOf: () => "Eval", now: () => Date.UTC(2026, 8, 20) };
  let sum = 0, maxChars = 0;
  for (const q of g.queries) {
    const r = recallFor(deps, BOT, q.text);
    const got = r.facts.map((f) => f.content);
    sum += got.length ? got.filter((c) => q.relevant.includes(c)).length / got.length : 0;
    maxChars = Math.max(maxChars, (r.block ?? "").split("\n").filter((l) => l.startsWith("- ")).join("\n").length);
  }
  const emptyViolations = g.empty.filter((t) => recallFor(deps, BOT, t).block !== null).length;
  index.close();
  ledger?.dispose();
  return { precision: sum / g.queries.length, maxChars, emptyViolations, migrated };
}

async function extractionRun(model: OneShotModel, cases: ExtractionCase[]) {
  const out: { c: ExtractionCase; lines: { tag: string; content: string }[] }[] = [];
  for (const c of cases) {
    const { store } = tmpStore();
    for (const e of c.existing ?? []) store.add({ kind: "agent", botId: BOT }, { content: e, tier: "profile", kind: "fact" });
    let raw = "";
    const spy: OneShotModel = { complete: async (p) => (raw = await model.complete(p)) };
    await new MemoryExtractor({ store, model: spy, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper" }).run(BOT, { user: c.user, bot: c.bot });
    const shown = store.all({ kind: "agent", botId: BOT });
    const parsed = parseExtraction(raw, [...shown, ...(c.existing ?? []).map((content) => ({ id: "", date: "2026-09-01", kind: "fact" as const, content, tier: "profile" as const, createdAt: 0 }))]);
    out.push({ c, lines: [...parsed.adds.map((a) => ({ tag: a.kind === "note" ? "note" : a.tier, content: a.content })), ...parsed.removes.map((r) => ({ tag: "remove", content: r }))] });
  }
  return out;
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  await useSavedAuth(cfg); // the box's saved API key, through a key proxy of its own
  const flags = loadConformance(cfg.hostPrivate)?.flags;
  const model = new SdkOneShot({ env: buildBotEnv({ cfg, botId: "memory-eval" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: flags ? claudeExecutableFor(flags.runAs, cfg) : undefined });
  const cases = fs.readFileSync(path.join(here, "evals", "memory", "extraction.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ExtractionCase);
  let ok = true;
  for (let run = 1; run <= 3; run++) {
    const results = await extractionRun(model, cases);
    const s = scoreExtraction(results);
    if (process.env.EVAL_VERBOSE) for (const { c, lines } of results) {
      const hit = (e: ExtractionCase["expect"][number], l: { tag: string; content: string }) => e.tag === l.tag && e.all.every((k) => l.content.toLowerCase().includes(k.toLowerCase()));
      for (const l of lines) if (!c.expect.some((e) => hit(e, l))) console.log(`  ${(c.accept ?? []).some((e) => hit(e, l)) ? "ACCEPTED" : "EXTRA"} ${c.id} ${l.tag}: ${l.content}`);
      for (const e of c.expect) if (!lines.some((l) => hit(e, l))) console.log(`  MISSED ${c.id} ${e.tag}: ${e.all.join(" + ")}`);
    }
    console.log(`extraction run ${run}: precision ${s.precision.toFixed(3)} recall ${s.recall.toFixed(3)} forbidden ${s.forbiddenHits.length}`);
    for (const h of s.forbiddenHits) console.log(`  FORBIDDEN ${h}`);
    ok &&= s.precision >= 0.9 && s.recall >= 0.8 && s.forbiddenHits.length === 0;
  }
  const eps = fs.readFileSync(path.join(here, "evals", "memory", "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; turns: { at: string; user: string; bot: string }[] });
  let pass = 0;
  for (const e of eps) {
    const out = (await model.complete({ system: fillTemplate(loadPrompt("orig/memory-episode.md"), { botName: "Piper" }), user: JSON.stringify({ today: e.turns.at(-1)!.at, botName: "Piper", turns: e.turns }), tag: { purpose: "episode", botId: "memory-eval" } })).trim();
    const r = out === "NONE" ? { dates: true, past: true, sentences: true, noSecrets: true } : episodeRubric(out);
    const good = Object.values(r).every(Boolean) && (e.id !== "e03" || out === "NONE");
    if (good) pass++;
    console.log(`${e.id} ${good ? "PASS" : "FAIL"}: ${out}`);
  }
  console.log(`episodes: ${pass}/10 (human check of the lines above is part of the gate)`);
  const rec = runRecallEval({ ledger: true });
  console.log(`recall: precision@6 ${rec.precision.toFixed(3)}, max ${rec.maxChars} chars, empty violations ${rec.emptyViolations}`);
  ok &&= pass >= 9 && rec.precision >= 0.6 && rec.maxChars <= 900 && rec.emptyViolations === 0;
  console.log(ok ? "MEMORY EVAL PASS" : "MEMORY EVAL FAIL");
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main().then((c) => process.exit(c));
