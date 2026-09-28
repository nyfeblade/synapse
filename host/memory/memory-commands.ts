import type { MemoryFactView, MemoryHistoryView, MemoryProvenanceView, MemoryScopeRef } from "@synapse/shared";
import type { CommandHandlers } from "../gateway/server";
import { GatewayError } from "../gateway/errors";
import { looksLikeSecret } from "./extractor";
import type { Fact } from "./facts";
import { ledgerRef, type LedgerRow } from "./ledger";
import type { MemoryStore, Scope } from "./memory-store";

export interface MemoryCommandDeps {
  store: MemoryStore;
  botExists(id: string): boolean;
  nameOf(id: string): string;
  /** The Bot's vault values (ORIG-12), for the same guard the extractor applies (§05.1). */
  secrets(id: string): string[];
  /** The Phase 3 scanner's redact (raw, base64, hex and URL forms). A line it would change is a line that holds a secret. */
  redact?(id: string, text: string): string;
}

/** The shared scopes: every Bot's shard is one list on screen, since every Bot reads all of them. */
const SHARED = new Set(["user", "team"]);

/**
 * MEM-09: the memory screen's reads and writes.
 *
 * Every write goes through MemoryStore, so the markdown files stay the source of truth for what is current and the
 * recall index follows them (recall-sync subscribes to the store). Nothing here re-renders the Bot's prompt: MEM-05
 * freezes the memory section per compaction epoch, and the screen says so.
 *
 * Memory provenance: each fact carries where it came from (the ledger row: Bot, date, source, chat message) and what
 * it replaced. An edit is a correction: a user-sourced fact at confidence 1 that supersedes the old one, which stays
 * as history. Delete is Forget: the fact and its history leave the ledger too.
 *
 * Secrets: a line that looks like a secret — the extractor's patterns, a vault value, or anything the
 * scanner would redact — is sent with `content: null`. Its text never leaves the host; it can still
 * be deleted by id. Add and edit refuse such text, so the screen is never how one gets in.
 */
export function createMemoryCommands(d: MemoryCommandDeps): CommandHandlers {
  const requireBot = (id: string) => {
    if (!d.botExists(id)) throw new GatewayError("NOT_FOUND", "No such Bot.", 404);
  };
  const secretsFor = (ids: string[]) => [...new Set(ids.flatMap((i) => d.secrets(i)))];
  const isSecret = (text: string, ids: string[]) =>
    looksLikeSecret(text, secretsFor(ids)) || (d.redact ? ids.some((i) => d.redact!(i, text) !== text) : false);
  const refuseSecret = (text: string, ids: string[]) => {
    if (isSecret(text, ids)) throw new GatewayError("LOOKS_LIKE_SECRET", "Not saved — that looks like a secret. Keep it in this Bot's Secrets instead.");
  };
  const owners = (kind: "user" | "team") => (kind === "user" ? d.store.userShardOwners() : d.store.teamShardOwners());
  /** The shard a write lands in. `owner` only means something for a shared scope, and only for a Bot that has a shard. */
  const scopeOf = (botId: string, ref: MemoryScopeRef | undefined, owner?: string): Scope => {
    if (!ref || ref.kind === "agent") return { kind: "agent", botId };
    if (ref.kind === "user" || ref.kind === "team") {
      if (owner && owner !== botId && !owners(ref.kind).includes(owner)) throw new GatewayError("NO_SUCH_FACT", "That memory isn't there any more.", 404);
      return { kind: ref.kind, botId: owner ?? botId };
    }
    const slug = String(ref.slug ?? "").trim().toLowerCase();
    const err = d.store.checkProjectScope(botId, slug);
    if (err) throw new GatewayError("NO_PROJECT", `Not saved — ${err}.`);
    return { kind: "project", botId, slug };
  };
  const botName = (id: string | null) => (id ? d.nameOf(id) : null);
  const provenance = (r: LedgerRow): MemoryProvenanceView => ({
    botId: r.botId, botName: botName(r.botId), recordedAt: r.recordedAt, source: r.source, confidence: r.confidence,
    chatBotId: r.messageId && r.chatId && d.botExists(r.chatId) ? r.chatId : null, messageId: r.messageId && r.chatId && d.botExists(r.chatId) ? r.messageId : null,
  });
  const view = (s: Scope, f: Fact, viewer: string, owner?: string): MemoryFactView => {
    const who = owner ? [viewer, owner] : [viewer];
    const row = d.store.ledger?.current(ledgerRef(s).shard, f.id) ?? null;
    const history: MemoryHistoryView[] = row ? d.store.ledger!.history(row.id).map((h) => ({
      content: isSecret(h.text, who) ? null : h.text, validFrom: h.validFrom, validTo: h.validTo, source: h.source, botName: botName(h.botId),
    })) : [];
    return {
      id: f.id, date: f.date, tier: f.tier, kind: f.kind,
      content: isSecret(f.content, who) ? null : f.content,
      ...(owner ? { owner, ownerName: d.nameOf(owner) } : {}),
      ...(row ? { provenance: provenance(row), history } : {}),
    };
  };

  return {
    getAgentMemories: ({ id, scope }) => {
      requireBot(id);
      const projects = d.store.projects(id);
      if (!scope) return { facts: [], projects };
      if (scope.kind === "user" || scope.kind === "team") {
        const kind = scope.kind;
        const facts = owners(kind).flatMap((owner) => d.store.all({ kind, botId: owner }).map((f) => view({ kind, botId: owner }, f, id, owner)));
        return { facts, projects };
      }
      const s = scopeOf(id, scope);
      return { facts: d.store.all(s).map((f) => view(s, f, id)), projects };
    },
    addAgentMemory: ({ id, scope, content, tier }) => {
      requireBot(id);
      const s = scopeOf(id, scope);
      refuseSecret(content, [id]);
      const r = d.store.add(s, { content, tier: tier === "profile" ? "profile" : "log", kind: tier === "note" ? "note" : "fact" }, { botId: null, chatId: null, messageId: null, source: "user", confidence: 1 });
      return { added: r.added, fact: view(s, r.fact, id, SHARED.has(s.kind) ? id : undefined) };
    },
    updateAgentMemory: ({ id, scope, factId, owner, content }) => {
      requireBot(id);
      const s = scopeOf(id, scope, owner);
      refuseSecret(content, [id, s.botId]);
      return { fact: view(s, d.store.replace(s, factId, content), id, SHARED.has(s.kind) ? s.botId : undefined) };
    },
    deleteAgentMemory: ({ id, scope, factId, owner }) => {
      requireBot(id);
      return { removed: d.store.removeById(scopeOf(id, scope, owner), factId) !== null };
    },
    clearAgentMemories: ({ id, scope }) => {
      requireBot(id);
      // A shared scope is one list on screen and every Bot reads all of it, so clearing it clears every shard
      // (the confirmation says so). Leaving other Bots' shards would show a "cleared" list still full.
      if (scope.kind === "user" || scope.kind === "team") {
        const kind = scope.kind;
        return { removed: owners(kind).reduce((n, owner) => n + d.store.clear({ kind, botId: owner }), 0) };
      }
      return { removed: d.store.clear(scopeOf(id, scope)) };
    },
  };
}
