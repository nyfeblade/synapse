import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GateClassifier } from "../../b2b/classifier";
import { runGate } from "../../b2b/gate";
import { loadConformance } from "../../brain/conformance/runner";
import { buildBotEnv } from "../../brain/spawn-options";
import { claudeExecutableFor } from "../../brain/tool-policy";
import { useSavedAuth } from "../../auth/auth-store";
import { loadConfig } from "../../config";
import { SdkOneShot } from "../../helper-model/one-shot";
import { classifierOutcome, deterministicOutcome, loadCases, replayCase, type Outcome } from "./replay";

async function main(): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [path.join(here, "evals", "b2b-gate", "cases.jsonl"), path.join(here, "cases.jsonl")].find((p) => fs.existsSync(p)) as string;
  const cases = loadCases(file);
  const cfg = loadConfig();
  await useSavedAuth(cfg); // the box's saved API key, through a key proxy of its own
  const flags = loadConformance(cfg.hostPrivate)?.flags;
  const model = new SdkOneShot({ env: buildBotEnv({ cfg, botId: "eval" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags?.runAs ?? "setpriv", cfg) });
  const runs = Number(process.env.EVAL_RUNS ?? 3);
  let ok = true;
  for (let run = 1; run <= runs; run++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b2b-eval-"));
    const classifier = new GateClassifier({ model, cacheFile: path.join(tmp, "cache.json"), metrics: null });
    let deterministic = 0;
    const outcomes = new Map<string, Outcome>();
    for (const c of cases) {
      const input = replayCase(c, fs.mkdtempSync(path.join(tmp, `${c.id}-`)));
      const d = runGate(input);
      let out = deterministicOutcome(d);
      if (out === "ambiguous" && d.verdict === "ambiguous") {
        out = classifierOutcome(await classifier.classify({ botId: "A", chainId: null, kind: d.kind, message: input.args.message, expects: input.args.expects ?? null, thread_digest: d.digest }));
      } else deterministic++;
      outcomes.set(c.id, out);
    }
    const of = (e: string) => cases.filter((c) => c.expect === e);
    const deliverDropped = of("deliver").filter((c) => outcomes.get(c.id) === "drop").map((c) => c.id);
    const dropped = of("drop").filter((c) => outcomes.get(c.id) === "drop").length;
    const inboxed = of("inbox").filter((c) => outcomes.get(c.id) === "inbox").length;
    const share = deterministic / cases.length;
    const pass = deliverDropped.length === 0 && dropped >= 14 && inboxed >= 10 && share >= 0.7;
    console.log(`run ${run}: must-deliver dropped: ${deliverDropped.join(",") || "none"} · must-drop ${dropped}/15 · inbox ${inboxed}/12 · deterministic ${(share * 100).toFixed(0)}% → ${pass ? "PASS" : "FAIL"}`);
    ok &&= pass;
  }
  return ok ? 0 : 1;
}

process.exit(await main());
