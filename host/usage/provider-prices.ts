import { setLiveProviderPrices, type LivePrices, type TokenPrice } from "@synapse/shared";
import { log } from "../util/log";
import { providerGet } from "./metered-provider";

/**
 * OpenRouter's live prices and context windows (spec §5): its /models list, fetched through the provider proxy and kept
 * for a day. Its `usage.cost` stays authoritative per call; these prices price a call that reported no cost and feed the
 * context window. OpenRouter lists prices in dollars per token, as strings.
 */
export const LIVE_PRICES_TTL_MS = 24 * 3600_000;
const OPENROUTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

export function parseOpenRouterModels(body: string): LivePrices {
  const out = new Map<string, TokenPrice & { contextWindow?: number }>();
  let j: unknown;
  try { j = JSON.parse(body); } catch { return out; }
  const data = (j as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  const perM = (v: unknown): number | null => {
    const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
  };
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const r = m as { id?: unknown; name?: unknown; pricing?: Record<string, unknown>; context_length?: unknown; supported_parameters?: unknown };
    // The id becomes a model ref and a picker row: only the plain shape OpenRouter uses ("maker/model:variant").
    if (typeof r.id !== "string" || !OPENROUTER_ID.test(r.id) || !r.pricing) continue;
    const input = perM(r.pricing.prompt);
    const output = perM(r.pricing.completion);
    if (input === null || output === null) continue;
    const cached = perM(r.pricing.input_cache_read) ?? input;
    const ctx = typeof r.context_length === "number" && r.context_length > 0 ? r.context_length : undefined;
    // Display text only, never markup: control characters out, and short.
    const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) : "";
    // A Bot answers through a tool (SendMessage): a model that says it takes no tools can't run one.
    const tools = Array.isArray(r.supported_parameters) ? r.supported_parameters.includes("tools") : undefined;
    out.set(`openrouter:${r.id}`, { input, cachedInput: cached, output, ...(ctx ? { contextWindow: ctx } : {}), ...(name ? { name } : {}), ...(tools !== undefined ? { tools } : {}) });
  }
  return out;
}

export class LivePriceRefresher {
  private at = 0;
  private inFlight: Promise<void> | null = null;
  constructor(private o: { ready(): boolean; now?: () => number }) {}

  /** Fetches when the cache is a day old (or never filled) and OpenRouter is set up; never throws. */
  ensure(force = false): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    if (!this.o.ready() || (!force && this.at > 0 && now - this.at < LIVE_PRICES_TTL_MS)) return Promise.resolve();
    this.inFlight ??= (async () => {
      try {
        const r = await providerGet("openrouter", "models");
        if (r.status >= 200 && r.status < 300) {
          const prices = parseOpenRouterModels(r.body);
          if (prices.size) { setLiveProviderPrices(prices); this.at = now; }
        }
      } catch (e) {
        log.warn("provider prices: OpenRouter's model list couldn't be read", { error: String(e) });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
