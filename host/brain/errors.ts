import type { SDKAssistantMessageError, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { STR, STR_AUTH, WEB_SEARCH_OFF_RE, classifyAnthropicError, promptTooLong } from "@synapse/shared";
import type { ClassifiedError, ErrorCode } from "./types";

const E = (code: ErrorCode, message: string, retryable: boolean, trayTitle: string = STR.trayBotFailed): ClassifiedError => ({ code, message, retryable, trayTitle });

/** The last retry wait the CLI reported (api_retry). */
export interface AuthContext { retryAfterMs?: number }

/** The API key's problem in the Console's terms (invalid key, no credits, rate limit…): the only sign-in there is. */
function apiKeyError(code: ErrorCode, kind: Parameters<typeof classifyAnthropicError>[0], type: string, retryable: boolean, a: AuthContext, text = ""): ClassifiedError {
  const sec = a.retryAfterMs ? Math.ceil(a.retryAfterMs / 1000) : undefined;
  const c = classifyAnthropicError(kind, type, sec, text);
  return E(code, c.detail, retryable, c.title);
}

export function classifyAssistantError(err: SDKAssistantMessageError, detail = "", auth: AuthContext = {}): ClassifiedError {
  // The CLI reports a 403 as authentication_failed too; the text names the real status.
  const fromText = apiKeyErrorFromText(detail, auth);
  if (fromText) return fromText;
  switch (err) {
    case "authentication_failed": case "oauth_org_not_allowed": return apiKeyError("BOT-E0421", 401, "authentication_error", false, auth);
    case "billing_error": case "account_on_hold": return apiKeyError("BOT-E0405", 402, "billing_error", false, auth);
    case "rate_limit": return apiKeyError("BOT-E0420", 429, "rate_limit_error", false, auth);
    case "overloaded": return apiKeyError("BOT-E0401", 529, "overloaded_error", true, auth);
    case "model_not_found": return apiKeyError("BOT-MODEL", 404, "not_found_error", false, auth);
    default: break;
  }
  switch (err) {
    case "server_error":
      return E("BOT-E0406", detail || "Server error", true);
    case "invalid_request":
    case "verification_required":
      return E("BOT-E0405", detail || String(err), false);
    default:
      return E("BOT-E0407", detail || String(err), false);
  }
}

/** A failed result whose text names the API error ("API Error: 403 {…permission_error…}", "credit balance is too low"). */
function apiKeyErrorFromText(text: string, auth: AuthContext): ClassifiedError | undefined {
  // Bug 280: before the status checks (the API's body says invalid_request_error; the CLI calls it invalid_request).
  const long = promptTooLong(text);
  if (long) return E("BOT-E0404", STR_AUTH.promptTooLongDetail(long.tokens, long.limit), false, STR_AUTH.promptTooLong);
  if (WEB_SEARCH_OFF_RE.test(text)) return E("BOT-E0405", STR_AUTH.webSearchDisabledDetail, false, STR_AUTH.webSearchDisabled);
  if (/credit balance|billing_error/i.test(text)) return apiKeyError("BOT-E0405", 402, "billing_error", false, auth);
  if (/permission_error|API Error: 403\b/i.test(text)) return apiKeyError("BOT-E0405", 403, "permission_error", false, auth);
  if (/authentication_error|invalid x-api-key|API Error: 401\b/i.test(text)) return apiKeyError("BOT-E0421", 401, "authentication_error", false, auth);
  if (/not_found_error|API Error: 404\b/i.test(text)) return apiKeyError("BOT-MODEL", 404, "not_found_error", false, auth);
  if (/rate_limit_error|API Error: 429\b/i.test(text)) return apiKeyError("BOT-E0420", 429, "rate_limit_error", false, auth);
  if (/overloaded_error|API Error: 529\b/i.test(text)) return apiKeyError("BOT-E0401", 529, "overloaded_error", true, auth);
  return undefined;
}

export function classifyResult(r: SDKResultMessage, lastAssistantError: SDKAssistantMessageError | null, rateLimited: boolean, auth: AuthContext = {}): ClassifiedError | undefined {
  if (r.subtype === "success" && !r.is_error) return undefined;
  const text = r.subtype === "success" ? r.result : (r as { errors?: string[] }).errors?.join("; ") ?? r.subtype;
  if (lastAssistantError) return classifyAssistantError(lastAssistantError, text, auth);
  const fromText = apiKeyErrorFromText(text, auth);
  if (fromText) return fromText;
  if (rateLimited) return apiKeyError("BOT-E0420", 429, "rate_limit_error", false, auth);
  if (/context (window|length)|too many tokens/i.test(text)) return E("BOT-E0404", STR_AUTH.promptTooLongDetail(), false, STR_AUTH.promptTooLong);
  return E("BOT-E0407", text, false);
}

export function classifyThrown(e: unknown): ClassifiedError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "AuthMissingError") return E("BOT-E0421", STR_AUTH.noKeyDetail, false, STR_AUTH.noKeyTitle);
  if (e instanceof Error && e.name === "AuthProxyDownError") return E("BOT-E0421", STR_AUTH.proxyDownDetail, true, STR_AUTH.proxyDownTitle);
  if (/auth|login|credential|401/i.test(msg)) return E("BOT-E0421", msg, false, STR.traySignIn);
  if (/timed out waiting for (init|first event)|stall/i.test(msg)) return E("BOT-E0402", msg, true);
  return E("BOT-E0403", msg, true);
}
