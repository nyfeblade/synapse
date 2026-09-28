import { importanceOf } from "./facts";
import { allScopes } from "./ledger-migrate";
import { shardKey } from "./ledger";
import type { MemoryStore, Scope } from "./memory-store";
import type { IndexedFact, RecallIndex } from "./recall-index";

export { shardKey };

export function indexScope(index: RecallIndex, store: MemoryStore, s: Scope): void {
  const facts: IndexedFact[] = store.all(s).map((f) => ({
    factId: f.id, scope: s.kind, owner: s.botId, project: s.kind === "project" ? s.slug : null, kind: f.kind, content: f.content, createdAt: f.createdAt, importance: importanceOf(f.kind),
  }));
  index.replaceShard(shardKey(s), facts);
}

/** Boot: every Bot's agent shard and project shards of every member, and every writer's user and team shards. */
export function reindexAll(d: { index: RecallIndex; store: MemoryStore; botIds: string[] }): void {
  const keep = new Set<string>();
  for (const s of allScopes(d.store, d.botIds)) { keep.add(shardKey(s)); indexScope(d.index, d.store, s); }
  // The index persists across restarts: drop shards whose owner (or project membership) is gone.
  for (const shard of d.index.shards()) if (!keep.has(shard)) d.index.replaceShard(shard, []);
}

export function startRecallSync(d: { index: RecallIndex; store: MemoryStore }): () => void {
  return d.store.subscribe((s) => indexScope(d.index, d.store, s));
}
