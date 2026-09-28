import { describe, expect, it } from "vitest";
import { HELPER_MODEL } from "@synapse/shared";
import { testAnthropicConnection } from "../../auth/test-connection";

/**
 * The one-cent real check (docs/api-key-auth.md): ONE Haiku call with max_tokens 5 against api.anthropic.com
 * with a real key, then the Test connection path (max_tokens 1). Skipped unless the key is given:
 *
 *   SYNAPSE_LIVE_API_KEY=sk-ant-api03-… npx vitest run --project host host/test/auth/real-key.live.test.ts
 */
const KEY = process.env.SYNAPSE_LIVE_API_KEY ?? "";

describe.runIf(KEY.startsWith("sk-ant-api"))("a real Anthropic API key (costs well under one cent)", () => {
  it("one Haiku call, max_tokens 5: 200, streamed-compatible usage fields", async () => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: HELPER_MODEL, max_tokens: 5, messages: [{ role: "user", content: "Say OK." }] }),
    });
    const j = (await res.json()) as { usage?: { input_tokens: number; output_tokens: number }; error?: unknown };
    expect(res.status, JSON.stringify(j.error ?? null)).toBe(200);
    expect(j.usage?.input_tokens).toBeGreaterThan(0);
    expect(j.usage?.output_tokens).toBeLessThanOrEqual(5);
  }, 30_000);

  it("Test connection says the key works", async () => {
    expect(await testAnthropicConnection(KEY)).toMatchObject({ ok: true, reached: true, kind: "ok" });
  }, 30_000);
});
