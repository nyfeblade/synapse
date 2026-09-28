import { LIMITS_SCHED, type TranscriptEntry } from "@synapse/shared";

/** The same rough rule the usage estimates use: ~4 characters per token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * A Bot's own recent activity as a short digest, built in code (no model): what the user asked, what the Bot said,
 * its tool work summed by kind, its routine runs, and what it is waiting on. null when the Bot was idle in the window,
 * so an idle Bot costs nothing.
 */
export function digestFor(entries: TranscriptEntry[], o: { since: number; awaiting: string | null; runs: { name: string; status: string }[]; maxChars?: number }): string | null {
  const recent = entries.filter((e) => ("createdAt" in e ? e.createdAt : e.kind === "tool-call" ? e.startedAt : 0) >= o.since);
  const asks = recent.flatMap((e) => (e.kind === "message" && e.role === "user" && !("fromAgent" in e && e.fromAgent) ? [e.content] : []));
  const said = recent.flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  const work = new Map<string, { fmt(n: number): string; n: number }>();
  for (const e of recent) {
    if (e.kind !== "tool-call" || e.status === "running") continue;
    const m = e.metric;
    const k = m ? `${m.verb}|${m.noun}` : e.name;
    const cur = work.get(k) ?? { n: 0, fmt: m ? (n: number) => `${m.verb} ${n} ${n === 1 ? m.noun : m.nounPlural}` : (n: number) => `${e.name} ×${n}` };
    cur.n += m?.count ?? 1;
    work.set(k, cur);
  }
  const failed = recent.filter((e) => e.kind === "tool-call" && e.status === "error").length;
  if (!asks.length && !said.length && !work.size && !o.runs.length && !o.awaiting) return null;
  const lines = [
    ...asks.slice(-3).map((a) => `user asked: ${clip(a, 160)}`),
    ...said.slice(-3).map((s) => `bot said: ${clip(s, 200)}`),
    ...(work.size ? [`work: ${[...work.values()].map((w) => w.fmt(w.n)).slice(0, 6).join(", ")}`] : []),
    ...(failed ? [`failed steps: ${failed}`] : []),
    ...o.runs.slice(0, 4).map((r) => `routine ${r.name}: ${r.status}`),
    ...(o.awaiting ? [`waiting on: ${clip(o.awaiting, 160)}`] : []),
  ];
  const max = o.maxChars ?? LIMITS_SCHED.standupDigestMaxChars;
  let out = lines.join("\n");
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}
