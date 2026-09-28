import { ledgerRef, type FactLedger } from "./ledger";
import type { MemoryStore, Scope } from "./memory-store";

/** Every memory shard the host knows: each Bot's own and project shards, and every writer's user and team shards. */
export function allScopes(store: MemoryStore, botIds: string[]): Scope[] {
  const out: Scope[] = [];
  for (const botId of botIds) {
    out.push({ kind: "agent", botId });
    for (const slug of store.projects(botId)) out.push({ kind: "project", botId, slug });
  }
  for (const botId of new Set([...botIds, ...store.userShardOwners()])) out.push({ kind: "user", botId });
  for (const botId of new Set([...botIds, ...store.teamShardOwners()])) out.push({ kind: "team", botId });
  return out;
}

/**
 * Boot: imports the facts written before the ledger existed (or outside it, e.g. a dreaming pass, which writes
 * the files directly) with provenance "migrated". Idempotent: a fact already current in its shard is skipped.
 * Import only: it never supersedes or rewrites a line, so existing memory reads exactly as before.
 */
export function migrateMemoryToLedger(d: { store: MemoryStore; ledger: FactLedger; botIds: string[] }): number {
  let n = 0;
  for (const s of allScopes(d.store, d.botIds)) n += d.ledger.migrate(ledgerRef(s), d.store.all(s));
  return n;
}
