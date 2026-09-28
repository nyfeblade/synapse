import { describe, expect, it } from "vitest";
import {
  CALL_REPLIES, DEFAULT_SAVINGS, LONG_CONTEXT_ESCALATE_TOKENS, LONG_CONTEXT_MODES, PROMPT_CACHE_TTLS, savingPhrase, spawnModelId, voiceLowEffort,
} from "../src/index";

// saving-settings: Synapse's cost-saving choices as user settings (Settings → Usage → Savings).
describe("Savings settings: the defaults are today's behaviour", () => {
  it("defaults: 1-hour cache, the call effort switch as it is, long context on", () => {
    expect(DEFAULT_SAVINGS).toEqual({ promptCacheTtl: "1h", callReplies: "default", longContext: "on" });
    expect(PROMPT_CACHE_TTLS).toEqual(["1h", "5m"]);
    expect(CALL_REPLIES).toEqual(["default", "fast", "match"]);
    expect(LONG_CONTEXT_MODES).toEqual(["on", "when-needed"]);
  });
});

describe("Long-context model: spawnModelId", () => {
  it("On (default): Sonnet / Opus 5.x spawn with [1m], exactly as before", () => {
    expect(spawnModelId("claude-sonnet-5")).toBe("claude-sonnet-5[1m]");
    expect(spawnModelId("claude-sonnet-5", { longContext: "on" })).toBe("claude-sonnet-5[1m]");
    expect(spawnModelId("claude-opus-5-5", { longContext: "on" })).toBe("claude-opus-5-5[1m]");
  });

  it("Only when needed: standard context until the chat escalated, then [1m]", () => {
    expect(spawnModelId("claude-sonnet-5", { longContext: "when-needed" })).toBe("claude-sonnet-5");
    expect(spawnModelId("claude-opus-5", { longContext: "when-needed", escalated: false })).toBe("claude-opus-5");
    expect(spawnModelId("claude-sonnet-5", { longContext: "when-needed", escalated: true })).toBe("claude-sonnet-5[1m]");
  });

  it("models with no [1m] arm are untouched either way", () => {
    expect(spawnModelId("claude-haiku-4-5-20251001", { longContext: "when-needed", escalated: true })).toBe("claude-haiku-4-5-20251001");
    expect(spawnModelId("claude-fable-5-1", { longContext: "on" })).toBe("claude-fable-5-1");
  });

  it("escalates below the CLI's own auto-compact point for a 200k model (200k minus its 33k buffer)", () => {
    expect(LONG_CONTEXT_ESCALATE_TOKENS).toBeLessThan(200_000 - 33_000);
    expect(LONG_CONTEXT_ESCALATE_TOKENS).toBeGreaterThanOrEqual(150_000);
  });
});

describe("Call replies: which turns run at low effort", () => {
  const spoken = { voiceCall: true, callLive: true };
  const typedOnCall = { voiceCall: false, callLive: true };
  const typedNoCall = { voiceCall: false, callLive: false };

  it("Default: spoken turns only (today's behaviour)", () => {
    expect([spoken, typedOnCall, typedNoCall].map((t) => voiceLowEffort("default", t))).toEqual([true, false, false]);
  });

  it("Fast on the whole call: every turn while the call is live, typed ones too", () => {
    expect([spoken, typedOnCall, typedNoCall].map((t) => voiceLowEffort("fast", t))).toEqual([true, true, false]);
  });

  it("Match the Bot: never, so the effort never switches", () => {
    expect([spoken, typedOnCall, typedNoCall].map((t) => voiceLowEffort("match", t))).toEqual([false, false, false]);
  });
});

describe("the measured weekly figure", () => {
  it("reads as a saving, a cost or nothing, in whole dollars", () => {
    expect(savingPhrase(7.7)).toBe("≈ $8/week less at your usage");
    expect(savingPhrase(0.4)).toBe("≈ $0/week at your usage");
    expect(savingPhrase(-1.6)).toBe("≈ $2/week more at your usage");
  });
});
