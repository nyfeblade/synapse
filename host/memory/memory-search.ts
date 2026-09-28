import type { Fact } from "./facts";
import { scopeLabel, type MemoryStore, type Scope } from "./memory-store";

/**
 * Bug #61: the Bot folder (its own memory included) is host-private, so a Bot finds the facts its memory section
 * didn't show through the host (SearchHistory), never by grepping files. Searches what this Bot may read: its own
 * memory (the Bot id is the host's, never an argument), the shared user memory and the projects it joined. Every
 * query word (3+ letters, or a number) must start a word of the fact; newest first.
 */
export function searchMemory(store: MemoryStore, botId: string, query: string): { f: Fact; where: string }[] {
  const words = query.toLowerCase().match(/\p{L}{3,}|\p{N}+/gu) ?? [];
  if (!words.length) return [];
  const scopes: Scope[] = [{ kind: "agent", botId }, ...store.userShardOwners().map((o): Scope => ({ kind: "user", botId: o })), ...store.teamShardOwners().map((o): Scope => ({ kind: "team", botId: o })),
    ...store.projects(botId).map((slug): Scope => ({ kind: "project", botId, slug }))];
  return scopes.flatMap((s) => store.all(s).map((f) => ({ f, where: scopeLabel(s) })))
    .filter(({ f }) => { const toks = f.content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; return words.every((w) => toks.some((t) => t.startsWith(w))); })
    .sort((a, b) => b.f.createdAt - a.f.createdAt);
}
