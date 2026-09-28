/**
 * Token-cost comparison, part 1: the policies. Every constant carries its source and one of
 *   [measured]   read off a real run (our CLI's /context accounting, or the box's usage.db),
 *   [documented] stated in our code or in a first-party source (Anthropic's docs),
 *   [inferred]   our estimate; each of these is either a range run low/mid/high, or a switch,
 *   [assumed]    a property of the modelled hosted agent (HOSTED_AGENT): a plain assumption about a
 *                typical hosted assistant app, run as a low/mid/high range where it matters.
 * Sources:
 *   PB   host/test/perf/prompt-budget.test.ts (CLI /context accounting, 2026-09-19 and 2026-09-21)
 *   LIM  shared/src/limits.ts, shared/src/models.ts
 *   USG  /home/box/.host/usage.db on the box, user runs 2026-09-19..21 (read-only copy)
 * No dollar prices anywhere: cost is a relative weight on input tokens, output is its own column.
 */

/** Chars per token for prose [inferred]. */
export const CHARS_PER_TOKEN = 4;
export const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

const MIN = 60_000;
export const TTL_5M = 5 * MIN;
export const TTL_1H = 60 * MIN;

/**
 * Relative input weights. Fresh 1.0, 5-minute cache write 1.25, cache read 0.1 are the brief's; a
 * 1-hour write is 2.0x base on Anthropic's published multipliers [documented: Anthropic prompt
 * caching docs]. Output is never blended in: it is reported as a separate column.
 */
export const WEIGHTS = { fresh: 1.0, write5m: 1.25, write1h: 2.0, read: 0.1 } as const;
export function writeWeight(ttlMs: number): number {
  return ttlMs > TTL_5M ? WEIGHTS.write1h : WEIGHTS.write5m;
}

/**
 * explicit: Anthropic-style. Claude Code puts a breakpoint on the last message, so every uncached
 * token of a call is a cache WRITE and fresh input is ~0 (USG: median inputTokens 4 per run) [measured].
 * automatic: prefix caching with no write premium; an uncached token is FRESH input. Assumed for
 * the hosted agent's API [assumed].
 */
export type CacheMode = "explicit" | "automatic";

export interface MemoryParams {
  /** Facts the extractor adds per memorable exchange (expected value) [inferred]. */
  factsPerMemorable: number;
  /** Share of new facts that are profile tier (rest are dated log) [inferred]. */
  profileShare: number;
  /** Tokens per rendered fact line "- (YYYY-MM-DD) fact" (~90 chars) [inferred]. */
  factTokens: number;
  /** Profile facts kept in the prompt (LIM memAgentProfileMax 100) [documented]. */
  profileMax: number;
  /** Recent log: ≤30 facts within 4,000 chars (LIM memAgentRecentMax/Chars) [documented]. */
  recentMax: number;
  recentTokens: number;
  /** Section headers and framing text around the facts [inferred]. */
  headerTokens: number;
}

export interface HelperCall {
  /** Which model pays: the turn's main model (billed with the chat) or a helper model (own column). */
  model: "main" | "helper";
  systemTokens: number;
  outputTokens: number;
}

export interface Policy {
  name: string;
  /** Context window W the compaction ratio applies to. */
  window: number;
  /** Compact once the context reaches this fraction of W. */
  compactAtRatio: number;
  /** "step": checked after every model call (a self-summarising agent); "idle": between messages only. */
  compactCheck: "step" | "idle";
  /** Planned lever: compact at this many tokens regardless of W (null = off). */
  historyCap: number | null;
  compactEveryTurns: number;
  /** The fixed prefix, re-sent on every call. */
  prefix: { tools: number; systemBase: number; systemRest: number };
  memory: MemoryParams;
  /** Envelope and hook text added to each user message (addresses, reminders, timestamps). */
  perMessageOverhead: number;
  /** Tokens a final, text-less call emits to end the turn. */
  endTurnTokens: number;
  /** Summary request, output and the messages kept verbatim after a compaction. */
  summary: { requestTokens: number; outputTokens: number; tailMessages: number };
  /** Restore block on the first message after a compaction (0 = none). */
  restoreTokens: number;
  /** Recall injection on a user message: fire rate and size (null = none). */
  recall: { fireRate: number; tokens: number } | null;
  extraction: HelperCall & { relatedFacts: number; batch?: number };
  episodes: HelperCall & { every: number; sideMaxTokens: number; atCompaction?: boolean };
  /** Dreaming synthesis (replaces extraction + episodes when on). */
  dreaming: { synthesisSystem: number; verifySystem: number; outputTokens: number; evidenceMaxTokens: number } | null;
  /** Planned lever: archive search. Schema on every call; one extra call + hits when it fires. */
  archiveSearch: { schemaTokens: number; fireRate: number; hitsTokens: number; argTokens: number } | null;
  cache: { mode: CacheMode; ttlMs: number };
  /** Token diet (1): a final SendMessage ends the turn, so there is no closing call (default false). */
  endTurnOnSend?: boolean;
  /** cost-diet-2 lever 1: per-message model routing (absent = off). */
  route?: RoutePolicy | null;
  /** cost-diet-2 lever 3: a deferred tool's ToolSearch cost (absent = every tool up front). */
  deferredTool?: { fireRate: number; argTokens: number; schemaTokens: number } | null;
}

// ---------------------------------------------------------------------------------------------
// HOSTED_AGENT: the comparison target (a typical hosted assistant app, modelled from assumptions)
// ---------------------------------------------------------------------------------------------
export type Variant = "low" | "mid" | "high";

/**
 * The modelled hosted agent: a typical hosted assistant app that sends one large fixed system prompt
 * and a full set of tool schemas on every call. System prompt ~20–30k tokens [assumed range].
 */
export const HOSTED_SYSTEM: Record<Variant, number> = { low: 20_000, mid: 25_000, high: 30_000 };
/** Tool schemas: about 50 tools, ~30–40k tokens on the wire [assumed range]. */
export const HOSTED_TOOLS: Record<Variant, number> = { low: 30_000, mid: 35_000, high: 40_000 };

/** Memory: the same budgets as ours (LIM memAgent*), so the comparison isolates everything else; fact yield and size [inferred]. */
const MEMORY: MemoryParams = {
  factsPerMemorable: 0.35, profileShare: 0.3, factTokens: 23,
  profileMax: 100, recentMax: 30, recentTokens: tok(4000), headerTokens: 150,
};

export function hostedAgent(v: Variant, o: { dreaming?: boolean } = {}): Policy {
  return {
    name: `HOSTED_AGENT ${v}${o.dreaming ? " +dreaming" : ""}`,
    // A 200k window [assumed].
    window: 200_000,
    // It summarises itself once the context reaches 90% of the window, checked after every model call [assumed].
    compactAtRatio: 0.9, compactCheck: "step", historyCap: null, compactEveryTurns: 1000,
    // Wire order: tools, base prompt, frozen memory/profile, then the rest of the system prompt [assumed].
    prefix: { tools: HOSTED_TOOLS[v], systemBase: Math.round(HOSTED_SYSTEM[v] * 0.8), systemRest: Math.round(HOSTED_SYSTEM[v] * 0.2) },
    memory: MEMORY,
    // Per-message framing (addressing, timestamps, reminders): the same size as ours, calibrated on USG [inferred].
    perMessageOverhead: 400,
    endTurnTokens: 10,
    // The summary request, its length and the preserved tail [inferred].
    summary: { requestTokens: 300, outputTokens: 3_000, tailMessages: 2 },
    // After a summary the system prompt is simply re-sent; there is no restore block [assumed].
    restoreTokens: 0,
    recall: null, // No per-message recall injection; memory lives in the frozen block [assumed].
    // Memory extraction after memorable exchanges, billed on the turn's MAIN model [assumed]; prompt and
    // output sizes [inferred] (ours is 1,808 chars; theirs assumed similar).
    extraction: { model: "main", systemTokens: 500, outputTokens: 40, relatedFacts: 10 },
    // An episode note every 6 turns, each side capped at 2,000 chars, on the turn's model [assumed].
    episodes: { model: "main", systemTokens: 200, outputTokens: 60, every: 6, sideMaxTokens: tok(2000) },
    // Optional nightly "dreaming": a synthesis and a verification pass over up to 8,000 chars of evidence
    // per side [assumed]; prompt sizes [inferred]. Off by default.
    dreaming: o.dreaming ? { synthesisSystem: 1_500, verifySystem: 800, outputTokens: 300, evidenceMaxTokens: tok(16_000) } : null,
    archiveSearch: null,
    // Automatic prefix caching; a 5-minute TTL [assumed].
    cache: { mode: "automatic", ttlMs: TTL_5M },
  };
}

// ---------------------------------------------------------------------------------------------
// SYNAPSE_TODAY
// ---------------------------------------------------------------------------------------------

/**
 * PB, lazy tools, measured 2026-09-21 (CLI 2.1.277): system prompt 6,083 · system tools 11,450 ·
 * MCP tools 7,463 · skills 1,556 = 26,552 tokens per call [measured].
 */
export const SYNAPSE_PREFIX_LAZY = { system: 6_083, tools: 11_450 + 7_463 + 1_556 };
/** PB, fresh Bot before lazy tools, 2026-09-19: 5,996 + 13,181 + 7,465 + 1,556 = 28,199 [measured]. */
export const SYNAPSE_PREFIX_PRE_LAZY = { system: 5_996, tools: 13_181 + 7_465 + 1_556 };

export interface SynapseOpts {
  prefix?: { system: number; tools: number };
  /** Sonnet 5 / Opus 5 spawn with [1m] (LIM spawnModelId); Haiku / Fable stay on 200k. */
  window?: number;
  ttlMs?: number;
}

export function synapseToday(o: SynapseOpts = {}): Policy {
  const p = o.prefix ?? SYNAPSE_PREFIX_LAZY;
  const ttl = o.ttlMs ?? TTL_5M;
  return {
    name: `SYNAPSE_TODAY${ttl > TTL_5M ? " ttl=1h" : ""}`,
    // contextWindow(): 1,000,000 for [1m] models, which Sonnet 5 / Opus 5 use (LIM models.ts) [documented].
    window: o.window ?? 1_000_000,
    // idleCompactRatio 0.7 once idle, compactEveryTurns 1000 (LIM; host/context/compactor.ts) [documented].
    compactAtRatio: 0.7, compactCheck: "idle", historyCap: null, compactEveryTurns: 1000,
    // Claude Code wire order: tools, then system (our append carries the frozen memory, MEM-05) [documented].
    prefix: { tools: p.tools, systemBase: p.system, systemRest: 0 },
    memory: MEMORY, // LIM memAgent* [documented]
    // Hook text per user message (automation status, reply reminders, envelopes). Calibrated: USG shows
    // ~1.1k tokens of context growth per 2-call casual message (bots 010b30, cd614d) [measured].
    perMessageOverhead: 400,
    endTurnTokens: 10,
    // host/prompts/orig/compact.md request (1,189 chars) [measured]; summary length [inferred].
    // Claude Code compaction keeps no verbatim tail [documented: compact_boundary replaces history].
    summary: { requestTokens: tok(1189), outputTokens: 3_000, tailMessages: 0 },
    // buildRestoreBlock is capped at restoreMaxChars 6,000 (LIM; host/context/restore.ts) [documented];
    // typical fill ~60% [inferred].
    restoreTokens: tok(3600),
    // recallMaxChars 900 (LIM; host/memory/recall.ts) [documented]; fire rate [inferred]: it needs
    // bm25n ≥ 0.35 and ≥2 matched terms on a fact NOT already in the frozen block.
    recall: { fireRate: 0.25, tokens: tok(900) },
    // Haiku 4.5 one-shot (host/brain/one-shot.ts, HELPER_MODEL) after memorable exchanges; prompt
    // orig/memory-extraction.md 1,808 chars [measured]; output [inferred].
    extraction: { model: "helper", systemTokens: tok(1808), outputTokens: 40, relatedFacts: 10 },
    // episodeEveryTurns 6, episodeSideMax 2000 (LIM); orig/memory-episode.md 556 chars [measured].
    episodes: { model: "helper", systemTokens: tok(556), outputTokens: 60, every: 6, sideMaxTokens: tok(2000) },
    dreaming: null,
    archiveSearch: null,
    // Claude Code's default cache TTL is 5 minutes [documented]; writes dominate on a gap (USG).
    cache: { mode: "explicit", ttlMs: ttl },
  };
}

// ---------------------------------------------------------------------------------------------
// SYNAPSE_PLANNED — every lever is a switch
// ---------------------------------------------------------------------------------------------
export interface Levers {
  /** ~180k history cap (planned; the hosted agent's budget under our smaller prefix) [inferred]. */
  cap?: boolean;
  /** Archive search when history is capped (planned) [inferred sizes]. */
  archive?: boolean;
  /** Standalone prompt: −41% of the system block (docs/differentiators.md, measured 2026-09-20) [measured]. */
  standalone?: boolean;
  /** Built-in tool trim: −4k to −7k (planned); mid 5.5k [inferred]. */
  trim?: boolean;
  ttlMs?: number;
}
export const PLANNED_HISTORY_CAP = 180_000;
export const STANDALONE_SAVING = 0.41;
export const TOOL_TRIM: Record<Variant, number> = { low: 4_000, mid: 5_500, high: 7_000 };
/** Archive search: schema ~350 tokens (one always-loaded tool), 5 hits × ~150 tokens, fires on 10% of messages [inferred]. */
export const ARCHIVE = { schemaTokens: 350, fireRate: 0.1, hitsTokens: 750, argTokens: 40 };

export function synapsePlanned(l: Levers, o: SynapseOpts = {}): Policy {
  const base = synapseToday({ ...o, ttlMs: l.ttlMs ?? o.ttlMs });
  const on = (["cap", "archive", "standalone", "trim"] as const).filter((k) => l[k]);
  const sys = l.standalone ? Math.round(base.prefix.systemBase * (1 - STANDALONE_SAVING)) : base.prefix.systemBase;
  const tools = base.prefix.tools - (l.trim ? TOOL_TRIM.mid : 0) + (l.archive ? ARCHIVE.schemaTokens : 0);
  return {
    ...base,
    name: `SYNAPSE_PLANNED ${on.length === 4 ? "all levers" : on.join("+") || "none"}${(l.ttlMs ?? 0) > TTL_5M ? " ttl=1h" : ""}`,
    historyCap: l.cap ? PLANNED_HISTORY_CAP : null,
    prefix: { tools, systemBase: sys, systemRest: 0 },
    archiveSearch: l.archive ? ARCHIVE : null,
  };
}

// ---------------------------------------------------------------------------------------------
// SYNAPSE_SHIPPED — today's everyday Bot, and the cost-diet-2 levers on top of it
// ---------------------------------------------------------------------------------------------

/**
 * The per-call prefix of a fresh everyday Bot on the Bots' default model, sonnet-5, from the CLI's own
 * /context (context-budget.probe "measures an everyday Bot before and after", 2026-09-21; pinned in
 * engineering/lean-profile.ts EVERYDAY_PROFILE_MEASURED) [measured]. Standalone prompt, lazy tools, no
 * Glob/Grep: the token diet as shipped. Rows: system prompt · system tools + MCP tools + skills.
 */
export const PREFIX_SHIPPED = { system: 4_902, tools: 3_203 + 7_849 + 2_074 };
/** Lever 2 alone: no built-in Bash (System tools 3,203 -> 1,719 on sonnet-5) [measured]. */
export const PREFIX_NO_BASH = { system: 4_902, tools: 1_719 + 7_849 + 2_074 };
/** Lever 3 alone: the everyday up-front set (MCP tools 7,849 -> 2,111) [measured]. */
export const PREFIX_UP_FRONT = { system: 4_902, tools: 3_203 + 2_111 + 2_074 };
/** Levers 2 + 3: 10,806 a call [measured]. */
export const PREFIX_EVERYDAY = { system: 4_902, tools: 1_719 + 2_111 + 2_074 };
/** The same everyday Bot spawned on Haiku 4.5, the routed model: 10,640 a call [measured]. */
export const HAIKU_PREFIX = { system: 3_677, tools: 3_296 + 2_111 + 1_556 };
/**
 * Tokens of the same text on Haiku 4.5 vs Sonnet 5: the standalone system prompt counts 3,677 vs 4,902
 * (the CLI's /context, same prompt) = 0.75 [measured]. Sonnet 5 uses the newer tokenizer.
 */
export const HAIKU_TOKEN_RATIO = 0.75;
/** List price per MTok input (output is 5x each) [documented, claude-api skill]: Haiku 4.5 $1, Sonnet 5 $2, Opus 5 $5. Cache multipliers are the same on each. */
export const PRICE = { haiku: 1, sonnet: 2, opus: 5 } as const;

export interface RoutePolicy {
  /** always: every simple message; cold: only when the main model's cache has expired, then while messages stay simple. */
  mode: "always" | "cold";
  /** The cheap model's prefix and its token count for the same text, relative to the main model. */
  prefix: { system: number; tools: number };
  tokenRatio: number;
  /** Cheap / main list price (input and output alike). */
  priceRatio: number;
  /** Share of routed messages that escalate: the cheap attempt is paid and the message reruns on the main model [inferred]. */
  escalateRate: number;
  /** Route only while the context (main-model tokens) is under this: Haiku's window is 200k [documented], minus output and margin. */
  maxContext: number;
}
const route = (mode: RoutePolicy["mode"], main: "sonnet" | "opus"): RoutePolicy => ({
  mode, prefix: HAIKU_PREFIX, tokenRatio: HAIKU_TOKEN_RATIO, priceRatio: PRICE.haiku / PRICE[main], escalateRate: 0.1, maxContext: 150_000,
});
export const ROUTE_SONNET = { always: route("always", "sonnet"), cold: route("cold", "sonnet") };
export const ROUTE_OPUS = { always: route("always", "opus"), cold: route("cold", "opus") };

export interface Diet2 {
  /** Lever 2: no built-in Bash. */
  noBash?: boolean;
  /** Lever 3: the everyday up-front set; a deferred tool costs a ToolSearch call when a message needs one. */
  upFront?: boolean;
  /** Lever 1: model routing (off = null). */
  route?: RoutePolicy | null;
  /** Lever 4: memory extraction every N memorable exchanges (flushed at idle, at compaction and at the end). */
  memBatch?: number;
  /** Lever 4: episodes written at compaction (and when the pending list is full) instead of every 6 turns. */
  episodesAtCompaction?: boolean;
  /** Lever 6: the idle history cap (default 180k). */
  cap?: number;
  label?: string;
}
/** A deferred bot tool, when a work message needs one: one ToolSearch call and its schema into the history [inferred sizes; the box's everyday Bots used none in 51 turns, 5% assumed]. */
export const DEFERRED_TOOL = { fireRate: 0.05, argTokens: 30, schemaTokens: 600 };
/** Idle flush of a partial extraction batch [inferred: 10 minutes of quiet]. */
export const MEM_IDLE_FLUSH_MS = 10 * MIN;
export const EPISODE_PENDING_MAX = 24;

export function synapseShipped(d: Diet2 = {}, o: SynapseOpts = {}): Policy {
  const prefix = d.noBash && d.upFront ? PREFIX_EVERYDAY : d.noBash ? PREFIX_NO_BASH : d.upFront ? PREFIX_UP_FRONT : PREFIX_SHIPPED;
  const base = synapseToday({ ...o, prefix, ttlMs: TTL_1H });
  const on = [d.noBash && "noBash", d.upFront && "upFront", d.route && `route:${d.route.mode}${d.route.priceRatio < 0.3 ? "(opus)" : ""}`,
    d.memBatch && d.memBatch > 1 && `memBatch${d.memBatch}`, d.episodesAtCompaction && "episodes@compaction", d.cap && d.cap !== PLANNED_HISTORY_CAP && `cap${d.cap / 1000}k`].filter(Boolean);
  return {
    ...base,
    name: d.label ?? `SHIPPED${on.length ? ` +${on.join("+")}` : ""}`,
    historyCap: d.cap ?? PLANNED_HISTORY_CAP,
    // SearchHistory is already in the measured prefix (241 tokens on sonnet-5), so its schema adds nothing here.
    archiveSearch: { ...ARCHIVE, schemaTokens: 0 },
    endTurnOnSend: true,
    route: d.route ?? null,
    deferredTool: d.upFront ? DEFERRED_TOOL : null,
    extraction: { ...base.extraction, batch: d.memBatch ?? 1 },
    episodes: { ...base.episodes, atCompaction: !!d.episodesAtCompaction },
  };
}
