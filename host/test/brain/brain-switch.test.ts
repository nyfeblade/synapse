import { describe, expect, it } from "vitest";
import { BrainSwitch, brainKindOf } from "../../brain/brain-switch";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { FakeBrain } from "../../brain/fake-brain";
import type { BrainWiring, ProcState, TurnInput } from "../../brain/types";

const wiring: BrainWiring = {
  preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
  stop: async () => ({ block: false }), botTools: () => [], flags: () => DEFAULT_FLAGS,
  turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
};
const input = (model: string, text = "hi"): TurnInput => ({ prompt: [{ text }], hidden: false, lane: "user", source: "user", silenceAllowed: false, requestId: "r", systemAppend: "", model, autoReviewEpoch: "continue" });

function setup(start: string, sid: string | null = null) {
  let model = start;
  let session = sid;
  const built: string[] = [];
  const claude = new FakeBrain("b", wiring, () => [{ text: "claude" }]);
  const provider = new FakeBrain("b", wiring, () => [{ text: "provider" }]);
  const sw = new BrainSwitch({
    botId: "b", model: () => model,
    claude: () => { built.push("claude"); return claude; },
    provider: () => { built.push("provider"); return provider; },
    getSessionId: () => session, clearSessionId: () => { session = null; }, restoreBlock: () => "RESTORE",
  });
  return { sw, claude, provider, built, setModel: (m: string) => { model = m; }, session: () => session, setSession: (s: string | null) => { session = s; } };
}

describe("BrainSwitch", () => {
  it("kinds: a Claude ModelId is the Claude brain, <provider>:<id> the provider brain", () => {
    expect(brainKindOf("claude-sonnet-5")).toBe("claude");
    expect(brainKindOf(undefined)).toBe("claude");
    expect(brainKindOf("openai:gpt-5.1")).toBe("provider");
    expect(brainKindOf("ollama:qwen3:4b")).toBe("provider");
    expect(brainKindOf("anthropic:claude-x")).toBe("claude");
    expect(brainKindOf("nonsense:x")).toBe("claude");
  });

  it("a Claude Bot only ever builds and runs the Claude brain, with its prompt untouched", async () => {
    const s = setup("claude-sonnet-5", "8c0b-uuid");
    const r = await s.sw.runTurn(input("claude-sonnet-5"), () => {});
    expect(r.finalText).toBe("claude");
    expect(s.built).toEqual(["claude"]);
    expect(s.claude.inputs[0]!.prompt).toEqual([{ text: "hi" }]);
    expect(s.session()).toBe("8c0b-uuid");
  });

  it("switching kind cools the old brain, clears the session and leads with the restore block, once", async () => {
    const s = setup("claude-sonnet-5", "8c0b-uuid");
    const states: ProcState[] = [];
    s.sw.onStateChange((st) => states.push(st));
    await s.sw.runTurn(input("claude-sonnet-5"), () => {});
    expect(s.claude.procState).toBe("warm_idle");
    s.setModel("openai:gpt-x");
    const r = await s.sw.runTurn(input("openai:gpt-x", "next"), () => {});
    expect(r.finalText).toBe("provider");
    expect(s.claude.procState).toBe("cold");
    expect(s.session()).toBeNull();
    expect(s.provider.inputs[0]!.prompt).toEqual([{ text: "RESTORE" }, { text: "next" }]);
    s.setSession("prov-123");
    await s.sw.runTurn(input("openai:gpt-x", "again"), () => {});
    expect(s.provider.inputs[1]!.prompt).toEqual([{ text: "again" }]);
    expect(s.sw.active).toBe("provider");
    expect(states).toContain("cold");
  });

  it("a stored session of the other kind (model changed while the host was down) also starts fresh with the restore block", async () => {
    const s = setup("openai:gpt-x", "8c0b-claude-uuid");
    await s.sw.runTurn(input("openai:gpt-x"), () => {});
    expect(s.session()).toBeNull();
    expect(s.provider.inputs[0]!.prompt[0]).toEqual({ text: "RESTORE" });
    expect(s.built).toEqual(["provider"]);
  });

  it("forwards state, interrupt and cool to the active brain", async () => {
    const s = setup("claude-sonnet-5");
    expect(s.sw.procState).toBe("cold");
    expect(s.sw.processless).toBe(false);
    await s.sw.runTurn(input("claude-sonnet-5"), () => {});
    expect(s.sw.procState).toBe("warm_idle");
    await s.sw.cool("idle");
    expect(s.sw.procState).toBe("cold");
  });
});
