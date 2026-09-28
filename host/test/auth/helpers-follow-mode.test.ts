import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK spawns the real CLI; capture the env each helper call is spawned with instead.
const envs: Array<Record<string, string | undefined>> = [];
/** The env of each process that actually answered a call (a prewarmed one only answers when it is used). */
const answered: Array<Record<string, string | undefined>> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: { env: Record<string, string | undefined> } }) => {
    envs.push(options.env);
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        answered.push(options.env);
        yield { type: "result", subtype: "success", result: "{\"ok\":true}", structured_output: { ok: true, verdict: { matched_ask_rule_ids: [], floor_category: null, matched_allow_rule_ids: [], injection_suspected: false, risk_tier: 0, decision: "allow", confidence: 1, reason: "ok", proposed_allow_rule: null } } }; // the reviewer reads .verdict (speed plan #2)
      },
    };
  },
}));

const { setAuthSource } = await import("../../auth/auth-env");
const { SdkModelReviewer } = await import("../../review/model-reviewer");
const { sdkCompilerCall } = await import("../../review/rules");
const { SdkOneShot } = await import("../../brain/one-shot");
const { SdkOneShot: HelperOneShot } = await import("../../helper-model/one-shot");
const { SdkDreamLlm } = await import("../../memory/dreaming/sdk-llm");

const KEY1 = "sk-ant-api03-" + "H".repeat(80) + "abcd";
const KEY2 = "sk-ant-api03-" + "J".repeat(80) + "efgh";
const OAUTH = "sk-ant-oat01-" + "T".repeat(60);
let key = KEY1;
let gen = 0;
beforeEach(() => { envs.length = 0; answered.length = 0; key = KEY1; gen = 0; setAuthSource({ apiKey: () => key, generation: () => gen }); });
afterEach(() => setAuthSource(null));
const switchTo = (k: string) => { key = k; gen++; };
const on = (k: string) => (e: Record<string, string | undefined> | undefined) => e?.ANTHROPIC_API_KEY === k && e.CLAUDE_CODE_OAUTH_TOKEN === undefined;
const onApiKey = on(KEY2);
const onSubscription = on(KEY1); // the first key; a stray Claude login in the built env never survives either

describe("helper-model calls built once at boot follow a new API key on their next call", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, BOT_ID: "helper" };

  it("the reviewer: processes prewarmed before the switch are not used after it", async () => {
    const r = new SdkModelReviewer({ env, cwd: "/workspace", prewarm: 2 });
    expect(envs.length).toBe(2);
    expect(envs.every(onSubscription)).toBe(true);
    switchTo(KEY2);
    await r.review({}, new AbortController().signal);
    // The review ran on a process opened after the switch (the stale warm ones were closed).
    expect(answered).toHaveLength(1);
    expect(onApiKey(answered[0])).toBe(true);
    r.dispose();
  });

  it("memory extraction, structured helpers, dreaming and the rule compiler", async () => {
    const mem = new SdkOneShot({ env, cwd: "/w" });
    const helper = new HelperOneShot({ env, cwd: "/w" });
    const dream = new SdkDreamLlm({ env, cwd: "/w" });
    const compile = sdkCompilerCall({ env, cwd: "/w" });
    const all = async () => {
      await mem.complete({ system: "s", user: "u", tag: { purpose: "extraction", botId: null } });
      await helper.run({ prompt: "orig/b2b-gate.md", input: {}, schema: {} } as never);
      await dream.verify({});
      await compile("{}").catch(() => {});
    };
    await all();
    expect(envs.length).toBe(4);
    expect(envs.every(onSubscription)).toBe(true);
    switchTo(KEY2);
    await all();
    expect(envs.slice(4).every(onApiKey)).toBe(true);
    switchTo(KEY1);
    await all();
    expect(envs.slice(8).every(onSubscription)).toBe(true);
  });
});
