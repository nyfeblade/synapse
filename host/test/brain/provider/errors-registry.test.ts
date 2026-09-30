import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backoffMs, classifyProviderError, networkError, retryAfterMsOf, timeoutError } from "../../../brain/provider/errors";
import { sanitizeSchema, STRICT_MAX_OPTIONAL, ToolRegistry, zodToJsonSchema } from "../../../brain/provider/tool-registry";
import type { BotToolDef } from "../../../brain/types";

const err = (message: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error: { message, ...extra } });

describe("provider error table (spec §6)", () => {
  const c = (status: number, body = "", ra?: string, o = {}) => classifyProviderError("openai", status, body, ra, o);
  it("maps each row", () => {
    expect(c(401)).toMatchObject({ code: "BOT-E0421", retryable: false, inLoopRetry: false });
    expect(c(403, err("nope"))).toMatchObject({ code: "BOT-E0405", retryable: false });
    expect(c(402)).toMatchObject({ code: "BOT-E0405", trayTitle: "No credit" });
    expect(c(429, err("You exceeded your current quota, please check your plan and billing details.", { code: "insufficient_quota", type: "insufficient_quota" }))).toMatchObject({ code: "BOT-E0405", trayTitle: "No credit" });
    expect(c(429, "", undefined, { budget: true, budgetMessage: "Weekly budget reached." })).toMatchObject({ code: "BOT-E0405", message: "Weekly budget reached.", retryable: false, inLoopRetry: false });
    expect(c(429, err("Rate limit reached", { code: "rate_limit_exceeded" }), "7")).toMatchObject({ code: "BOT-E0420", retryable: false, inLoopRetry: true, retryAfterMs: 7000 });
    expect(c(404, err("The model `x` does not exist", { code: "model_not_found" }))).toMatchObject({ code: "BOT-MODEL" });
    expect(c(400, err("This model's maximum context length is 128000 tokens.", { code: "context_length_exceeded" }))).toMatchObject({ code: "BOT-E0404", retryable: false });
    expect(c(500)).toMatchObject({ code: "BOT-E0406", retryable: true, inLoopRetry: true });
    for (const s of [502, 503, 529]) expect(c(s)).toMatchObject({ code: "BOT-E0401", retryable: true });
    expect(c(400, err("blocked", { code: "content_filter" }))).toMatchObject({ code: "BOT-E0407", retryable: false });
    expect(c(400, err("bad field"))).toMatchObject({ code: "BOT-E0405", retryable: false });
    expect(timeoutError("openai")).toMatchObject({ code: "BOT-E0402", retryable: true });
    expect(networkError("ollama")).toMatchObject({ code: "BOT-E0403", retryable: true, message: "Can't reach Ollama on this Mac. Is it running?" });
  });

  it("reads Gemini compat's error arrays and retryDelay; a daily quota isn't retried in the loop", () => {
    const perMinute = JSON.stringify([{ error: { code: 429, message: "Quota exceeded. Please retry in 12.5s.", status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "12s" }] } }]);
    expect(classifyProviderError("gemini", 429, perMinute)).toMatchObject({ code: "BOT-E0420", inLoopRetry: true, retryAfterMs: 12500 });
    const daily = JSON.stringify([{ error: { code: 429, message: "Quota exceeded for metric: generate_content_free_tier_requests, GenerateRequestsPerDayPerProjectPerModel-FreeTier" } }]);
    expect(classifyProviderError("gemini", 429, daily)).toMatchObject({ code: "BOT-E0420", inLoopRetry: false });
    expect(classifyProviderError("gemini", 400, JSON.stringify([{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }]))).toMatchObject({ code: "BOT-E0421" });
    // The live answer to a bad key on the compat endpoint (seen 2026-09-30):
    expect(classifyProviderError("gemini", 400, "[{\n  \"error\": {\n    \"code\": 400,\n    \"message\": \"Please pass a valid API key\",\n    \"status\": \"INVALID_ARGUMENT\"\n  }\n}\n]")).toMatchObject({ code: "BOT-E0421" });
    expect(classifyProviderError("gemini", 503, JSON.stringify([{ error: { code: 503, message: "The model is overloaded." } }]))).toMatchObject({ code: "BOT-E0401", retryable: true });
  });

  it("retry-after in seconds or as a date; backoff capped at 60 s with jitter", () => {
    expect(retryAfterMsOf("3")).toBe(3000);
    expect(retryAfterMsOf("Wed, 30 Sep 2026 00:00:10 GMT", "", Date.parse("Wed, 30 Sep 2026 00:00:00 GMT"))).toBe(10_000);
    expect(retryAfterMsOf(null, "nothing")).toBeUndefined();
    expect(backoffMs(0, undefined, () => 0)).toBe(500);
    expect(backoffMs(2, undefined, () => 1)).toBe(4000);
    expect(backoffMs(10, undefined, () => 1)).toBe(60_000);
    expect(backoffMs(0, 120_000, () => 0)).toBe(60_000);
  });
});

describe("ToolRegistry and the schema sanitizer", () => {
  const shape = { command: z.string().min(1), timeout: z.number().int().optional(), cwd: z.string().optional() };
  it("uses zod 4's converter and strips the int noise (phase 0 3a)", () => {
    const s = zodToJsonSchema(shape);
    expect(s).not.toHaveProperty("$schema");
    expect(s).toMatchObject({ type: "object", required: ["command"], properties: { command: { type: "string", minLength: 1 }, timeout: { type: "integer" } } });
    expect(JSON.stringify(s)).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it("gemini/loose: sent as is, never strict; openai-strict: all required + nullable, no extra props, unsupported keywords into the description", () => {
    const s = zodToJsonSchema(shape);
    expect(sanitizeSchema(s, "gemini")).toEqual({ schema: s, strict: false });
    expect(sanitizeSchema(s, "loose")).toEqual({ schema: s, strict: false });
    const o = sanitizeSchema(s, "openai-strict");
    expect(o.strict).toBe(true);
    expect(o.schema).toMatchObject({ additionalProperties: false, required: ["command", "timeout", "cwd"], properties: { timeout: { type: ["integer", "null"] }, command: { type: "string", description: "(minLength: 1)" } } });
    expect(o.schema.properties as object).not.toHaveProperty("command.minLength");
  });

  it("free-form objects and tools with many optional fields stay loose (phase 0 3c/3d)", () => {
    const free = zodToJsonSchema({ widget: z.looseObject({}) , content: z.string() });
    expect(sanitizeSchema(free, "openai-strict").strict).toBe(false);
    const many = zodToJsonSchema(Object.fromEntries(Array.from({ length: STRICT_MAX_OPTIONAL + 1 }, (_, i) => [`o${i}`, z.string().optional()])));
    expect(sanitizeSchema(many, "openai-strict")).toEqual({ schema: many, strict: false });
  });

  it("serves bot tools under their bare names, keeps canonical names, and refuses invented ones", () => {
    const def = (name: string): BotToolDef => ({ name, description: name, schema: shape, readOnly: false, handler: async () => ({ text: "" }) });
    const r = ToolRegistry.forBotTools([def("Shell"), def("SendMessage"), def("Shell")], "gemini");
    expect(r.wireTools().map((t) => t.name)).toEqual(["Shell", "SendMessage"]);
    expect(r.canonicalNames()).toEqual(["mcp__bot__Shell", "mcp__bot__SendMessage"]);
    expect(r.fromWire("Shell")?.canonical).toBe("mcp__bot__Shell");
    expect(r.fromWire("mcp__bot__Shell")?.canonical).toBe("mcp__bot__Shell");
    expect(r.fromWire("Bash")).toBeUndefined();
    expect(r.wireName("mcp__bot__SendMessage")).toBe("SendMessage");
    const odd = new ToolRegistry([{ canonical: "mcp__google__gmail.send", def: def("x") }, { canonical: "mcp__google__gmail_send", def: def("y") }], "loose");
    expect(odd.wireTools().map((t) => t.name)).toEqual(["mcp__google__gmail_send", "mcp__google__gmail_send_2"]);
    expect(ToolRegistry.forBotTools([def("A"), def("B"), def("C")], "loose", 2).canonicalNames()).toHaveLength(2);
  });
});
