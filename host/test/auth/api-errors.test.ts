import { describe, expect, it } from "vitest";
import { STR, STR_AUTH } from "@synapse/shared";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { classifyAssistantError, classifyResult, classifyThrown } from "../../brain/errors";
import { AuthMissingError } from "../../auth/auth-env";

const failed = (text: string) => ({ type: "result", subtype: "success", is_error: true, result: text }) as unknown as SDKResultMessage;

describe("turn errors say what is wrong with the API key or the account", () => {
  it("invalid key", () => {
    expect(classifyAssistantError("authentication_failed", "")).toMatchObject({ code: "BOT-E0421", trayTitle: STR_AUTH.keyRejected, retryable: false });
  });
  it("no credits / billing", () => {
    expect(classifyAssistantError("billing_error", "")).toMatchObject({ trayTitle: STR_AUTH.billing, message: STR_AUTH.billingDetail, retryable: false });
    expect(classifyResult(failed("Credit balance is too low"), null, false)).toMatchObject({ trayTitle: STR_AUTH.billing });
  });
  it("rate limited, with the retry-after the CLI last waited", () => {
    const e = classifyAssistantError("rate_limit", "", { retryAfterMs: 30_000 });
    expect(e).toMatchObject({ trayTitle: STR_AUTH.rateLimited, retryable: false });
    expect(e.message).toContain("30 s");
  });
  it("overloaded is retried (the runner backs off)", () => {
    expect(classifyAssistantError("overloaded", "")).toMatchObject({ trayTitle: STR_AUTH.overloaded, retryable: true });
  });
  it("model not available to the key", () => {
    expect(classifyAssistantError("model_not_found", "")).toMatchObject({ code: "BOT-MODEL", trayTitle: STR_AUTH.modelUnavailable });
  });
  it("permission (403)", () => {
    expect(classifyResult(failed("API Error: 403 {\"type\":\"error\",\"error\":{\"type\":\"permission_error\"}}"), null, false)).toMatchObject({ trayTitle: STR_AUTH.permission });
  });
  it("api-key-only: with no context the words are still the API key's, never a Claude plan's", () => {
    expect(classifyAssistantError("authentication_failed")).toMatchObject({ trayTitle: STR_AUTH.keyRejected });
    expect(classifyAssistantError("rate_limit")).toMatchObject({ trayTitle: STR_AUTH.rateLimited });
    expect(classifyResult(failed("x"), null, true)).toMatchObject({ trayTitle: STR_AUTH.rateLimited });
    expect(JSON.stringify([classifyAssistantError("authentication_failed"), classifyAssistantError("rate_limit"), classifyAssistantError("model_not_found")])).not.toMatch(/subscription|plan|sign-in/i);
  });
  it("no key saved", () => {
    expect(classifyThrown(new AuthMissingError())).toMatchObject({ code: "BOT-E0421", trayTitle: STR_AUTH.noKeyTitle, message: STR_AUTH.noKeyDetail, retryable: false });
  });
});
