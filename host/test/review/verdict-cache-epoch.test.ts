import path from "node:path";
import { describe, expect, it } from "vitest";
import { VerdictCache } from "../../review/cache";
import { CircuitBreaker } from "../../review/circuit";
import { ReviewLog } from "../../review/log";
import type { ModelReviewer } from "../../review/model-reviewer";
import { Reviewer } from "../../review/reviewer";
import { analyzeShell } from "../../review/static";
import type { ReviewRequest, Verdict } from "../../review/types";
import { HostSettingsStore } from "../../store/host-settings";
import { tmpConfig } from "../helpers";

/**
 * Security review of speed plan #3 (ruling: removed). A cached allow must not outlive a new user message past the
 * 60 s cache, at ANY tier: an unmodelled program's behaviour (make, pytest, a script) depends on files the
 * fingerprint doesn't bind, so a new message always sends it back to the model.
 */
const V = (risk_tier: number): Verdict => ({
  matched_ask_rule_ids: [], floor_category: null, matched_allow_rule_ids: [], injection_suspected: false, risk_tier,
  decision: "allow", confidence: 0.95, reason: "Routine step.", proposed_allow_rule: null,
});

describe("verdict cache and new user messages (regression)", () => {
  for (const tier of [0, 1]) {
    it(`a new user message invalidates a tier-${tier} cached allow`, async () => {
      const cfg = tmpConfig();
      let t = 0;
      let calls = 0;
      const model: ModelReviewer = { review: async () => { calls++; return V(tier); } };
      const r = new Reviewer({
        settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")), model, cache: new VerdictCache(() => t), circuit: new CircuitBreaker(() => t),
        log: new ReviewLog(path.join(cfg.hostPrivate, "reviewer.log.jsonl"), () => t), now: () => t, timeZone: () => "UTC",
      });
      const command = "make test";
      const req = (epoch: number): ReviewRequest => ({
        botId: "b", botName: "Piper", botDescription: "", surface: "box_shell", toolName: "mcp__bot__Shell",
        target: { action: "shell", arguments: { command }, enrichment: null }, origin: "user",
        context: { user_messages: ["run the tests"], assistant_messages: [], question_answers: [], untrusted_excerpts: [] },
        userMessageEpoch: epoch, staticResult: analyzeShell(command, { workspace: "/workspace" }), fingerprint: "fp:make", paths: [],
      });
      expect(await r.review(req(1))).toMatchObject({ stage: "model" });
      t += 5 * 60_000;
      expect(await r.review(req(1))).toMatchObject({ stage: "cache" }); // same message: tier ≤ 1 allow lives on (§01.8)
      expect(await r.review(req(2))).toMatchObject({ stage: "model" }); // new message: back to the model
      expect(calls).toBe(2);
    });
  }
});
