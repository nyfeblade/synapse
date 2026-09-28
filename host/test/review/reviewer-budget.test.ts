import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speed plan #2 (tool-loop budget case 5): a verdict costs ONE model request with at most 256 output tokens.
 * Measured 2026-09-24 on eval case E02: the old prompt's "work through these steps" made Haiku write a ~450-token
 * STEP 1…4 walkthrough as plain text before its StructuredOutput call (613 output tokens, ~7.6 ms each). With an
 * output cap alone the CLI answers "Output token limit hit. Resume directly…" and makes a SECOND request.
 */
type Msg = Record<string, unknown>;
let script: Msg[] = [];
const queries: Array<{ options: Record<string, unknown> }> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    queries.push({ options });
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        for (const m of script) yield m;
      },
    };
  },
}));

const { SdkModelReviewer, VERDICT_SCHEMA } = await import("../../review/model-reviewer");
const { LIMITS } = await import("@synapse/shared");
const { loadPrompt } = await import("../../prompts/index");

const VERDICT = {
  decision: "allow", risk_tier: 1, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: ["A2"],
  injection_suspected: false, confidence: 0.95, reason: "Installs lodash in /workspace/app as you asked.", proposed_allow_rule: null,
};
const assistant = (id: string, content: Msg[]): Msg => ({ type: "assistant", message: { id, role: "assistant", content } });
const toolUse = (id: string): Msg => assistant(id, [{ type: "tool_use", id: "tu1", name: "StructuredOutput", input: VERDICT }]);
const result: Msg = { type: "result", subtype: "success", structured_output: { verdict: VERDICT } };

describe("reviewer budget (speed plan #2, tool-loop budget case 5)", () => {
  beforeEach(() => { queries.length = 0; script = []; });

  it("asks for at most 256 output tokens per verdict", async () => {
    expect(LIMITS.reviewerMaxOutputTokens).toBeLessThanOrEqual(256);
    script = [toolUse("msg_1"), result];
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 0 });
    await r.review({}, new AbortController().signal);
    const env = queries[0]?.options.env as Record<string, string>;
    expect(Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)).toBeGreaterThan(0);
    expect(Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)).toBeLessThanOrEqual(256);
  });

  it("makes one CLI query and one model request per verdict", async () => {
    script = [toolUse("msg_1"), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "Structured output provided successfully" }] } }, result];
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 0 });
    expect(await r.review({}, new AbortController().signal)).toEqual(VERDICT);
    expect(queries).toHaveLength(1);
  });

  it("refuses a verdict that took a second model request (the CLI's output-cap continuation)", async () => {
    script = [
      assistant("msg_1", [{ type: "text", text: "STEP 1 · Ask-first rules …" }]),
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing." }] } },
      toolUse("msg_2"),
      result,
    ];
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 0 });
    await expect(r.review({}, new AbortController().signal)).rejects.toThrow(/more than one model request/);
  });

  it("the prompt makes the StructuredOutput call the whole reply, with no written walkthrough", () => {
    const p = loadPrompt("orig/reviewer.md");
    expect(p).not.toMatch(/Work through these steps/);
    expect(p).toMatch(/StructuredOutput/);
    expect(p).toMatch(/no text before or after/i);
  });

  it("sends the whole verdict as one tool parameter (each top-level parameter costs ~20 output tokens)", async () => {
    script = [toolUse("msg_1"), result];
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 0 });
    await r.review({}, new AbortController().signal);
    const fmt = queries[0]?.options.outputFormat as { schema: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(fmt.schema.properties)).toEqual(["verdict"]);
    expect(fmt.schema.required).toEqual(["verdict"]);
    expect(fmt.schema.properties.verdict).toBe(VERDICT_SCHEMA);
  });

  it("keeps the verdict's analysis fields ahead of the decision, so the model fills them before it decides", () => {
    const order = Object.keys(VERDICT_SCHEMA.properties);
    for (const f of ["matched_ask_rule_ids", "floor_category", "matched_allow_rule_ids", "injection_suspected", "risk_tier"]) {
      expect(order.indexOf(f)).toBeLessThan(order.indexOf("decision"));
    }
  });
});
