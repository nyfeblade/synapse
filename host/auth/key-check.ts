import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MODEL_IDS, STR_AUTH, WEB_SEARCH_OFF_RE, classifyAnthropicError, hasLongContextArm, isModelId, type KeyCheckView, type ModelAccessView, type ModelId } from "@synapse/shared";
import { listPrice } from "../usage/list-price";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { BUDGET_HEADER, type ReportedTokens } from "./proxy";
import { ANTHROPIC_API } from "./test-connection";

/** The one message's output cap: a real answer, a few tokens at most. */
export const KEY_CHECK_MAX_TOKENS = 8;
/** Declared on the message (with tool_choice none, so no search runs): an organization with web search off refuses it. */
export const KEY_CHECK_WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 1 } as const;
const FILE = "key-check.json";
/** The key proxy's own answer when it can't reach Anthropic (proxy.ts). */
const PROXY_UNREACHABLE = /auth proxy couldn't reach Anthropic|didn't answer in time/i;

export interface KeyCheckSpend { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; webSearchRequests: number }
type Problem = NonNullable<KeyCheckView["problem"]>;
interface Outcome { works: boolean; problem: Problem | null; model: ModelId | null; webSearch: boolean | null }

const empty = (): KeyCheckView => ({ checkedAt: null, checking: false, works: null, problem: null, model: null, models: [], longContext: null, webSearch: null });

/**
 * Bug 281: the API-key check (after a key is saved, and Settings → Account → Check). Free first: the count_tokens model
 * probe (ModelAccess) and a count_tokens call that declares web search. Then ONE tiny real message (max_tokens 8, the
 * cheapest model the key reaches) through the box key proxy with a grant of its own, so the budget is asked and the
 * spend is metered like any other call; the check records that spend itself ("key-check") and reports it on release, so
 * the proxy doesn't count it again. What failed is said in the app's words (classifyAnthropicError): bad key, no credit,
 * rate limited, web search off, over budget, no model, no proxy, no network.
 */
export class KeyCheck {
  private s: KeyCheckView;
  private inFlight: Promise<KeyCheckView> | null = null;
  /** Bumps on every clear() (a new key): a check started under an older one never lands. */
  private gen = 0;

  constructor(private o: {
    /** hostPrivate/anthropic-auth: where the last answer is kept (no secrets). */
    dir: string;
    key(): string | null;
    /** The free count_tokens probe (ModelAccess.probe). */
    models(): Promise<ModelAccessView>;
    /** The running box key proxy, or null when it's down (the check never sends the key another way). */
    proxy(): { url: string; issue(g: { botId: string | null }): string; revoke(token: string, reported?: ReportedTokens): void } | null;
    /** The budget, asked before the message (the proxy asks again, as for every call). */
    allow(): { ok: boolean; message: string | null };
    /** The message's spend, for usage.db. */
    record(model: string, u: KeyCheckSpend): void;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    onChange?(v: KeyCheckView): void;
  }) {
    const raw = readJson<Partial<KeyCheckView>>(path.join(o.dir, FILE), {});
    this.s = { ...empty(), ...sanitize(raw), checking: false };
  }

  view(): KeyCheckView { return { ...this.s, models: [...this.s.models], checking: this.inFlight !== null }; }

  /** The key changed: the last answer was about the old one. */
  clear(): void {
    this.gen++;
    this.inFlight = null;
    this.s = empty();
    this.save();
    this.o.onChange?.(this.view());
  }

  run(): Promise<KeyCheckView> {
    if (this.inFlight) return this.inFlight;
    const gen = this.gen;
    const p: Promise<KeyCheckView> = this.check(gen).finally(() => {
      if (this.inFlight === p) { this.inFlight = null; this.o.onChange?.(this.view()); }
    });
    this.inFlight = p;
    this.o.onChange?.(this.view());
    return p;
  }

  private async check(gen: number): Promise<KeyCheckView> {
    const key = this.o.key();
    let access: ModelAccessView = { checkedAt: null, checking: false, models: {}, longContext: {} };
    let out: Outcome;
    if (!key) {
      out = { works: false, model: null, webSearch: null, problem: { kind: "no-key", title: STR_AUTH.noKeyTitle, detail: STR_AUTH.noKeyDetail, status: null } };
    } else {
      try { access = await this.o.models(); } catch { /* unknown: every model stays a candidate */ }
      out = await this.message(key, access);
    }
    if (gen !== this.gen) return this.view(); // the key changed meanwhile: this answer was about the old one
    const long = MODEL_IDS.filter((m) => hasLongContextArm(m)).map((m) => access.longContext[m]);
    this.s = {
      checkedAt: (this.o.now ?? Date.now)(), checking: false, ...out,
      models: MODEL_IDS.filter((m) => access.models[m] === true),
      longContext: long.includes(true) ? true : long.includes(false) ? false : null,
    };
    this.save();
    return { ...this.view(), checking: false }; // the answer: this run is done
  }

  private async message(key: string, access: ModelAccessView): Promise<Outcome> {
    // The cheapest model the key isn't known to be refused (an unchecked one counts: a bad key leaves all unknown).
    const model = MODEL_IDS.filter((m) => access.models[m] !== false).sort((a, b) => listPrice(a).input - listPrice(b).input)[0] ?? null;
    if (!model) return { works: false, model: null, webSearch: null, problem: { kind: "model-unavailable", title: STR_AUTH.noModels, detail: STR_AUTH.noModelsDetail, status: null } };
    let webSearch = await this.webSearchProbe(key, model);
    const a = (() => { try { return this.o.allow(); } catch { return { ok: false, message: null }; } })();
    if (!a.ok) return { works: false, model, webSearch, problem: { kind: "over-budget", title: STR_AUTH.overBudget, detail: a.message ?? STR_AUTH.overBudgetDetail, status: null } };
    const proxy = this.o.proxy();
    if (!proxy) return { works: false, model, webSearch, problem: { kind: "proxy-down", title: STR_AUTH.proxyDownTitle, detail: STR_AUTH.proxyDownDetail, status: null } };

    const withTool = webSearch !== false;
    const token = proxy.issue({ botId: null });
    let reported: ReportedTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };
    try {
      let res: Response;
      try {
        res = await (this.o.fetchFn ?? fetch)(`${proxy.url}/v1/messages`, {
          method: "POST",
          headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model, max_tokens: KEY_CHECK_MAX_TOKENS, stream: true, messages: [{ role: "user", content: "Hi" }],
            ...(withTool ? { tools: [KEY_CHECK_WEB_SEARCH_TOOL], tool_choice: { type: "none" } } : {}),
          }),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
        });
      } catch {
        return { works: false, model, webSearch, problem: problemOf(null) };
      }
      if (!res.ok) {
        const { type, message } = await errorOf(res);
        if (WEB_SEARCH_OFF_RE.test(message ?? "")) webSearch = false;
        if (res.status === 502 || res.status === 504) if (PROXY_UNREACHABLE.test(message ?? "")) return { works: false, model, webSearch, problem: problemOf(null) };
        // Bug 296: the budget ran out between this check's own ask and the proxy's: over budget, not rate limited.
        if (res.status === 429 && res.headers.get(BUDGET_HEADER) === "over") return { works: false, model, webSearch, problem: { kind: "over-budget", title: STR_AUTH.overBudget, detail: message ?? STR_AUTH.overBudgetDetail, status: null } };
        const ra = Number(res.headers.get("retry-after"));
        return { works: false, model, webSearch, problem: problemOf(res.status, type, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined, message) };
      }
      const r = await readStream(res);
      if (r.usage) {
        reported = { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens, cacheWriteTokens: r.usage.cacheWriteTokens, webSearchRequests: r.usage.webSearchRequests };
        try { this.o.record(model, r.usage); } catch (e) {
          reported = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 }; // the proxy records it instead
          log.warn("key check: spend could not be recorded", { error: String(e) });
        }
      }
      if (r.error) {
        if (WEB_SEARCH_OFF_RE.test(r.error.message ?? "")) webSearch = false;
        return { works: false, model, webSearch, problem: problemOf(r.error.type === "overloaded_error" ? 529 : 500, r.error.type, undefined, r.error.message) };
      }
      return { works: true, model, webSearch: withTool ? true : webSearch, problem: null };
    } finally {
      // Whatever went through the grant beyond what was recorded here goes to usage.db as the proxy's own count.
      proxy.revoke(token, reported);
    }
  }

  /** Free: count_tokens with web search declared. false = the organization has it off; null = unknown. */
  private async webSearchProbe(key: string, model: ModelId): Promise<boolean | null> {
    try {
      const r = await (this.o.fetchFn ?? fetch)(`${(this.o.baseUrl ?? ANTHROPIC_API).replace(/\/$/, "")}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], tools: [KEY_CHECK_WEB_SEARCH_TOOL] }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
      if (r.ok) { await r.body?.cancel().catch(() => {}); return null; } // counted, not proof: the message decides
      const { message } = await errorOf(r);
      return WEB_SEARCH_OFF_RE.test(message ?? "") ? false : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      const { checking: _c, ...kept } = this.s;
      writeJsonAtomic(path.join(this.o.dir, FILE), kept, 0o600);
    } catch (e) { log.warn("key check could not be saved", { error: String(e) }); }
  }
}

function problemOf(status: number | null, type?: string, retryAfterSec?: number, message?: string): Problem {
  const c = classifyAnthropicError(status, type, retryAfterSec, message);
  return { kind: c.kind, title: c.title, detail: c.detail, status, ...(c.retryAfterSec ? { retryAfterSec: c.retryAfterSec } : {}) };
}

async function errorOf(res: Response): Promise<{ type?: string; message?: string }> {
  try {
    const j = (await res.json()) as { error?: { type?: string; message?: string } };
    return { type: j.error?.type, message: j.error?.message };
  } catch { return {}; }
}

/**
 * The streamed answer's usage, by the API's contract: message_start opens it, each message_delta's usage is the
 * cumulative count (a field it carries replaces message_start's). An `error` event mid-stream is kept.
 */
async function readStream(res: Response): Promise<{ usage: KeyCheckSpend | null; error: { type?: string; message?: string } | null }> {
  type U = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } };
  let u: U | null = null;
  let error: { type?: string; message?: string } | null = null;
  const take = (data: string) => {
    let e: { type?: string; message?: { usage?: U }; usage?: U; error?: { type?: string; message?: string } };
    try { e = JSON.parse(data) as typeof e; } catch { return; }
    if (e.type === "message_start" && e.message?.usage) u = { ...e.message.usage };
    else if (e.type === "message_delta" && e.usage) u = { ...(u ?? {}), ...e.usage, cache_creation: e.usage.cache_creation ?? u?.cache_creation, server_tool_use: e.usage.server_tool_use ?? u?.server_tool_use };
    else if (e.type === "error") error = e.error ?? {};
  };
  const dec = new StringDecoder("utf8");
  let buf = "";
  const reader = res.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      buf += done ? dec.end() : dec.write(Buffer.from(value));
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) take(line.slice(5).trim());
      }
      if (done) break;
    }
  } catch { /* a cut stream: what arrived counts */ }
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const f = u as U | null;
  return {
    error,
    usage: f ? {
      inputTokens: n(f.input_tokens), outputTokens: n(f.output_tokens), cacheReadTokens: n(f.cache_read_input_tokens), cacheWriteTokens: n(f.cache_creation_input_tokens),
      cacheWrite1hTokens: n(f.cache_creation?.ephemeral_1h_input_tokens), webSearchRequests: n(f.server_tool_use?.web_search_requests),
    } : null,
  };
}

/** A kept answer, read back field by field (a hand-edited or older file never breaks the view). */
function sanitize(raw: Partial<KeyCheckView>): Partial<KeyCheckView> {
  const b = (v: unknown) => (typeof v === "boolean" ? v : null);
  const p = raw.problem;
  return {
    checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null,
    works: b(raw.works), longContext: b(raw.longContext), webSearch: b(raw.webSearch),
    model: isModelId(raw.model) ? raw.model : null,
    models: Array.isArray(raw.models) ? raw.models.filter(isModelId) : [],
    problem: p && typeof p === "object" && typeof p.title === "string" && typeof p.detail === "string" && typeof p.kind === "string"
      ? { kind: p.kind, title: p.title, detail: p.detail, status: typeof p.status === "number" ? p.status : null, ...(typeof p.retryAfterSec === "number" ? { retryAfterSec: p.retryAfterSec } : {}) }
      : null,
  };
}
