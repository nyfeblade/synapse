import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OneShotModel } from "../../brain/one-shot";
import { loadConfig } from "../../config";
import { MemoryExtractor } from "../../memory/extractor";
import { FactLedger } from "../../memory/ledger";
import { MemoryStore } from "../../memory/memory-store";
import { recallFor } from "../../memory/recall";
import { RecallIndex } from "../../memory/recall-index";
import { reindexAll, startRecallSync } from "../../memory/recall-sync";
import { initLayout } from "../../store/layout";
import { generateSupersedeSet, type Template } from "./supersede-gen";

const BOT = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const DAY = 86_400_000;

/**
 * The superseded-fact recall eval, offline and deterministic. The facts go in the way production writes
 * them: through MemoryExtractor, with a scripted model standing in for Haiku, in batches of three.
 *   extractorRemoves = false: the model states the new value and forgets to remove the old one (it
 *                            never saw it, or missed it). Keyword recall has both lines.
 *   extractorRemoves = true:  the model emits `remove: <old>` and the new line, as the prompt asks.
 * Scores: current (the new value and not the old), past ("before" questions get the old value),
 * traps (multi-valued facts keep every value), and the char size of the recalled lines.
 */
export interface SupersedeScore { current: number; past: number; traps: number; maxChars: number; byTemplate: Record<string, { current: number; past: number; n: number }> }

export async function runSupersedeEval(o: { extractorRemoves: boolean; ledger: boolean; seed?: number }): Promise<SupersedeScore> {
  const g = generateSupersedeSet(o.seed ?? 11);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mem-supersede-"));
  const cfg = loadConfig({ DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host"), WORKSPACE: d });
  initLayout(cfg);
  fs.mkdirSync(path.join(cfg.dataRoot, "agents", BOT), { recursive: true });
  let now = Date.UTC(2026, 0, 5);
  const ledger = o.ledger ? new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => now) : undefined;
  const store = new MemoryStore({ cfg, now: () => now, ledger });
  const index = new RecallIndex(path.join(cfg.hostPrivate, "memory-index.db"));
  reindexAll({ index, store, botIds: [BOT] });
  const stop = startRecallSync({ index, store });
  let script = "";
  const model: OneShotModel = { complete: async () => script };
  const extractor = new MemoryExtractor({ store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => now });
  const run = async (lines: string[], says: string[]) => {
    script = lines.length ? lines.join("\n") : "NONE";
    await extractor.run(BOT, says.map((s) => ({ user: `Please remember this: ${s}`, bot: "Noted." })));
  };
  const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  // Winter: distractors and the old values; spring: the traps; summer: the new values.
  for (const c of chunks(g.distractors, 3)) { await run(c.map((s) => `log: ${s}`), c); now += DAY / 4; }
  for (const c of chunks(g.chains, 3)) { await run(c.map((x) => `${x.tier}: ${x.old}`), c.map((x) => x.old)); now += DAY; }
  for (const t of g.traps) { await run([`profile: ${t.facts[0]}`], [t.facts[0]!]); now += 7 * DAY; await run([`profile: ${t.facts[1]}`], [t.facts[1]!]); }
  now = Date.UTC(2026, 5, 1);
  for (const c of chunks(g.chains, 3)) {
    await run(c.flatMap((x) => (o.extractorRemoves ? [`remove: ${x.old}`, `${x.tier}: ${x.new}`] : [`${x.tier}: ${x.new}`])), c.map((x) => x.new));
    now += 2 * DAY;
  }
  now = Date.UTC(2026, 8, 1);
  const deps = { index, store, ledger, frozen: () => new Set<string>(), nameOf: () => "Piper", now: () => now };
  let cur = 0, past = 0, traps = 0, maxChars = 0;
  const byTemplate: SupersedeScore["byTemplate"] = {};
  const ask = (q: string) => {
    const r = recallFor(deps, BOT, q);
    maxChars = Math.max(maxChars, (r.block ?? "").split("\n").filter((l) => l.startsWith("- ")).join("\n").length);
    return r.block ?? "";
  };
  for (const c of g.chains) {
    const a = ask(c.current), b = ask(c.past);
    const okC = a.includes(c.newValue) && !a.includes(c.oldValue) ? 1 : 0;
    const okP = b.includes(c.oldValue) ? 1 : 0;
    cur += okC; past += okP;
    const t = (byTemplate[c.template as Template] ??= { current: 0, past: 0, n: 0 });
    t.current += okC; t.past += okP; t.n++;
  }
  for (const t of g.traps) { const a = ask(t.question); if (t.values.every((v) => a.includes(v))) traps++; }
  stop();
  index.close();
  ledger?.dispose();
  return { current: cur / g.chains.length, past: past / g.chains.length, traps: traps / g.traps.length, maxChars, byTemplate };
}
