import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnUsage } from "../brain/types";
import { prepareAuthEnv } from "../auth/auth-env";
import { startClaudeQuery } from "../claude/spawn";

/**
 * The ONE place the host calls the Claude Agent SDK's `query` (guarded by test/usage/metering-guard.test.ts).
 * Every result that comes back is turned into that run's OWN usage and recorded, tagged by purpose and Bot.
 *
 * Why a delta: in the installed SDK (0.3.x) a result's `total_cost_usd` and `modelUsage` are RUNNING totals
 * for the whole query() call — cumulative across the turns of a streaming-input session — and a resumed or
 * forked session starts from the total its transcript saved, so even its first result carries earlier turns.
 * The SDK has no per-run cost field; `usage` is per turn but covers the main loop only (no subagents, no
 * compaction). So each run = this running total − the previous one of the same query, where the first one
 * of a resumed/forked query subtracts the last total recorded for the session it resumed. A total that went
 * DOWN is a fresh count (/clear, a new session, a transcript that restored nothing) and is taken whole; a
 * zeroed result (crash/startup error) counts nothing and leaves the chain alone.
 */
export type QueryFn = typeof sdkQuery;
export type QueryParams = { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options };

/** What a call was for. "turn" is a Bot's own conversation turn; everything else is background work. */
export type UsagePurpose =
  | "turn" | "compaction"
  | "extraction" | "episode" | "dreaming"
  | "coding"
  | "review" | "rule-compile" | "avatar" | "template-draft" | "setup"
  | (string & {}); // the structured one-shot helpers use their prompt's name (b2b-gate, schedule-parser, …)

export interface Meter {
  purpose: UsagePurpose; botId: string | null;
}
export interface RunUsage extends TurnUsage { costUsd: number }
export interface MeteredRun { purpose: UsagePurpose; botId: string | null; model: string; usage: RunUsage; sessionId: string | null }
export interface SessionTotals { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export interface UsageSink {
  record(r: MeteredRun): void;
  /** The last running total seen for a session, so a resumed query can subtract what its transcript restored. */
  lastTotals(sessionId: string): SessionTotals | null;
  noteTotals(sessionId: string, t: SessionTotals): void;
}

let sink: UsageSink | null = null;
/** app.ts points this at the UsageStore as soon as it exists. Unset (tests, evals), runs are still computed. */
export function setUsageSink(s: UsageSink | null): void { sink = s; }

const runOf = new WeakMap<object, RunUsage>();
/** The run's own usage for a result message that came through a metered query. */
export function runUsageOf(m: unknown): RunUsage | undefined {
  return m && typeof m === "object" ? runOf.get(m) : undefined;
}

const ZERO: SessionTotals = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

type ResultLike = { type: string; session_id?: string; total_cost_usd?: number; usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>> };

/** Per-query state: the previous running total, starting from the resumed session's last known one. */
class RunCounter {
  private prev: SessionTotals | null = null;
  private prevSearches = 0;
  /** Review round 3 re-review (P2): this run's web searches (already inside its costUsd), for the proxy to reconcile. */
  lastSearches = 0;
  constructor(private meter: Meter, private options: Options | undefined) {}

  observe(m: ResultLike): RunUsage {
    const mu = m.modelUsage && Object.keys(m.modelUsage).length ? Object.values(m.modelUsage) : null;
    const cum: SessionTotals = {
      costUsd: num(m.total_cost_usd),
      inputTokens: mu ? mu.reduce((a, x) => a + num(x.inputTokens), 0) : 0,
      outputTokens: mu ? mu.reduce((a, x) => a + num(x.outputTokens), 0) : 0,
      cacheReadTokens: mu ? mu.reduce((a, x) => a + num(x.cacheReadInputTokens), 0) : 0,
      cacheWriteTokens: mu ? mu.reduce((a, x) => a + num(x.cacheCreationInputTokens), 0) : 0,
    };
    // No modelUsage (older CLI, tests): the per-turn main-loop `usage` is the best token count there is.
    const u = m.usage ?? {};
    const turnTokens = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
    const turnSearches = num((u.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests);
    const cumSearches = mu ? mu.reduce((a, x) => a + num(x.webSearchRequests), 0) : 0;
    const zeroed = cum.costUsd === 0 && KEYS.every((k) => cum[k] === 0);
    if (zeroed) { this.lastSearches = 0; return { ...turnTokens, costUsd: 0 }; }
    const base = this.prev ?? this.baseline();
    const reset = cum.costUsd < base.costUsd - 1e-12 || (mu !== null && KEYS.some((k) => cum[k] < base[k]));
    const from = reset ? ZERO : base;
    this.prev = cum;
    // Running totals like the tokens: this run = the total minus the previous one of this query (a resumed query's
    // first result may carry searches its transcript restored; over-reporting here only makes the proxy report less).
    this.lastSearches = mu ? Math.max(0, cumSearches - (reset || cumSearches < this.prevSearches ? 0 : this.prevSearches)) : turnSearches;
    this.prevSearches = cumSearches;
    const sid = m.session_id ?? null;
    if (sid) sink?.noteTotals(sid, cum);
    const tokens = mu ? Object.fromEntries(KEYS.map((k) => [k, Math.max(0, cum[k] - from[k])])) as Record<(typeof KEYS)[number], number> : turnTokens;
    return { ...tokens, costUsd: Math.max(0, Math.round((cum.costUsd - from.costUsd) * 1e10) / 1e10) };
  }

  private baseline(): SessionTotals {
    const resumed = this.options?.resume;
    return (resumed && sink?.lastTotals(resumed)) || ZERO;
  }

  modelOf(m: ResultLike): string {
    const mu = m.modelUsage ?? {};
    const top = Object.entries(mu).sort((a, b) => num(b[1].costUSD) - num(a[1].costUSD))[0]?.[0];
    return this.options?.model ?? top ?? "unknown";
  }

  get tag(): Meter { return this.meter; }
}

/**
 * query(), metered. `meter.purpose === "turn"` runs are recorded by the usage store's onSettled (it has the
 * turn's requestId, source and status) from the brain's TurnResult, which takes its usage from runUsageOf();
 * every other purpose is recorded here, per result. `meter` is read at record time, so a pooled call (the
 * reviewer) can name its Bot once it is used.
 */
export function meteredQuery(meter: Meter, params: QueryParams, queryFn?: QueryFn): Query {
  // The API key (auth/auth-env.ts) is applied to THIS call's env as it starts, so every host model call uses the current one.
  // Through the auth proxy the process gets a per-spawn proxy token, revoked when this query ends or closes.
  const auth = prepareAuthEnv(params.options?.env, { botId: meter.botId });
  if (auth.env !== params.options?.env) params = { ...params, options: { ...params.options, env: auth.env } };
  let q: Query;
  try {
    q = startClaudeQuery(params as Parameters<QueryFn>[0], queryFn ?? sdkQuery); // review round 3 (S6): the env is checked there
  } catch (e) {
    auth.release();
    throw e;
  }
  const counter = new RunCounter(meter, params.options);
  // Review round 2 (P2): what this process's CLI reported, so the proxy can report what went through its token beyond it.
  const reported = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };
  const release = () => auth.release({ ...reported });
  const it = (async function* () {
    try {
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if ((m as { type?: string }).type === "result") {
        const r = m as unknown as ResultLike;
        const run = counter.observe(r);
        runOf.set(m, run);
        for (const k of KEYS) reported[k] += run[k];
        reported.webSearchRequests += counter.lastSearches;
        if (counter.tag.purpose !== "turn") sink?.record({ purpose: counter.tag.purpose, botId: counter.tag.botId, model: counter.modelOf(r), usage: run, sessionId: r.session_id ?? null });
      }
      yield m;
    }
    } finally {
      release();
    }
  })();
  return new Proxy(q as object, {
    get(target, p) {
      if (p === Symbol.asyncIterator) return () => it;
      if (p === "next" || p === "return" || p === "throw") return (it[p] as (...a: unknown[]) => unknown).bind(it);
      if (p === "close") return () => { release(); (Reflect.get(target, p, target) as (() => void) | undefined)?.call(target); };
      const v = Reflect.get(target, p, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Query;
}

/** A QueryFn that meters every call it makes, for code that takes a query function (conformance probes). */
export function meteredQueryFn(meter: Meter, queryFn?: QueryFn): QueryFn {
  return ((params: QueryParams) => meteredQuery(meter, params, queryFn)) as unknown as QueryFn;
}

/**
 * Multi-provider Bots: a provider call's own usage, recorded into the same sink as a Claude call's (usage/metered-provider.ts
 * is the only caller). "turn" runs go through the brain's TurnResult instead, exactly as for Claude.
 */
export function recordMeteredRun(r: MeteredRun): void {
  if (r.purpose !== "turn") sink?.record(r);
}
