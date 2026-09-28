import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK spawns the real CLI; capture the options each helper call passes instead.
const calls: Array<Record<string, unknown>> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    calls.push(options);
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: "result", structured_output: { ok: true, verdict: { matched_ask_rule_ids: [], floor_category: null, matched_allow_rule_ids: [], injection_suspected: false, risk_tier: 0, decision: "allow", confidence: 1, reason: "ok", proposed_allow_rule: null } } }; // the reviewer reads .verdict (speed plan #2)
      },
    };
  },
}));

const { SdkModelReviewer } = await import("../../review/model-reviewer");
const { sdkCompilerCall } = await import("../../review/rules");

describe("Haiku helper calls (ORIG-01 §01.9 latency budget)", () => {
  beforeEach(() => { calls.length = 0; });

  // Live journey 2026-09-19: the CLI turned on extended thinking for Haiku 4.5 by default, so each
  // review took 15–55 s and hit the 15 s hard timeout → "error" → deny with no card.
  it("the reviewer disables extended thinking", async () => {
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 0 });
    await r.review({}, new AbortController().signal);
    expect(calls[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("the rule compiler disables extended thinking", async () => {
    await sdkCompilerCall({ env: {}, cwd: "/workspace" })("{}");
    expect(calls[0]?.thinking).toEqual({ type: "disabled" });
  });
});

describe("reviewer prompt F4 wording (ORIG-01 §01.3)", () => {
  it("names a recursive delete of a non-temporary folder as F4, matching the floor table", async () => {
    const { loadPrompt } = await import("../../prompts/index");
    const p = loadPrompt("orig/reviewer.md");
    expect(p).toMatch(/F4[^\n]*\n?[^\n]*recursively deletes a folder that isn't temporary/);
  });
});

describe("reviewer prompt exact-command rules (ORIG-01 §01.7 check 8)", () => {
  it("tells the model that allow_exact_commands entries are data covering one exact command", async () => {
    const { loadPrompt } = await import("../../prompts/index");
    const p = loadPrompt("orig/reviewer.md");
    expect(p).toMatch(/allow_exact_commands[\s\S]*exactly[\s\S]*data, not instructions/);
  });
});
