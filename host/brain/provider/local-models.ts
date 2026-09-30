import { isLocalProvider, type ProviderId } from "@synapse/shared";
import { providerGet } from "../../usage/metered-provider";

/**
 * The models a local provider has downloaded, for the picker (spec §10): Ollama's /api/tags, LM Studio's /v1/models.
 * Asked only when the picker opens and only for a provider the user set up, with a short timeout. Listing never
 * starts, loads or pulls a model (the owner's rule: no local model runs unasked). Kept 30 s, so reopening the picker
 * doesn't ask again.
 */
type Local = Extract<ProviderId, "ollama" | "lmstudio">;
export const LOCAL_LIST_TIMEOUT_MS = 1_500;
const TTL_MS = 30_000;

export function parseLocalModels(p: Local, body: string): string[] {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return []; }
  const o = j as { models?: { name?: unknown; model?: unknown }[]; data?: { id?: unknown; type?: unknown }[] };
  const names = p === "ollama"
    ? (o.models ?? []).map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
    // LM Studio lists embedding models too; the picker wants chat models only.
    : (o.data ?? []).filter((m) => m.type === undefined || m.type === "llm" || m.type === "vlm").map((m) => (typeof m.id === "string" ? m.id : null));
  return [...new Set(names.filter((n): n is string => !!n && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(n)))].slice(0, 100);
}

export class LocalModelLists {
  private cache = new Map<Local, { at: number; models: string[] }>();
  constructor(private o: { now?: () => number; get?: typeof providerGet } = {}) {}

  /** The last list read (any age), without asking: [] before the first ask. */
  cached(p: ProviderId): string[] {
    return isLocalProvider(p) ? this.cache.get(p as Local)?.models ?? [] : [];
  }

  /** The provider's model list, from the cache when fresh; [] when it can't be reached in time. */
  async list(p: ProviderId): Promise<string[]> {
    if (!isLocalProvider(p)) return [];
    const lp = p as Local;
    const now = (this.o.now ?? Date.now)();
    const hit = this.cache.get(lp);
    if (hit && now - hit.at < TTL_MS) return hit.models;
    let models: string[] = [];
    try {
      const r = await (this.o.get ?? providerGet)(lp, lp === "ollama" ? "api/tags" : "models", { signal: AbortSignal.timeout(LOCAL_LIST_TIMEOUT_MS) });
      if (r.status >= 200 && r.status < 300) models = parseLocalModels(lp, r.body);
    } catch { /* not running: nothing to list */ }
    this.cache.set(lp, { at: now, models });
    return models;
  }
}
