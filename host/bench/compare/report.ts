import { hostedAgent, ROUTE_OPUS, ROUTE_SONNET, synapsePlanned, synapseShipped, synapseToday, SYNAPSE_PREFIX_PRE_LAZY, TTL_1H, type Policy } from "./params";
import { simulate, type SimResult } from "./simulate";
import { buildConversation, PROFILES, type Conversation, type Scale, type WorkloadSpec } from "./workload";

/** The policy set every workload runs: the hosted agent low/mid/high (+dreaming), ours today, and each lever. */
export function policySet(): Policy[] {
  return [
    hostedAgent("low"), hostedAgent("mid"), hostedAgent("high"), hostedAgent("mid", { dreaming: true }),
    synapseToday(), synapseToday({ ttlMs: TTL_1H }),
    synapsePlanned({ cap: true }), synapsePlanned({ cap: true, archive: true }),
    synapsePlanned({ standalone: true }), synapsePlanned({ trim: true }),
    synapsePlanned({ cap: true, archive: true, standalone: true, trim: true }),
    synapsePlanned({ cap: true, archive: true, standalone: true, trim: true, ttlMs: TTL_1H }),
  ];
}

export const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : 0;
};

export interface Row {
  policy: string;
  msgMed: number; msgP90: number; wMsgMed: number; outMsgMed: number;
  taskMed: number; wTaskMed: number;
  per30d: number; w30d: number; out30d: number; helper30d: number;
  compactions: number;
}
const input = (u: { fresh: number; write: number; read: number }) => u.fresh + u.write + u.read;

export function summarize(conv: Conversation, r: SimResult): Row {
  const ms = r.messages;
  const tasks = new Map<number, { i: number; w: number }>();
  for (const m of ms) {
    const t = tasks.get(m.session) ?? { i: 0, w: 0 };
    t.i += input(m.main); t.w += m.weighted;
    tasks.set(m.session, t);
  }
  const k = 30 / conv.days;
  const tot = (f: (m: (typeof ms)[number]) => number) => Math.round(ms.reduce((a, m) => a + f(m), 0) * k);
  return {
    policy: r.policy,
    msgMed: median(ms.map((m) => input(m.main))), msgP90: pct(ms.map((m) => input(m.main)), 0.9),
    wMsgMed: Math.round(median(ms.map((m) => m.weighted))), outMsgMed: median(ms.map((m) => m.main.output)),
    taskMed: median([...tasks.values()].map((t) => t.i)), wTaskMed: Math.round(median([...tasks.values()].map((t) => t.w))),
    per30d: tot((m) => input(m.main)), w30d: tot((m) => m.weighted), out30d: tot((m) => m.main.output), helper30d: tot((m) => m.helper.input + m.helper.output),
    compactions: r.compactions,
  };
}

export function runWorkload(spec: WorkloadSpec, scale: Scale, policies = policySet()): { conv: Conversation; rows: Row[] } {
  const conv = buildConversation(spec, scale);
  return { conv, rows: policies.map((p) => summarize(conv, simulate(conv, p))) };
}

const k = (n: number) => (n >= 10_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
export function formatTable(title: string, conv: Conversation, rows: Row[]): string {
  const head = ["policy", "in/msg med", "p90", "wtd/msg", "out/msg", "in/task", "wtd/task", "in/30d", "wtd/30d", "out/30d", "helper/30d", "compact"];
  const body = rows.map((r) => [r.policy, k(r.msgMed), k(r.msgP90), k(r.wMsgMed), k(r.outMsgMed), k(r.taskMed), k(r.wTaskMed), k(r.per30d), k(r.w30d), k(r.out30d), k(r.helper30d), String(r.compactions)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  return [`## ${title}: ${conv.messages.length} messages over ${conv.days} days`, line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line), verdict(title, rows)].join("\n");
}

/** One line: ours vs the hosted agent mid (and its low–high range), on cost-weighted input tokens per 30 days. */
export function verdict(title: string, rows: Row[]): string {
  const get = (name: string) => rows.find((r) => r.policy === name)!;
  const [lo, mid, hi] = ["HOSTED_AGENT low", "HOSTED_AGENT mid", "HOSTED_AGENT high"].map(get);
  const today = get("SYNAPSE_TODAY"), all = get("SYNAPSE_PLANNED all levers");
  const x = (a: Row, b: Row) => (a.w30d / b.w30d).toFixed(2);
  const levers = ["cap", "standalone", "trim"].map((l) => ({ l, d: 1 - get(`SYNAPSE_PLANNED ${l}`).w30d / today.w30d })).sort((a, b) => b.d - a.d);
  return `VERDICT ${title}: SYNAPSE_TODAY = ${x(today, mid!)}x HOSTED_AGENT mid (${x(today, hi!)}–${x(today, lo!)}x across high–low) in weighted input/30d; `
    + `all levers = ${x(all, mid!)}x; biggest lever: ${levers[0]!.l} (${(levers[0]!.d * 100).toFixed(0)}% off today).`;
}

// ---------------------------------------------------------------------------------------------
// Calibration against the box
// ---------------------------------------------------------------------------------------------

/**
 * USG: /home/box/.host/usage.db, read-only copy taken 2026-09-21, `runs` where source='user' and
 * startedAt within the last 2 days (135 runs; 127 on claude-sonnet-5 = 200k window, 8 on [1m]):
 *   select cacheRead, outputTokens, cacheWrite, inputTokens from runs where source='user' and
 *   startedAt >= (select max(startedAt) from runs) - 2*86400000
 * One row is one user turn, summed over its model calls [measured].
 */
export const REAL_USER_RUNS = {
  n: 135,
  cacheRead: { median: 99_465, p90: 434_230 },
  output: { median: 252, p90: 786 },
  cacheWrite: { median: 1_043, p90: 40_423 },
  input: { median: 4 },
};

/**
 * The regime those runs came from: fresh test Bots, a few to ~27 user turns each over two days, on
 * the 200k window, with the pre-lazy-tools prefix (28,199; lazy tools landed 2026-09-21). 13 Bots ×
 * 2 sessions × 5 messages ≈ 130 turns. Two free parameters, fitted on a grid to the cache-read median
 * and p90 [calibrated]: the work share, and the work length — USG's middle cluster (33 of 135 runs
 * read 80–150k ≈ 3–4 calls at ~30k) says test errands were often shorter than the brief's 3–8 calls.
 */
export const CALIBRATION_TOOL_SHARE = 0.5;
export const CALIBRATION_TOOL_CALLS: [number, number] = [2, 8];
export function calibration(toolShare = CALIBRATION_TOOL_SHARE, toolCalls = CALIBRATION_TOOL_CALLS) {
  const policy = synapseToday({ prefix: SYNAPSE_PREFIX_PRE_LAZY, window: 200_000 });
  const reads: number[] = [], outs: number[] = [], writes: number[] = [];
  for (let b = 0; b < 13; b++) {
    const spec: WorkloadSpec = { name: `calibration bot ${b}`, days: { small: 2, full: 2 }, sessions: { small: 2, full: 2 }, toolShare, toolCalls, seed: 100 + b };
    const conv = buildConversation(spec, "small");
    for (const m of simulate(conv, policy).messages) { reads.push(m.chat.read); outs.push(m.chat.output); writes.push(m.chat.write); }
  }
  const predicted = {
    n: reads.length,
    cacheRead: { median: median(reads), p90: pct(reads, 0.9) },
    output: { median: median(outs), p90: pct(outs, 0.9) },
    cacheWrite: { median: median(writes), p90: pct(writes, 0.9) },
  };
  const err = (a: number, b: number) => Math.round(((a - b) / b) * 1000) / 10;
  return {
    predicted,
    errorPct: {
      cacheReadMedian: err(predicted.cacheRead.median, REAL_USER_RUNS.cacheRead.median),
      cacheReadP90: err(predicted.cacheRead.p90, REAL_USER_RUNS.cacheRead.p90),
      outputMedian: err(predicted.output.median, REAL_USER_RUNS.output.median),
      outputP90: err(predicted.output.p90, REAL_USER_RUNS.output.p90),
    },
  };
}

export const WORKLOADS = [PROFILES.casual, PROFILES.toolHeavy, PROFILES.longLived];

// ---------------------------------------------------------------------------------------------
// cost-diet-2: each lever against today's shipped everyday Bot
// ---------------------------------------------------------------------------------------------
export function diet2Set(): Policy[] {
  return [
    synapseShipped(),
    synapseShipped({ noBash: true }), synapseShipped({ upFront: true }), synapseShipped({ noBash: true, upFront: true }),
    synapseShipped({ route: ROUTE_SONNET.always }), synapseShipped({ route: ROUTE_SONNET.cold }),
    synapseShipped({ route: ROUTE_OPUS.always }), synapseShipped({ route: ROUTE_OPUS.cold }),
    synapseShipped({ memBatch: 3 }), synapseShipped({ memBatch: 3, episodesAtCompaction: true }),
    synapseShipped({ cap: 150_000 }), synapseShipped({ cap: 120_000 }),
    synapseShipped({ noBash: true, upFront: true, memBatch: 3, cap: 150_000, label: "SHIPPED +diet2 (what ships ON)" }),
    synapseShipped({ noBash: true, upFront: true, memBatch: 3, cap: 150_000, route: ROUTE_SONNET.always, label: "SHIPPED +diet2 +Save usage ON" }),
  ];
}
export interface Diet2Row extends Row { outEq30d: number; helperPer100: number; routedShare: number; extracted: number }
export function runDiet2(spec: WorkloadSpec, scale: Scale): { conv: Conversation; rows: Diet2Row[] } {
  const conv = buildConversation(spec, scale);
  const rows = diet2Set().map((p) => {
    const r = simulate(conv, p);
    const k = 30 / conv.days;
    const helper = r.messages.reduce((a, m) => a + m.helper.input + m.helper.output, 0);
    return {
      ...summarize(conv, r),
      outEq30d: Math.round(r.messages.reduce((a, m) => a + m.outEq, 0) * k),
      helperPer100: Math.round((helper / r.messages.length) * 100),
      routedShare: r.messages.filter((m) => m.routed).length / r.messages.length,
      extracted: r.extracted,
    };
  });
  return { conv, rows };
}
export function formatDiet2(title: string, conv: Conversation, rows: Diet2Row[]): string {
  const base = rows[0]!;
  const d = (a: number, b: number) => (b ? `${a - b >= 0 ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%` : "n/a");
  const head = ["policy", "wtd/msg", "Δ", "wtd/task", "Δ", "wtd/30d", "Δ", "out-eq/30d", "Δ", "helper/100 msgs", "Δ", "routed", "compact"];
  const body = rows.map((r) => [r.policy, k(r.wMsgMed), d(r.wMsgMed, base.wMsgMed), k(r.wTaskMed), d(r.wTaskMed, base.wTaskMed), k(r.w30d), d(r.w30d, base.w30d),
    k(r.outEq30d), d(r.outEq30d, base.outEq30d), k(r.helperPer100), d(r.helperPer100, base.helperPer100), `${Math.round(r.routedShare * 100)}%`, String(r.compactions)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ");
  return [`## cost-diet-2, ${title}: ${conv.messages.length} messages over ${conv.days} days (Δ vs SHIPPED; wtd = main-model price units)`, line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}
