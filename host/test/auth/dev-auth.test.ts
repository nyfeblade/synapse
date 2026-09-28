import { describe, expect, it } from "vitest";
import { SENTINEL_API_KEY, SENTINEL_BASE_URL } from "../../auth/auth-env";
import { explicitKeyEnv } from "../../auth/dev-auth";
import { claudeEnvForBench } from "../../bench/coding/cli";

/**
 * Review round 2 (S3): the Mac-side dev tools that start a real `claude` (the coding bench's CLI baseline, the routing
 * eval, the perf probes) never run on the developer's own Claude login: an explicit API key, or a dead sentinel pair.
 */
const KEY = "sk-ant-api03-" + "D".repeat(80) + "devk";
const login = { PATH: "/usr/bin", HOME: "/Users/x", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-" + "x".repeat(40), ANTHROPIC_AUTH_TOKEN: "b", CLAUDE_CODE_ENTRYPOINT: "cli" };

describe("explicitKeyEnv", () => {
  it("with SYNAPSE_API_KEY (or ANTHROPIC_API_KEY): that key, every login scrubbed", () => {
    for (const env of [{ ...login, SYNAPSE_API_KEY: KEY }, { ...login, ANTHROPIC_API_KEY: KEY }]) {
      const e = explicitKeyEnv(env);
      expect(e.ANTHROPIC_API_KEY).toBe(KEY);
      expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(e.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(e.SYNAPSE_API_KEY).toBeUndefined();
      expect(e.PATH).toBe("/usr/bin");
    }
  });

  it("no key: the dead sentinel pair, so the user's own login is never read", () => {
    const e = explicitKeyEnv({ ...login });
    expect(e.ANTHROPIC_API_KEY).toBe(SENTINEL_API_KEY);
    expect(e.ANTHROPIC_BASE_URL).toBe(SENTINEL_BASE_URL);
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("the coding bench's CLI baseline uses it", () => {
    expect(claudeEnvForBench({ ...login }).ANTHROPIC_API_KEY).toBe(SENTINEL_API_KEY);
    expect(claudeEnvForBench({ ...login, SYNAPSE_API_KEY: KEY }).ANTHROPIC_API_KEY).toBe(KEY);
  });
});
