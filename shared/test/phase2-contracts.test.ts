import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LIMITS, STR, contextWindow,
  type BotSummary, type GatewayCommands, type HostSettingsView, type SendMessagePayload, type TranscriptEntry,
} from "../src/index";

describe("Phase 2 limits (§5.1, §9.0)", () => {
  it("carries the attachment, memory, context, skill, search and notification constants", () => {
    expect(LIMITS.attachmentsPerMessage).toBe(6);
    expect(LIMITS.attachmentDocMaxBytes).toBe(25 * 1024 * 1024);
    expect(LIMITS.attachmentVideoMaxBytes).toBe(200 * 1024 * 1024);
    expect(LIMITS.attachmentStageMaxBytes).toBe(50 * 1024 * 1024);
    expect(LIMITS.uploadChunkBytes).toBe(512 * 1024);
    expect(LIMITS.memoryFactMax).toBe(500);
    expect([LIMITS.memAgentProfileMax, LIMITS.memAgentRecentMax, LIMITS.memAgentRecentChars]).toEqual([100, 30, 4000]);
    expect([LIMITS.memUserProfileMax, LIMITS.memUserProfileChars, LIMITS.memUserRecentMax, LIMITS.memUserRecentChars]).toEqual([50, 4000, 15, 2000]);
    expect([LIMITS.memProjectProfileMax, LIMITS.memProjectProfileChars, LIMITS.memProjectRecentMax, LIMITS.memProjectRecentChars, LIMITS.memProjectsMax]).toEqual([25, 2500, 10, 1500, 3]);
    expect([LIMITS.episodeEveryTurns, LIMITS.episodePendingMax]).toEqual([6, 64]);
    expect([LIMITS.recallMaxFacts, LIMITS.recallMaxChars, LIMITS.recallMinBm25n, LIMITS.recallMaxTerms]).toEqual([6, 900, 0.35, 12]);
    expect([LIMITS.idleCompactRatio, LIMITS.idleCompactAfterMs, LIMITS.compactEveryTurns, LIMITS.selfSummaryRatio, LIMITS.restoreMaxChars]).toEqual([0.7, 30_000, 1000, 0.9, 6000]);
    expect([LIMITS.rolloverBytes, LIMITS.rolloverCompactions, LIMITS.rolloverResumeP50Ms]).toEqual([64 * 1024 * 1024, 25, 8000]);
    expect([LIMITS.skillIdMax, LIMITS.skillNameMax, LIMITS.skillDescriptionMax, LIMITS.skillBodyMax, LIMITS.skillInjectMax]).toEqual([64, 80, 1536, 100_000, 8000]);
    expect([LIMITS.searchBodyMax, LIMITS.searchTermsMax, LIMITS.searchPerBot, LIMITS.searchResultsMax, LIMITS.searchSnippetTokens]).toEqual([20_000, 8, 5, 50, 16]);
    expect([LIMITS.notifyThrottleMs, LIMITS.notifyBodyMax, LIMITS.reactionEmojiMax, LIMITS.reactionQuoteMax]).toEqual([5000, 140, 16, 80]);
  });
});

describe("context window (ORIG-07 §07.1)", () => {
  it("is 200k, or 1M for [1m] models", () => {
    expect(contextWindow("claude-sonnet-5")).toBe(200_000);
    expect(contextWindow("claude-sonnet-5[1m]")).toBe(1_000_000);
  });
});

describe("spawn model (1M thread)", () => {
  it("gives Sonnet and Opus the 1M suffix and leaves helpers on the 200k id", async () => {
    const { spawnModelId, contextWindow } = await import("../src/index");
    expect(spawnModelId("claude-sonnet-5")).toBe("claude-sonnet-5[1m]");
    expect(spawnModelId("claude-opus-5")).toBe("claude-opus-5[1m]");
    expect(spawnModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(spawnModelId("claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
    expect(contextWindow(spawnModelId("claude-sonnet-5"))).toBe(1_000_000);
  });
});

describe("strings", () => {
  it("has the Phase 2 copy", () => {
    expect(STR.skills).toBe("Skills");
    expect(STR.hiddenBots).toBe("Hidden Bots");
    expect(STR.unhide).toBe("Unhide");
    expect(STR.needsYou("Scout")).toBe("Scout needs you");
    expect(STR.waitingForInput).toBe("Waiting for your input.");
    expect(STR.openToSee).toBe("Open Synapse to see what it did.");
    expect(STR.themeRow("Light")).toBe("Theme: Light");
    // SET-02 / T14: the subtitle names the screen that now holds the Theme picker. It used to read
    // "Settings · Appearance", pointing at a section that was never built.
    expect(STR.themeSubtitle).toBe("Settings · General · Appearance");
    expect(STR.duplicateName("Scout")).toBe("Scout copy");
    expect(STR.skillSaved).toBe("Saved skill");
  });
});

describe("types", () => {
  it("exposes the Phase 2 transcript payloads and commands", () => {
    const att: SendMessagePayload = { type: "attachment", url: "file:///workspace/a.pdf", name: "a.pdf", size: 10, mime: "application/pdf", pages: 1, caption: null };
    const w: SendMessagePayload = { type: "widget", widget: { question: "Which?", options: [{ label: "A", value: "a" }] } };
    expect(att.type).toBe("attachment");
    expect(w.type).toBe("widget");
    const ua: TranscriptEntry = { kind: "user-attachment", id: "t1ua1", batchId: "t1u", attachmentId: "abc.pdf", name: "a.pdf", size: 1, mime: "application/pdf", storePath: "/x", boxPath: null, createdAt: 1 };
    expect(ua.kind).toBe("user-attachment");
    expectTypeOf<GatewayCommands["search"]["args"]>().toEqualTypeOf<{ query: string }>();
    expectTypeOf<HostSettingsView["themePreference"]>().toEqualTypeOf<"system" | "light" | "dark">();
    expectTypeOf<BotSummary["lastBotMessageAt"]>().toEqualTypeOf<number>();
  });
});
