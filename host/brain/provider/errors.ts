import { STR, STR_PROVIDER, type ProviderId } from "@synapse/shared";
import type { ClassifiedError, ErrorCode } from "../types";

/**
 * Spec §6: every failed provider call, classified the same way for Bot turns and helpers. `inLoopRetry` is whether
 * ProviderBrain retries the call itself; `retryable` (on the ClassifiedError) is whether the turn runner may rerun the
 * whole turn afterwards. A 429 rate limit is retried in the loop and then surfaces as not retryable, so a limited key
 * isn't hammered by both.
 */
export interface ProviderErrorClass extends ClassifiedError { inLoopRetry: boolean; retryAfterMs?: number }

const E = (code: ErrorCode, message: string, retryable: boolean, trayTitle: string = STR.trayBotFailed, extra: Partial<ProviderErrorClass> = {}): ProviderErrorClass =>
  ({ code, message, retryable, trayTitle, inLoopRetry: retryable, ...extra });

/** The error object in a provider's body: `{error:{…}}`, Gemini compat's `[{error:{…}}]`, or plain text. */
export function errorInfo(body: string): { message: string; type: string; code: string; status: string; text: string } {
  let j: unknown;
  try { j = JSON.parse(body); } catch { j = null; }
  if (Array.isArray(j)) j = j[0];
  const err = j && typeof j === "object" ? ((j as { error?: unknown }).error ?? j) : null;
  const o = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const message = s(o.message) || (typeof err === "string" ? err : "") || body.slice(0, 300);
  return { message: message.slice(0, 500), type: s(o.type), code: s(o.code), status: s(o.status), text: body.slice(0, 4000) };
}

const CONTEXT_RE = /request_too_large|context[_ ]length|context window|maximum context|too many tokens|prompt is too long|exceeds the (maximum|context)|input token count.*exceeds|request too large for model|reduce the length/i;
const BILLING_RE = /insufficient_quota|billing|credit|payment required|exceeded your current quota.*(plan|billing)/i;
const DAILY_RE = /PerDay|per day|daily/i;
export const NO_TOOLS_RE = /does(?: not|n't) support (?:tools|tool use|function calling)|tools? (?:is|are) not supported|(?:function calling|tool use|tool calling) is not (?:supported|enabled)|no endpoints found that support tool use|not support(?:ed)? (?:for )?(?:tools|function calling)/i;

/** Seconds from a Retry-After header (seconds or an HTTP date) or a body's "retry in 12.3s" / "retryDelay":"12s". */
export function retryAfterMsOf(header: string | null | undefined, body = "", now = Date.now()): number | undefined {
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    const t = Date.parse(header);
    if (Number.isFinite(t)) return Math.max(0, t - now);
  }
  const m = /retry in ([\d.]+)\s*s|"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(body);
  if (m) return Math.round(Number(m[1] ?? m[2]) * 1000);
  return undefined;
}

export function classifyProviderError(provider: ProviderId, status: number, body: string, retryAfter?: string | null, o: { budget?: boolean; budgetMessage?: string | null; model?: string } = {}): ProviderErrorClass {
  const info = errorInfo(body);
  const all = `${info.type} ${info.code} ${info.status} ${info.message}`;
  const wait = retryAfterMsOf(retryAfter, body);
  if (o.budget) return E("BOT-E0405", o.budgetMessage || STR_PROVIDER.overBudget, false, STR_PROVIDER.overBudgetTitle);
  // Gemini answers a bad key with 400 API_KEY_INVALID, not 401 (found by the live PC-10 sample).
  if (status === 401 || ((status === 400 || status === 403) && /API_KEY_INVALID|API key not valid|pass a valid API key|invalid api key|incorrect api key|invalid authentication|unauthori[sz]ed|authentication (failed|error)/i.test(`${all} ${info.text}`))) return E("BOT-E0421", STR_PROVIDER.keyRejected(provider), false, STR_PROVIDER.keyRejectedTitle);
  if (status === 402 || (status === 429 && BILLING_RE.test(all) && !/rate/i.test(info.code))) return E("BOT-E0405", STR_PROVIDER.noCredit(provider), false, STR_PROVIDER.noCreditTitle);
  // Anthropic answers an empty balance with 400 "Your credit balance is too low…" (or billing_error).
  if ((status === 400 || status === 403) && /credit balance is too low|billing_error/i.test(all)) return E("BOT-E0405", STR_PROVIDER.noCredit(provider), false, STR_PROVIDER.noCreditTitle);
  if (status === 403) return E("BOT-E0405", STR_PROVIDER.forbidden(provider, info.message), false, STR_PROVIDER.forbiddenTitle);
  if (status === 429) {
    const sec = wait !== undefined ? Math.ceil(wait / 1000) : undefined;
    // A daily quota won't clear in the loop's minute: say so at once.
    const daily = DAILY_RE.test(info.text);
    return E("BOT-E0420", STR_PROVIDER.rateLimited(provider, daily ? undefined : sec), false, STR_PROVIDER.rateLimitedTitle, { inLoopRetry: !daily, ...(wait !== undefined ? { retryAfterMs: wait } : {}) });
  }
  // The API refuses tools for this model (Ollama "does not support tools", OpenRouter "No endpoints found that support
  // tool use", OpenAI "tools is not supported"): the one thing no setting can work around, said plainly.
  if (status >= 400 && status < 500 && NO_TOOLS_RE.test(`${all} ${info.text}`)) return E("BOT-MODEL", STR_PROVIDER.noTools(provider, o.model ?? "this model"), false, STR_PROVIDER.noToolsTitle);
  if (status === 404 || /model_not_found|model not found|no longer available|does not exist/i.test(all) && status < 500) {
    if (CONTEXT_RE.test(all)) return E("BOT-E0404", STR_PROVIDER.context(provider), false, STR_PROVIDER.contextTitle);
    return E("BOT-MODEL", STR_PROVIDER.modelMissing(provider, o.model ?? "this model"), false, STR_PROVIDER.modelMissingTitle);
  }
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_RE.test(all)) return E("BOT-E0404", STR_PROVIDER.context(provider), false, STR_PROVIDER.contextTitle);
  if (/content_filter|safety|blocked.*(policy|safety)|PROHIBITED_CONTENT/i.test(all) && status < 500) return E("BOT-E0407", STR_PROVIDER.refused(provider), false, STR_PROVIDER.refusedTitle);
  if (status === 500) return E("BOT-E0406", STR_PROVIDER.server(provider, status), true, STR_PROVIDER.serverTitle, wait !== undefined ? { retryAfterMs: wait } : {});
  if (status === 502 || status === 503 || status === 504 || status === 529) return E("BOT-E0401", STR_PROVIDER.overloaded(provider, status), true, STR_PROVIDER.serverTitle, wait !== undefined ? { retryAfterMs: wait } : {});
  if (status > 500) return E("BOT-E0406", STR_PROVIDER.server(provider, status), true, STR_PROVIDER.serverTitle);
  return E("BOT-E0405", STR_PROVIDER.badRequest(provider, info.message), false);
}

/**
 * Anthropic's error types, as the HTTP status they come with: an error sent mid-stream (`event: error`, e.g.
 * overloaded_error after a 200) is classified as if it had been that status (spec §6: 529 → BOT-E0401, retried).
 */
const ANTHROPIC_STATUS: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
  request_too_large: 413, rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
};
export function statusOfErrorType(type: string | undefined): number | null {
  return type ? ANTHROPIC_STATUS[type] ?? null : null;
}

/** No first byte in 60 s, or silence for 120 s mid-stream. */
export function timeoutError(provider: ProviderId): ProviderErrorClass {
  return E("BOT-E0402", STR_PROVIDER.timeout(provider), true);
}

/** The connection itself failed (DNS, refused, reset): Ollama not running looks like this too. */
export function networkError(provider: ProviderId): ProviderErrorClass {
  return E("BOT-E0403", STR_PROVIDER.unreachable(provider), true);
}

export function refusedError(provider: ProviderId): ProviderErrorClass {
  return E("BOT-E0407", STR_PROVIDER.refused(provider), false, STR_PROVIDER.refusedTitle);
}

export function noKeyError(provider: ProviderId): ProviderErrorClass {
  return E("BOT-E0421", STR_PROVIDER.noKey(provider), false, STR_PROVIDER.noKeyTitle);
}

/** Retry policy (spec §6): up to 4 attempts, exponential backoff with jitter, honoring retry-after, capped at 60 s. */
export const MAX_ATTEMPTS = 4;
export const RETRY_CAP_MS = 60_000;
export function backoffMs(attempt: number, retryAfterMs: number | undefined, rand: () => number = Math.random): number {
  if (retryAfterMs !== undefined) return Math.min(RETRY_CAP_MS, retryAfterMs + Math.floor(rand() * 250));
  const base = 1000 * 2 ** attempt;
  return Math.min(RETRY_CAP_MS, Math.floor(base * (0.5 + rand() / 2)));
}
