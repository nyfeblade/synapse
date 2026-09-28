import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../../approvals/approval-gate";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SseHub } from "../../gateway/sse-hub";
import { CircuitBreaker } from "../../review/circuit";
import { VerdictCache } from "../../review/cache";
import { ReviewLog } from "../../review/log";
import type { ModelReviewer } from "../../review/model-reviewer";
import { Reviewer } from "../../review/reviewer";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

/**
 * coding-batched-reads: when an engineering Bot puts several independent tool calls in ONE response, the CLI fires
 * one PreToolUse hook per call at once; the gate must judge them concurrently, or batching saves model calls but
 * pays the reviewer's latency N times. Real ApprovalGate + real Reviewer; the model is a stub with a fixed delay.
 */
const REVIEW_MS = 150;

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const ws = cfg.workspace;
  const repo = path.join(ws, "repos", "app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  for (const f of ["a.ts", "b.ts", "c.ts"]) fs.writeFileSync(path.join(repo, "src", f), "");
  fs.mkdirSync(path.join(ws, "loose"), { recursive: true });
  fs.writeFileSync(path.join(ws, "loose", "gen.py"), "print(1)\n"); // a script the review binds to (not a git tree: no fast path)

  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  bots.updateSettings(id, { engineeringMode: true });
  let calls = 0, live = 0, peak = 0;
  const model: ModelReviewer = {
    review: async () => {
      calls++; live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, REVIEW_MS));
      live--;
      return { decision: "allow", risk_tier: 1, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: [], injection_suspected: false, confidence: 0.9, reason: "Routine.", proposed_allow_rule: null };
    },
  };
  let t = 0;
  const reviewer = new Reviewer({
    settings, model, cache: new VerdictCache(() => t), circuit: new CircuitBreaker(() => t),
    log: new ReviewLog(path.join(cfg.hostPrivate, "reviewer.log.jsonl"), () => t), now: () => t++, timeZone: () => "UTC", workspace: ws,
  });
  const slot = newSlot({ botId: id, requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {} });
  let n = 0;
  /** One response's tool_use blocks, hooked the way the CLI does it: all at once. */
  const batch = async (commands: string[], cwd: string) => {
    const t0 = performance.now();
    const ds = await Promise.all(commands.map((command) => gate.preToolUse(id, { toolName: "Bash", input: { command }, toolUseId: `tu${n++}`, cwd })));
    return { ms: performance.now() - t0, decisions: ds.map((d) => d.decision) };
  };
  return { batch, repo, loose: path.join(ws, "loose"), stats: () => ({ calls, peak }) };
}

describe("parallel tool_use blocks are reviewed concurrently (coding-batched-reads)", () => {
  it("a batch of 3 reads in the work tree takes the fast path: no reviewer call, no wait", async () => {
    const { batch, repo, stats } = setup();
    const r = await batch(["cat src/a.ts src/b.ts", "grep -rn foo src", "sed -n '1,40p' src/c.ts"], repo);
    process.stdout.write(`batch of 3 reads (fast path): ${r.ms.toFixed(1)} ms, reviewer calls ${stats().calls}\n`);
    expect(r.decisions).toEqual(["allow", "allow", "allow"]);
    expect(stats().calls).toBe(0);
    expect(r.ms).toBeLessThan(REVIEW_MS);
  });

  it("a batch of 3 calls that need the reviewer is judged concurrently: ~1 review of latency, not 3", async () => {
    const { batch, loose, stats } = setup();
    const r = await batch(["python3 gen.py --part 1", "python3 gen.py --part 2", "python3 gen.py --part 3"], loose);
    process.stdout.write(`batch of 3 reviewed calls: ${r.ms.toFixed(0)} ms (one review = ${REVIEW_MS} ms), peak concurrent reviews ${stats().peak}\n`);
    expect(r.decisions).toEqual(["allow", "allow", "allow"]);
    expect(stats().calls, "each call reached the model reviewer").toBe(3);
    expect(stats().peak, "the three reviews ran at the same time").toBe(3);
    expect(r.ms).toBeLessThan(2 * REVIEW_MS);
  });
});
