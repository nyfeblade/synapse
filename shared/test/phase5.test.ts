import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_NAME, COMPUTER_NAME, LIMITS5, STR5, SPEECH_RATES, normalizeMcpHeaderValue, type GatewayCommands, type SseEvent, type UsageView } from "../src";
import { REFERENCE_NAME } from "../../scripts/public-scan";

const callAll = (fn: (...a: unknown[]) => unknown): string => {
  try { return String(fn("X", 2, 3)); } catch { return String(fn(["X", "Y"])); }
};
const allStrings = (o: unknown): string[] =>
  typeof o === "string" ? [o]
  : typeof o === "function" ? [callAll(o as (...a: unknown[]) => unknown)]
  : o && typeof o === "object" ? Object.values(o).flatMap(allStrings) : [];

describe("Phase 5 copy (D13-B)", () => {
  it("never says Claude Code or names the reference product, and uses APP_NAME / COMPUTER_NAME", () => {
    const all = allStrings(STR5);
    expect(all.length).toBeGreaterThan(120);
    for (const s of all) {
      expect(s).not.toMatch(/Claude Code/);
      expect(s).not.toMatch(REFERENCE_NAME);
    }
    // P5 review minor: an "Always" answer is per-Bot + per-action, so the card no longer says it covers every Bot.
    expect(STR5.localCardTitle).toBe("Allow this Bot to run this on your local computer?");
    expect(STR5.fromTeam).toBe(`From ${APP_NAME} Team`);
    expect(STR5.networkLocked).toContain(COMPUTER_NAME.charAt(0).toUpperCase() + COMPUTER_NAME.slice(1));
    expect(STR5.yourPlugins(6)).toBe("Your plugins · 6 installed");
    expect(STR5.resetsIn(1)).toBe("Resets in 1 day");
    expect(STR5.resetsIn(5)).toBe("Resets in 5 days");
    expect(STR5.weeklyUsageMenu(62)).toBe("Weekly usage 62%");
  });
});

describe("Phase 5 limits (§5, §9.0)", () => {
  it("keeps the spec's values", () => {
    expect(LIMITS5.localFileMaxBytes).toBe(100 * 1024 * 1024);
    expect(LIMITS5.localHeartbeatMs).toBe(10_000);
    expect(LIMITS5.localLivenessMs).toBe(30_000);
    expect(LIMITS5.localAskTtlMs).toBe(600_000);
    expect(LIMITS5.mcpOAuthPendingTtlMs).toBe(11 * 60_000);
    expect(LIMITS5.dreamEvidencePerBot).toBe(12);
    expect(LIMITS5.dreamDeadlineMs).toBe(90_000);
    expect(LIMITS5.followupHeartbeatMs).toBe(30 * 60_000);
    expect(LIMITS5.codingAgentWallClockMs).toBe(5 * 3600_000);
    expect(LIMITS5.ladderL1).toBe(0.8);
    expect(SPEECH_RATES).toEqual([0.75, 1, 1.25, 1.5, 2]);
  });
});

describe("gateway contract merging", () => {
  it("adds Phase 5 commands and SSE channels", () => {
    expectTypeOf<GatewayCommands["getUsage"]["result"]>().toEqualTypeOf<UsageView>();
    expectTypeOf<GatewayCommands["startMcpAuth"]["args"]>().toEqualTypeOf<{ serverId: string }>();
    expectTypeOf<Extract<SseEvent, { channel: "usage" }>["payload"]>().toEqualTypeOf<UsageView>();
  });
});

describe("normalizeMcpHeaderValue", () => {
  it("prefixes a pasted Slack user token so the request matches the Bearer challenge", () => {
    expect(normalizeMcpHeaderValue("Authorization", "xoxp-123-workspace-token")).toBe("Bearer xoxp-123-workspace-token");
    expect(normalizeMcpHeaderValue("authorization", "  xoxp-123-workspace-token  ")).toBe("Bearer xoxp-123-workspace-token");
  });
  it("leaves an already-Bearer value and every other header alone", () => {
    expect(normalizeMcpHeaderValue("Authorization", "Bearer xoxp-123")).toBe("Bearer xoxp-123");
    expect(normalizeMcpHeaderValue("Authorization", "bearer xoxp-123")).toBe("Bearer xoxp-123");
    expect(normalizeMcpHeaderValue("x-consumer-api-key", "ck_abc")).toBe("ck_abc");
    expect(normalizeMcpHeaderValue("Authorization", "not-a-slack-token")).toBe("not-a-slack-token");
    expect(normalizeMcpHeaderValue("Authorization", "ghp_abc123")).toBe("Bearer ghp_abc123");
    expect(normalizeMcpHeaderValue("Authorization", "github_pat_abc123")).toBe("Bearer github_pat_abc123");
    expect(normalizeMcpHeaderValue("Authorization", "Bearer ghp_abc123")).toBe("Bearer ghp_abc123");
  });
});
