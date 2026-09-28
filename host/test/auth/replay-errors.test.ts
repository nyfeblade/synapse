import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { STR_AUTH, classifyAnthropicError, promptTooLong, withoutLoginBetas } from "@synapse/shared";
import { classifyResult } from "../../brain/errors";
import { recording } from "./replay-anthropic";

/**
 * Bug 280: the recorded error answers reach the user as plain messages, on both paths an error takes: straight from
 * Anthropic's body (Test connection, the key check, the model probe) and through the CLI's result (a Bot's turn). The
 * CLI results below are what the real bundled CLI (2.1.283) returned for recordings 0037/0038 and 0046 when replayed
 * through the box key proxy (replay.cli.integration.test.ts runs the same thing live with RUN_CLAUDE=1).
 */
const body = (id: string) => (recording(id).response.body as { error: { type: string; message: string } }).error;
const JSONISH = /API Error|invalid_request_error|not_found_error|\{|request_id/;

const cliResult = (over: Partial<SDKResultMessage> & Record<string, unknown>): SDKResultMessage =>
  ({ type: "result", subtype: "success", is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0, session_id: "s", uuid: "u", ...over }) as unknown as SDKResultMessage;
const CLI_404 = cliResult({ api_error_status: 404, terminal_reason: "api_error", result: "There's an issue with the selected model (claude-sonnet-5). It may not exist or you may not have access to it." });
const CLI_400_LONG = cliResult({ api_error_status: 400, terminal_reason: "prompt_too_long", result: "Prompt is too long · the request is ~207706 tokens (limit 200000) but this conversation is only ~305 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context." });

describe("recorded errors, straight from Anthropic's body", () => {
  it.each(["0037", "0038"])("%s 404 unknown model: 'Model not available to this key', not the API's words", (id) => {
    const r = recording(id);
    const e = body(id);
    const c = classifyAnthropicError(r.response.status, e.type, undefined, e.message);
    expect(c).toEqual({ kind: "model-unavailable", title: STR_AUTH.modelUnavailable, detail: STR_AUTH.modelUnavailableDetail });
  });

  it("0046 400 prompt too long: a plain title and the two numbers, not 'Request refused' with the raw message", () => {
    const e = body("0046");
    expect(e).toEqual({ type: "invalid_request_error", message: "prompt is too long: 207706 tokens > 200000 maximum" });
    const c = classifyAnthropicError(400, e.type, undefined, e.message);
    expect(c.title).toBe(STR_AUTH.promptTooLong);
    expect(c.detail).toBe(STR_AUTH.promptTooLongDetail(207706, 200000));
    expect(c.detail).toContain("207,706");
    expect(c.detail).not.toMatch(JSONISH);
  });
});

describe("recorded errors, through the CLI's result (a Bot's turn)", () => {
  it("404: BOT-MODEL with the plain words (the CLI names it model_not_found)", () => {
    expect(classifyResult(CLI_404, "model_not_found", false)).toMatchObject({ code: "BOT-MODEL", trayTitle: STR_AUTH.modelUnavailable, message: STR_AUTH.modelUnavailableDetail, retryable: false });
  });

  it("400 prompt too long: BOT-E0404 (the compactor compacts and retries on it) with the host's words, not the CLI's advice", () => {
    const c = classifyResult(CLI_400_LONG, "invalid_request", false);
    expect(c).toMatchObject({ code: "BOT-E0404", trayTitle: STR_AUTH.promptTooLong, message: STR_AUTH.promptTooLongDetail(207706, 200000), retryable: false });
    expect(c!.message).not.toMatch(/reduce attached files|API Error/);
  });

  it("the same text with no assistant error (a result on its own) is still BOT-E0404", () => {
    expect(classifyResult(CLI_400_LONG, null, false)).toMatchObject({ code: "BOT-E0404", trayTitle: STR_AUTH.promptTooLong });
  });

  it("an older CLI's 'API Error: 400 {…prompt is too long…}' text is BOT-E0404 too, never the JSON", () => {
    const text = `API Error: 400 ${JSON.stringify(recording("0046").response.body)}`;
    const c = classifyResult(cliResult({ result: text }), "invalid_request", false);
    expect(c).toMatchObject({ code: "BOT-E0404", message: STR_AUTH.promptTooLongDetail(207706, 200000) });
  });
});

describe("the helpers", () => {
  it("promptTooLong reads the API's and the CLI's words, with or without numbers", () => {
    expect(promptTooLong("prompt is too long: 207706 tokens > 200000 maximum")).toEqual({ tokens: 207706, limit: 200000 });
    expect(promptTooLong(CLI_400_LONG.subtype === "success" ? CLI_400_LONG.result : "")).toEqual({ tokens: 207706, limit: 200000 });
    expect(promptTooLong("Prompt is too long")).toEqual({});
    expect(promptTooLong("model: claude-nonexistent-9")).toBeNull();
    expect(promptTooLong(undefined)).toBeNull();
  });

  it("withoutLoginBetas drops every oauth-* beta and keeps the rest in order", () => {
    expect(withoutLoginBetas("claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07")).toBe("claude-code-20250219,context-1m-2025-08-07");
    expect(withoutLoginBetas("oauth-2025-04-20")).toBeUndefined();
    expect(withoutLoginBetas(["a-1", "OAuth-2099-01-01, b-2"])).toBe("a-1,b-2");
    expect(withoutLoginBetas(undefined)).toBeUndefined();
    expect(withoutLoginBetas(" , ")).toBeUndefined();
  });
});
