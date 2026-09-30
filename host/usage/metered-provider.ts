import { parseProviderModelRef, providerPrice, type ProviderId } from "@synapse/shared";
import { modelTarget } from "../brain/provider/adapters/index";
import { ANTHROPIC_VERSION } from "../brain/provider/adapters/anthropic-messages";
import { listCostUsd } from "./list-price";
import { quirksFor } from "../brain/provider/adapters/quirks";
import type { CallUsage, ProviderAdapter } from "../brain/provider/adapters/types";
import { classifyProviderError, networkError, noKeyError, statusOfErrorType, timeoutError, type ProviderErrorClass } from "../brain/provider/errors";
import { STR_PROVIDER } from "@synapse/shared";
import { SseParser } from "../brain/provider/sse";
import { BUDGET_HEADER } from "../auth/proxy";
import { authProxy } from "../auth/auth-env";
import { recordMeteredRun, type Meter, type RunUsage } from "./metered-query";

/**
 * providerFetch (spec §4, §1b): the ONE host function that sends a request to a model provider, the provider twin of
 * meteredQuery. Every call:
 *   1. asks the spend budget first (the same `allow()` the key proxy asks for Claude calls) and fails closed without one;
 *   2. streams the response, watching every chunk for the provider's usage frame;
 *   3. records its usage when it ends, however it ends (complete, aborted, broken): a call that never reported usage is
 *      estimated from its bytes, so nothing a provider billed goes unrecorded.
 * "turn" usage goes back to the brain for its TurnResult (the usage store records turns on settle, as for Claude);
 * every other purpose is recorded here. Guarded by test/brain/provider/metering-guard.test.ts.
 *
 * The key never passes through here (track 2.4): each call gets a one-call token from the provider proxy
 * (auth/provider-proxy.ts), which swaps it for the key on its way to the provider's fixed upstream and scrubs the key
 * out of whatever comes back. Nothing is sent to a provider the user hasn't consented to (spec §4, owner answer 4).
 */
type Provider = Exclude<ProviderId, "anthropic">;
/** What providerFetch needs from the provider proxy: a per-call token, never the key. */
export interface ProviderProxyLike {
  readonly url: string;
  issue(g: { botId: string | null; provider: Provider; keyOverride?: string }): string;
  revoke(token: string): void;
}
/**
 * Claude on Synapse's own loop (2026-09-30): the auth proxy (auth/proxy.ts) the Claude CLI already goes through. A call
 * gets a one-call proxy token (x-api-key); the proxy swaps it for the key, asks the budget and meters the stream; the
 * token is revoked with this call's own usage as the report, so the proxy records only what went past it unreported.
 */
export interface AnthropicLink {
  readonly url: string;
  issue(g: { botId: string | null }): string;
  revoke(token: string, reported?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearchRequests: number }): void;
  /** An Anthropic key is saved (the proxy holds it; this never returns it). */
  hasKey(): boolean;
}
export interface ProviderRuntime {
  /** The provider proxy; null (it couldn't start) refuses every call. */
  proxy: ProviderProxyLike | null;
  /** The Anthropic auth proxy, for Claude models on the Messages API; absent or null refuses every Claude call. */
  anthropic?: AnthropicLink | null;
  /** The spend budget, asked before every call (app.ts: the BudgetGate the auth proxy asks). */
  allow(botId: string | null): { ok: boolean; message: string | null };
  /** The user's data-sharing consent for the provider (ProviderConsentStore). */
  consented(provider: ProviderId): boolean;
  /** A key is saved for the provider (the proxy holds it; this never returns it). */
  hasKey(provider: ProviderId): boolean;
  fetch?: typeof fetch;
  /** 4.4 (0.1.6): the upstream's HTTP status for a call made with the SAVED key (never a candidate under test, never the
   *  proxy's own answers or the budget's), for the key's connector-health row. */
  onKeyStatus?(provider: Provider, status: number): void;
  /** Timeouts (spec §6): no first byte in 60 s, or silence for 120 s mid-stream. */
  firstByteMs?: number;
  idleMs?: number;
}

let runtime: ProviderRuntime | null = null;
/** app.ts sets this at boot. Unset, every provider call is refused (fail closed). */
export function setProviderRuntime(r: ProviderRuntime | null): void { runtime = r; }
export function providerRuntime(): ProviderRuntime | null { return runtime; }

/** 4.4 (0.1.6): report the saved key's status upstream; the proxy's own answers and the budget's refusal aren't the key's. */
function noteKeyStatus(r: ProviderRuntime, provider: ProviderId, keyOverride: string | undefined, res: Response): void {
  if (provider === "anthropic") return; // the Anthropic key's own health comes from the key check (auth/key-check.ts)
  if (!r.onKeyStatus || keyOverride || quirksFor(provider).authHeader !== "bearer") return;
  if (res.headers.get("x-synapse-proxy") || res.headers.get(BUDGET_HEADER) === "over") return;
  try { r.onKeyStatus(provider, res.status); } catch { /* health is advisory: never fails a call */ }
}

/** The auth proxy the host set for Claude processes, as a Claude link (the proxy answers a missing key itself). */
function authEnvLink(): AnthropicLink | null {
  const p = authProxy();
  return p ? { get url() { return p.url; }, issue: (g) => p.issue(g), revoke: (t, rep) => p.revoke(t, rep), hasKey: () => true } : null;
}

/** A failed call, already classified (spec §6). */
export class ProviderCallError extends Error {
  constructor(readonly cls: ProviderErrorClass, readonly status: number | null) {
    super(cls.message);
    this.name = "ProviderCallError";
  }
}

export interface ProviderCall {
  /** "<provider>:<model>" */
  ref: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** Called once with this call's usage however it ended, including a call that failed before any chunk. */
  onUsage?(u: RunUsage & { promptTokens: number; estimated: boolean }): void;
  /** The key test only: a candidate key, handed to the proxy for this one call (it never comes back). */
  keyOverride?: string;
}

export interface MeteredProviderStream {
  /** The parsed JSON of each SSE data line, in order. */
  chunks: AsyncIterable<unknown>;
  /** This call's usage and cost; settled once `chunks` ends or throws. Callers must iterate `chunks` to its end. */
  settled: Promise<RunUsage & { promptTokens: number; estimated: boolean }>;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // spec §12.10
const ERROR_BODY_MAX = 64 * 1024;
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * Dollars for a provider call (spec §5): the provider's own figure when it gives one (OpenRouter usage.cost), else the
 * catalog's list price (long-context tier and dated price changes included), $0 for a local model, and the highest
 * catalog rate for a model the catalog doesn't know, so spend is never under-counted.
 */
export function providerCostUsd(ref: string, u: CallUsage, day?: string): number {
  if (typeof u.costUsd === "number") return u.costUsd;
  // Claude: the list price with its cache multipliers (5-minute writes 1.25x, 1-hour writes 2x, reads 0.1x) and searches.
  const t = modelTarget(ref);
  if (t?.provider === "anthropic") return listCostUsd(t.model, u);
  const p = providerPrice(ref, u.promptTokens, day);
  return Math.round(((p.input * (u.inputTokens + u.cacheWriteTokens) + p.cachedInput * u.cacheReadTokens + p.output * u.outputTokens) / 1e6) * 1e10) / 1e10;
}

function estimate(requestBytes: number, responseChars: number): CallUsage {
  const input = Math.ceil(requestBytes / 4);
  return { inputTokens: input, outputTokens: Math.ceil(responseChars / 4), cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: input, estimated: true };
}

/**
 * Starts a streamed Chat Completions call. Throws ProviderCallError (budget, no key, HTTP error, timeout, network)
 * before any chunk; a failure mid-stream throws from `chunks`. Either way the call is metered.
 */
export async function providerFetch(meter: Meter, adapter: ProviderAdapter, call: ProviderCall): Promise<MeteredProviderStream> {
  const r = runtime;
  const parsed = modelTarget(call.ref);
  if (!parsed) throw new Error(`not a provider model: ${call.ref}`);
  const provider = parsed.provider;
  // Claude: the runtime's link to the auth proxy, else the auth proxy the host set for its Claude processes (the proxy
  // asks the same spend budget itself, as it does for the CLI).
  const claudeLink = provider === "anthropic" ? r?.anthropic ?? authEnvLink() : null;
  // No way to Claude at all (no auth proxy: no Anthropic key set up): said as the missing key it is.
  if (provider === "anthropic" && !claudeLink) throw new ProviderCallError(noKeyError(provider), null);
  // Fail closed: no runtime means no budget to ask, so nothing is sent (a Claude call's proxy asks it instead).
  if (!r && !claudeLink) throw new ProviderCallError(classifyProviderError(provider, 429, "", null, { budget: true }), null);
  if (r) {
    // Spec §4: consent is checked here as well as in the gateway (defense in depth).
    if (!r.consented(provider)) throw new ProviderCallError(consentError(provider), null);
    const allowed = r.allow(meter.botId);
    if (!allowed.ok) throw new ProviderCallError(classifyProviderError(provider, 429, "", null, { budget: true, budgetMessage: allowed.message }), 429);
  }
  // The way out: the provider proxy (a bearer token), or for Claude the auth proxy (x-api-key). Neither holds a key here.
  let target: { url: string; headers: Record<string, string>; release(reported?: CallUsage): void };
  if (provider === "anthropic") {
    const a = claudeLink;
    if (!a) throw new ProviderCallError(networkError(provider), null);
    if (!a.hasKey()) throw new ProviderCallError(noKeyError(provider), null);
    const token = a.issue({ botId: meter.botId });
    target = {
      url: `${a.url}/v1/messages`, headers: { "x-api-key": token, "anthropic-version": ANTHROPIC_VERSION },
      release: (u) => a.revoke(token, u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, webSearchRequests: u.webSearchRequests ?? 0 } : undefined),
    };
  } else {
    if (!r) throw new ProviderCallError(networkError(provider), null);
    const q = quirksFor(provider);
    if (q.authHeader === "bearer" && !call.keyOverride && !r.hasKey(provider)) throw new ProviderCallError(noKeyError(provider), null);
    if (!r.proxy) throw new ProviderCallError(networkError(provider), null);
    const proxy = r.proxy;
    const token = proxy.issue({ botId: meter.botId, provider, ...(call.keyOverride ? { keyOverride: call.keyOverride } : {}) });
    target = { url: `${proxy.url}/p/${provider}/chat/completions`, headers: { authorization: `Bearer ${token}` }, release: () => proxy.revoke(token) };
  }

  const payload = JSON.stringify(call.body);
  const requestBytes = Buffer.byteLength(payload);
  let responseChars = 0;
  let usage: CallUsage | null = null;
  let settle!: (u: RunUsage & { promptTokens: number; estimated: boolean }) => void;
  const settled = new Promise<RunUsage & { promptTokens: number; estimated: boolean }>((res) => { settle = res; });
  let done = false;
  let released = false;
  const release = (reported?: CallUsage) => { if (released) return; released = true; target.release(reported); };
  const finish = () => {
    if (done) return;
    done = true;
    const u = usage ?? estimate(requestBytes, responseChars);
    release(u);
    const run: RunUsage & { promptTokens: number; estimated: boolean } = {
      inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
      costUsd: providerCostUsd(call.ref, u), promptTokens: u.promptTokens, estimated: u.estimated === true,
    };
    recordMeteredRun({ purpose: meter.purpose, botId: meter.botId, model: call.ref, usage: run, sessionId: null });
    try { call.onUsage?.(run); } finally { settle(run); }
  };

  const ac = new AbortController();
  const onAbort = () => ac.abort(call.signal.reason);
  if (call.signal.aborted) ac.abort(call.signal.reason);
  else call.signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ac.abort(new Error("provider timeout")); }, ms);
  };
  // The grant ends with the call; finish() hands the proxy this call's usage as the report when it settles first.
  const disarm = () => { if (timer) clearTimeout(timer); timer = null; call.signal.removeEventListener("abort", onAbort); };
  const firstByteMs = r?.firstByteMs ?? 60_000;
  const idleMs = r?.idleMs ?? 120_000;

  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...target.headers };
  let res: Response;
  arm(firstByteMs);
  try {
    res = await (r?.fetch ?? fetch)(target.url, { method: "POST", headers, body: payload, signal: ac.signal });
  } catch (e) {
    disarm();
    // Anything after the request may have left (a timeout, an abort, a reset) is metered, estimated; only a connection
    // that never opened cost nothing.
    const code = String((e as { cause?: { code?: unknown } })?.cause?.code ?? "");
    usage = NEVER_CONNECTED.has(code) ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0 } : estimate(requestBytes, 0);
    finish();
    if (call.signal.aborted) throw e;
    throw new ProviderCallError(timedOut ? timeoutError(provider) : networkError(provider), null);
  }
  if (r) noteKeyStatus(r, provider, call.keyOverride, res);
  if (!res.ok) {
    let text = "";
    try { text = (await res.text()).slice(0, ERROR_BODY_MAX); } catch { /* keep the status */ }
    disarm();
    const proxyNote = res.headers.get("x-synapse-proxy");
    // An error response is not billed; an upstream that timed out may have started on the prompt (estimated).
    usage = proxyNote === "timeout" ? estimate(requestBytes, 0) : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0 };
    finish();
    if (proxyNote === "timeout") throw new ProviderCallError(timeoutError(provider), res.status);
    if (proxyNote === "unreachable") throw new ProviderCallError(networkError(provider), res.status);
    const budget = res.status === 429 && res.headers.get(BUDGET_HEADER) === "over";
    throw new ProviderCallError(classifyProviderError(provider, res.status, text, res.headers.get("retry-after"), { model: parsed.model, ...(budget ? { budget: true, budgetMessage: messageOf(text) } : {}) }), res.status);
  }
  const body = res.body;
  const meterOf = adapter.meter?.() ?? { push: (j: unknown) => adapter.usage((j as { usage?: unknown }).usage) };
  async function* chunks(): AsyncGenerator<unknown> {
    const sse = new SseParser();
    let bytes = 0;
    try {
      if (!body) return;
      const reader = body.getReader();
      try {
        for (;;) {
          arm(idleMs);
          let step: Awaited<ReturnType<typeof reader.read>>;
          try {
            step = await reader.read();
          } catch (e) {
            if (call.signal.aborted) throw e;
            throw new ProviderCallError(timedOut ? timeoutError(provider) : networkError(provider), null);
          }
          if (step.done) break;
          bytes += step.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new ProviderCallError(classifyProviderError(provider, 502, "response too large"), null);
          for (const ev of sse.push(step.value)) {
            if (ev.data === "[DONE]") continue;
            responseChars += ev.data.length;
            let j: unknown;
            try { j = JSON.parse(ev.data); } catch { continue; }
            const err = j && typeof j === "object" ? (j as { error?: unknown }).error : undefined;
            // An error sent mid-stream: Anthropic's typed errors keep their meaning (overloaded_error is a 529).
            if (err) throw new ProviderCallError(classifyProviderError(provider, statusOfErrorType((err as { type?: string }).type) ?? 500, ev.data), null);
            const u = meterOf.push(j);
            if (u) usage = u;
            yield j;
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } finally {
      disarm();
      finish();
    }
  }
  return { chunks: chunks(), settled };
}

function messageOf(body: string): string | null {
  try { const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message; return typeof m === "string" ? m : null; } catch { return null; }
}

export function consentError(provider: ProviderId): ProviderErrorClass {
  return { code: "BOT-E0405", message: STR_PROVIDER.noConsent(provider), retryable: false, trayTitle: STR_PROVIDER.noConsentTitle, inLoopRetry: false };
}

/**
 * A free GET through the proxy (the key test's model list, OpenRouter's live prices). Not a model call, so not
 * metered; still consented, and still only through the proxy.
 */
export async function providerGet(provider: Provider, path: "models" | "api/tags", o: { signal?: AbortSignal; keyOverride?: string } = {}): Promise<{ status: number; body: string }> {
  const r = runtime;
  if (!r || !r.proxy) throw new ProviderCallError(networkError(provider), null);
  if (!r.consented(provider)) throw new ProviderCallError(consentError(provider), null);
  const token = r.proxy.issue({ botId: null, provider, ...(o.keyOverride ? { keyOverride: o.keyOverride } : {}) });
  try {
    const res = await (r.fetch ?? fetch)(`${r.proxy.url}/p/${provider}/${path}`, { headers: { authorization: `Bearer ${token}` }, signal: o.signal ?? AbortSignal.timeout(30_000) });
    noteKeyStatus(r, provider, o.keyOverride, res);
    return { status: res.status, body: (await res.text()).slice(0, 8 * 1024 * 1024) };
  } finally {
    r.proxy.revoke(token);
  }
}

/**
 * A non-streamed model call through the proxy: OpenAI's Responses (web search) and Gemini's native generateContent
 * (Google Search grounding). Same rules as providerFetch — consent, budget, key, a one-call token — and metered the
 * same way when it ends, with `searchUsd` (the provider's per-search fee) added to its cost.
 */
export async function providerJson(meter: Meter, call: { ref: string; path: "responses" | `native/models/${string}:generateContent`; body: Record<string, unknown>; signal?: AbortSignal; searchUsd?: number; timeoutMs?: number }): Promise<unknown> {
  const r = runtime;
  const parsed = parseProviderModelRef(call.ref);
  if (!parsed) throw new Error(`not a provider model: ${call.ref}`);
  const provider = parsed.provider;
  if (!r) throw new ProviderCallError(classifyProviderError(provider, 429, "", null, { budget: true }), null);
  if (!r.consented(provider)) throw new ProviderCallError(consentError(provider), null);
  const allowed = r.allow(meter.botId);
  if (!allowed.ok) throw new ProviderCallError(classifyProviderError(provider, 429, "", null, { budget: true, budgetMessage: allowed.message }), 429);
  if (!r.hasKey(provider)) throw new ProviderCallError(noKeyError(provider), null);
  if (!r.proxy) throw new ProviderCallError(networkError(provider), null);
  const token = r.proxy.issue({ botId: meter.botId, provider });
  const payload = JSON.stringify(call.body);
  let u: CallUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0 };
  let billed = false;
  try {
    const signal = call.signal ?? AbortSignal.timeout(call.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await (r.fetch ?? fetch)(`${r.proxy.url}/p/${provider}/${call.path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: payload, signal });
    } catch (e) {
      u = estimate(Buffer.byteLength(payload), 0); // it may have reached the provider
      billed = true;
      if (signal.aborted) throw new ProviderCallError(timeoutError(provider), null);
      throw e instanceof ProviderCallError ? e : new ProviderCallError(networkError(provider), null);
    }
    noteKeyStatus(r, provider, undefined, res);
    const text = (await res.text()).slice(0, 16 * 1024 * 1024);
    if (!res.ok) {
      const budget = res.status === 429 && res.headers.get(BUDGET_HEADER) === "over";
      throw new ProviderCallError(classifyProviderError(provider, res.status, text, res.headers.get("retry-after"), { model: parsed.model, ...(budget ? { budget: true, budgetMessage: messageOf(text) } : {}) }), res.status);
    }
    const j = JSON.parse(text) as Record<string, unknown>;
    u = jsonUsage(j) ?? estimate(Buffer.byteLength(payload), text.length);
    billed = true;
    return j;
  } finally {
    r.proxy.revoke(token);
    const cost = providerCostUsd(call.ref, u) + (billed ? call.searchUsd ?? 0 : 0);
    recordMeteredRun({ purpose: meter.purpose, botId: meter.botId, model: call.ref, usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: Math.round(cost * 1e10) / 1e10 }, sessionId: null });
  }
}

/** Usage from a Responses answer (input_tokens / output_tokens) or a Gemini native one (usageMetadata). */
function jsonUsage(j: Record<string, unknown>): CallUsage | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const ru = j.usage as Record<string, unknown> | undefined;
  if (ru && (ru.input_tokens !== undefined || ru.output_tokens !== undefined)) {
    const cached = n((ru.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
    const input = n(ru.input_tokens);
    return { inputTokens: Math.max(0, input - cached), cacheReadTokens: cached, outputTokens: n(ru.output_tokens), cacheWriteTokens: 0, promptTokens: input };
  }
  const gm = j.usageMetadata as Record<string, unknown> | undefined;
  if (gm) {
    const prompt = n(gm.promptTokenCount);
    const cached = n(gm.cachedContentTokenCount);
    // Gemini's hidden thinking: everything past the prompt is output (phase 0: meter from the total).
    const out = Math.max(n(gm.candidatesTokenCount) + n(gm.thoughtsTokenCount), n(gm.totalTokenCount) - prompt);
    return { inputTokens: Math.max(0, prompt - cached), cacheReadTokens: cached, outputTokens: out, cacheWriteTokens: 0, promptTokens: prompt };
  }
  return null;
}
