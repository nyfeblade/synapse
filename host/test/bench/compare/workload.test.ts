import { describe, expect, it } from "vitest";
import { buildConversation, PROFILES } from "../../../bench/compare/workload";

const DAY = 86_400_000;

describe("workload profiles from the seeded bench generator", () => {
  it("is deterministic per seed", () => {
    expect(buildConversation(PROFILES.casual, "small")).toEqual(buildConversation(PROFILES.casual, "small"));
  });

  it("casual chat: one tool call (the reply) per message, text from the generator", () => {
    const c = buildConversation(PROFILES.casual, "small");
    expect(c.messages.length).toBeGreaterThan(20);
    expect(c.messages.every((m) => m.tools.length === 1 && m.tools[0]!.kind === "reply")).toBe(true);
    expect(c.messages.every((m) => m.userTokens > 0)).toBe(true);
    expect(c.messages.some((m) => !m.memorable)).toBe(true);
  });

  it("tool-heavy work: 3–8 tool calls per message with realistic result sizes", () => {
    const c = buildConversation(PROFILES.toolHeavy, "small");
    const n = c.messages.map((m) => m.tools.length);
    expect(Math.min(...n)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...n)).toBeLessThanOrEqual(8);
    const results = c.messages.flatMap((m) => m.tools.filter((t) => t.kind === "work").map((t) => t.resultTokens));
    expect(Math.min(...results)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...results)).toBeLessThanOrEqual(15_000);
    expect(results.reduce((a, b) => a + b, 0) / results.length).toBeGreaterThan(1_000);
  });

  it("long-lived: spans 60+ days, messages in time order", () => {
    const c = buildConversation(PROFILES.longLived, "small");
    const ts = c.messages.map((m) => m.t);
    expect(ts.at(-1)! - ts[0]!).toBeGreaterThanOrEqual(60 * DAY);
    expect(ts.every((t, i) => i === 0 || t > ts[i - 1]!)).toBe(true);
    expect(c.days).toBeGreaterThanOrEqual(60);
  });
});
