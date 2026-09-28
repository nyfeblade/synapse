import { toolError, type BotToolExtensions } from "../tools/registry";
import { scopeLabel, type MemoryStore, type Scope } from "./memory-store";

export function createMemoryToolExtension(d: { store: MemoryStore }): BotToolExtensions {
  const scopeOf = (botId: string, a: Record<string, unknown>): Scope | string => {
    const kind = (a.scope as string | undefined) ?? "agent";
    if (kind === "user") return { kind: "user", botId };
    if (kind === "team") return { kind: "team", botId };
    if (kind === "project") {
      const slug = String(a.project ?? "").trim().toLowerCase();
      if (!slug) return "Not saved — project scope needs a project name.";
      const err = d.store.checkProjectScope(botId, slug);
      return err ? `Not saved — ${err}` : { kind: "project", botId, slug };
    }
    return { kind: "agent", botId };
  };
  return {
    updateState: {
      memory: ({ botId, args }) => {
        const text = String(args.fact ?? args.content ?? "").trim();
        const scope = scopeOf(botId, args);
        if (typeof scope === "string") return toolError(scope);
        const label = scopeLabel(scope);
        if (args.action === "write" || args.action === "add") {
          if (!text) return toolError("Not saved — the fact is empty.");
          const tier = (args.tier as string | undefined) ?? "log";
          // The Bot chose to write it (deliberately, unlike background extraction): provenance names it, in its own chat.
          const r = d.store.add(scope, { content: text, tier: tier === "profile" ? "profile" : "log", kind: tier === "note" ? "note" : "fact" }, { botId, chatId: botId, source: "inferred", confidence: 0.8 });
          return r.added ? { text: `Remembered in ${label} (${tier}): ${r.fact.content}` } : { text: `Already remembered in ${label}: ${r.fact.content}` };
        }
        if (args.action === "forget") {
          const hit = d.store.remove(scope, text);
          return hit ? { text: `Forgot from ${label}: ${hit.content}` } : toolError(`Not forgotten — no fact in ${label} matches that exact text.`);
        }
        return toolError(`Not saved — unknown memory action "${String(args.action)}". Use write or forget.`);
      },
      project: ({ botId, args }) => {
        const slug = String(args.name ?? args.project ?? "").trim().toLowerCase();
        if (!slug) return toolError("Not saved — a project needs a name.");
        try {
          if (args.action === "create") { d.store.createProject(slug, botId, String(args.description ?? "")); return { text: `Created and joined project "${slug}".` }; }
          if (args.action === "join") { d.store.joinProject(botId, slug); return { text: `Joined project "${slug}".` }; }
          if (args.action === "leave") { d.store.leaveProject(botId, slug); return { text: `Left project "${slug}".` }; }
        } catch (e) {
          return toolError(`Not saved — ${(e as Error).message}`);
        }
        return toolError(`Not saved — unknown project action "${String(args.action)}". Use create, join or leave.`);
      },
    },
  };
}
