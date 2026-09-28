import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConformance } from "../../brain/conformance/runner";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { buildBotEnv } from "../../brain/spawn-options";
import { claudeExecutableFor } from "../../brain/tool-policy";
import { useSavedAuth } from "../../auth/auth-store";
import { loadConfig } from "../../config";
import { Dreamer } from "../../memory/dreaming/dreamer";
import { DreamMemoryPort, factId } from "../../memory/dreaming/port";
import { SdkDreamLlm } from "../../memory/dreaming/sdk-llm";
import { judge, type EvalCase } from "./judge";

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = <T>(f: string): T[] => fs.readFileSync(path.join(here, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const cfg = loadConfig();
await useSavedAuth(cfg); // the box's saved API key, through a key proxy of its own
const flags = loadConformance(cfg.hostPrivate)?.flags ?? DEFAULT_FLAGS;
const llm = new SdkDreamLlm({ env: buildBotEnv({ cfg, botId: "eval-dreaming" }), cwd: cfg.workspace, pathToClaudeCodeExecutable: claudeExecutableFor(flags.runAs, cfg) });

let passed = 0, explicitChanged = 0, credentials = 0;
for (const c of lines<EvalCase>("cases.jsonl")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-eval-"));
  const mem = path.join(root, "agents", "b", "memory");
  fs.mkdirSync(path.join(mem, "log"), { recursive: true });
  const line = (m: EvalCase["memories"][number]) => `- (${m.date}) ${m.kind === "log" ? "[note] " : ""}${m.content}`;
  const write = (ms: EvalCase["memories"]) => {
    fs.writeFileSync(path.join(mem, "profile.md"), ["# Profile", ...ms.filter((m) => m.kind === "profile").map(line)].join("\n") + "\n");
    fs.writeFileSync(path.join(mem, "log", `${c.today.slice(0, 7)}.md`), ms.filter((m) => m.kind === "log").map(line).join("\n") + "\n");
  };
  const now = Date.parse(`${c.today}T12:00:00Z`);
  const port = new DreamMemoryPort(root, () => now);
  write(c.memories.filter((m) => m.origin === "legacy"));
  port.ensureInit("b");
  write(c.memories);
  fs.writeFileSync(path.join(mem, ".meta.json"), JSON.stringify({ byId: Object.fromEntries(c.memories.filter((m) => m.strength !== undefined).map((m) => [factId(m.content), { strength: m.strength }])) }));
  const before = port.facts("b").map((f) => ({ content: f.content, kind: f.kind, origin: f.origin }));
  const d = new Dreamer({ port, llm, now: () => now, mode: () => "dreaming", busy: () => false, botName: () => "Planner", botIds: () => ["b"], ladder: () => ({ level: () => "L0", usagePct: () => null, allowsBackground: () => true }) });
  for (const e of c.evidence ?? []) d.onSettled({ botId: "b", hidden: false, userText: e.user, sentTexts: [e.assistant], result: { finalText: "" } } as never);
  const result = await d.runPass("b", c.mode);
  d.stop();
  const j = judge(c, before, port.facts("b").map((f) => ({ content: f.content, kind: f.kind })));
  passed += j.pass ? 1 : 0;
  explicitChanged += j.explicitChanged ? 1 : 0;
  credentials += j.credentialStored ? 1 : 0;
  console.log(`${j.pass ? "PASS" : "FAIL"} ${c.name} (${result})${j.why.length ? ` — ${j.why.join("; ")}` : ""}`);
}

let caught = 0;
const corrupt = lines<{ name: string; today: string; currentMemories: unknown[]; evidence: unknown[]; proposedChanges: unknown[] }>("corrupt.jsonl");
for (const c of corrupt) {
  const r = (await llm.verify({ today: c.today, currentMemories: c.currentMemories, evidence: c.evidence, proposedChanges: c.proposedChanges })) as { approved?: unknown };
  const ok = r?.approved !== true;
  caught += ok ? 1 : 0;
  console.log(`${ok ? "CAUGHT" : "MISSED"} ${c.name}`);
}

const pass = passed >= 23 && explicitChanged === 0 && credentials === 0 && caught >= 9;
console.log(`\nend states ${passed}/25 · explicit changed ${explicitChanged} · credentials ${credentials} · verifier caught ${caught}/${corrupt.length} → ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
