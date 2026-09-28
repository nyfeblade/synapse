import { describe, expect, it, vi } from "vitest";
import { buildBotEnv } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { log } from "../../util/log";

/**
 * Token diet (3). Claude Code 2.1.277 picks the main conversation's prompt-cache TTL per request:
 * 1 hour on a subscription "within its usage limits", 5 minutes otherwise (on usage credits, or an
 * API key). CLAUDE_CODE_PROMPT_CACHE_TTL=1h (docs: env-vars, "Requires Claude Code v2.1.242 or later")
 * pins 1 hour for the Bot's own turns, so a reply 5–60 minutes after the last one reads the cache
 * instead of rewriting the whole context. Nothing a Bot stores can turn it off.
 */
describe("the Bot CLI keeps a 1-hour prompt cache", () => {
  it("pins CLAUDE_CODE_PROMPT_CACHE_TTL=1h, after (so over) the Bot's own secrets", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const env = buildBotEnv({ cfg: loadConfig({}), botId: "b1", secrets: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", FORCE_PROMPT_CACHING_5M: "1" } });
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(env.FORCE_PROMPT_CACHING_5M).toBeUndefined(); // it overrides the TTL var, so it can never reach the CLI
    vi.restoreAllMocks();
  });
});

/**
 * saving-settings, "Keep conversations ready": 1 hour (default, the pin above) or 5 minutes. 5-minute writes are billed
 * 1.25x input instead of 2x, but a reply 5–60 minutes after the last one re-writes the cache. The choice reaches the env,
 * still over the Bot's own secrets.
 */
describe("Keep conversations ready: the TTL the Bot CLI is spawned with", () => {
  it("5 minutes pins CLAUDE_CODE_PROMPT_CACHE_TTL=5m; no TTL given is still 1h", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const five = buildBotEnv({ cfg: loadConfig({}), botId: "b1", promptCacheTtl: "5m", secrets: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", ENABLE_PROMPT_CACHING_1H: "1" } });
    expect(five.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
    expect(five.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(buildBotEnv({ cfg: loadConfig({}), botId: "b1", promptCacheTtl: "1h" }).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(buildBotEnv({ cfg: loadConfig({}), botId: "b1" }).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    vi.restoreAllMocks();
  });
});
