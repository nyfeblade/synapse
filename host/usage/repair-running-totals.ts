import type { DatabaseSync } from "node:sqlite";

/** What the Usage view tells the user about figures rebuilt from pre-fix running totals. */
export interface CostHistory { repaired: number; estimated: number; before: number }

interface Row { requestId: string; botId: string; source: string; costUsd: number }

/**
 * One-time, idempotent repair of rows written before per-run accounting (usage/metered-query.ts). Those
 * rows hold the SDK's RUNNING total for the session, not the run's own cost. The runs table never stored a
 * session id, but a Bot runs one session at a time and the SDK carries the total across restarts, so per
 * Bot in time order: own cost = running total − the previous running total.
 *   - A zeroed total (crash/startup-error result) cost nothing and leaves the chain alone.
 *   - A total that went DOWN started a new count (a new session or /clear). The row is taken whole, but it
 *     may also include earlier turns a resumed transcript restored, so it is marked `estimated`.
 *   - Helper rows (`helper:*`) were each their own one-shot call and keep their value; where one Bot has
 *     several from the same streaming helper they may be running totals too, so they are marked `estimated`.
 * Every repaired row keeps its original value in `rawCostUsd`; `costBasis` goes from NULL to `derived` or
 * `estimated`, and only NULL rows are ever touched, so running it again changes nothing.
 */
export function repairRunningTotals(db: DatabaseSync, now: number): { repaired: number; estimated: number } {
  const legacy = db.prepare("SELECT requestId, botId, source, costUsd FROM runs WHERE costBasis IS NULL ORDER BY botId, startedAt, rowid").all() as unknown as Row[];
  if (!legacy.length) return { repaired: 0, estimated: 0 };
  const set = db.prepare("UPDATE runs SET costUsd = ?, rawCostUsd = ?, costBasis = ?, purpose = COALESCE(purpose, ?) WHERE requestId = ? AND costBasis IS NULL");
  const helperCount = new Map<string, number>();
  for (const r of legacy) if (r.source.startsWith("helper:")) helperCount.set(`${r.botId}\u0000${r.source}`, (helperCount.get(`${r.botId}\u0000${r.source}`) ?? 0) + 1);
  let estimated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    let bot: string | null = null;
    let prev: number | null = null;
    for (const r of legacy) {
      if (r.source.startsWith("helper:")) {
        const est = (helperCount.get(`${r.botId}\u0000${r.source}`) ?? 0) > 1;
        if (est) estimated++;
        set.run(r.costUsd, r.costUsd, est ? "estimated" : "derived", r.source.slice("helper:".length), r.requestId);
        continue;
      }
      if (r.botId !== bot) { bot = r.botId; prev = null; }
      let own = r.costUsd;
      let basis = "derived";
      if (r.costUsd === 0) own = 0;
      else if (prev === null) own = r.costUsd;
      else if (r.costUsd >= prev) own = r.costUsd - prev;
      else { own = r.costUsd; basis = "estimated"; }
      if (r.costUsd !== 0) prev = r.costUsd;
      if (basis === "estimated") estimated++;
      set.run(Math.round(own * 1e10) / 1e10, r.costUsd, basis, "turn", r.requestId);
    }
    db.prepare("INSERT INTO kv(key, value) VALUES('costRepair', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: now, repaired: legacy.length, estimated }));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { repaired: legacy.length, estimated };
}
