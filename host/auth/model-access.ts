import fs from "node:fs";
import path from "node:path";
import { DEFAULT_BOT_MODEL, MODEL_IDS, hasLongContextArm, isModelId, type ModelAccessView, type ModelId } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { ANTHROPIC_API } from "./test-connection";

/** The beta the CLI sends for a [1m] model through a base URL (context-1m); count_tokens refuses it without access. */
export const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
const FILE = "model-access.json";
/** When a Bot's model is out of reach: the first of these the key can use (unchecked counts as usable). */
const FALLBACK_ORDER: readonly ModelId[] = [DEFAULT_BOT_MODEL, "claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"];

interface Stored { checkedAt: number | null; models: Partial<Record<ModelId, boolean>>; longContext: Partial<Record<ModelId, boolean>> }

/**
 * Review round 2 (P4): which models the saved Anthropic API key can reach, and which have 1M context. Probed with
 * count_tokens (free) straight from the host with the key, like Test connection, never through the proxy: 200 = usable,
 * 404 / 400 / 403 = not, anything else (network, 401, 429, 5xx) = unknown (left unchecked, so nothing is hidden on a
 * hiccup). Kept in hostPrivate/anthropic-auth/model-access.json (no secrets). Cleared when the key changes.
 */
export class ModelAccess {
  private s: Stored;
  private inFlight: Promise<ModelAccessView> | null = null;
  /** Review round 3 (D2): bumps on every clear() (a new key); a probe started under an older one never lands. */
  private gen = 0;

  constructor(private o: { dir: string; key(): string | null; baseUrl?: string; fetchFn?: typeof fetch; now?: () => number; onChange?(v: ModelAccessView): void; timeoutMs?: number }) {
    const raw = readJson<Partial<Stored>>(path.join(o.dir, FILE), {});
    const pick = (x: unknown): Partial<Record<ModelId, boolean>> => Object.fromEntries(Object.entries(x && typeof x === "object" ? x : {}).filter(([k, v]) => isModelId(k) && typeof v === "boolean")) as Partial<Record<ModelId, boolean>>;
    this.s = { checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : null, models: pick(raw.models), longContext: pick(raw.longContext) };
  }

  view(): ModelAccessView { return { checkedAt: this.s.checkedAt, checking: this.inFlight !== null, models: { ...this.s.models }, longContext: { ...this.s.longContext } }; }

  /** The key changed: what was known about the old one no longer holds. */
  clear(): void {
    this.gen++;
    this.inFlight = null;
    this.s = { checkedAt: null, models: {}, longContext: {} };
    this.save();
    this.o.onChange?.(this.view());
  }

  /** The model to spawn for a Bot's chosen one, and the chosen one when it had to fall back (for the message). */
  resolve(model: string): { model: string; from: string | null } {
    if (!isModelId(model) || this.s.models[model] !== false) return { model, from: null };
    const to = FALLBACK_ORDER.find((m) => this.s.models[m] !== false) ?? MODEL_IDS.find((m) => this.s.models[m] !== false);
    return to ? { model: to, from: model } : { model, from: null };
  }

  /** Whether [1m] may be requested for this model (unchecked = yes, as before). */
  longContextOk(model: string): boolean {
    return !isModelId(model) || this.s.longContext[model] !== false;
  }

  probe(): Promise<ModelAccessView> {
    if (this.inFlight) return this.inFlight;
    const gen = this.gen;
    const p: Promise<ModelAccessView> = this.run(gen).finally(() => {
      if (this.inFlight === p) { this.inFlight = null; this.o.onChange?.(this.view()); }
    });
    this.inFlight = p;
    this.o.onChange?.(this.view());
    return p;
  }

  private async run(gen: number): Promise<ModelAccessView> {
    const key = this.o.key();
    if (!key) return this.view();
    const models: Partial<Record<ModelId, boolean>> = {};
    const longContext: Partial<Record<ModelId, boolean>> = {};
    await Promise.all(MODEL_IDS.map(async (m) => {
      const ok = await this.count(key, m, false);
      if (ok !== null) models[m] = ok;
      if (ok && hasLongContextArm(m)) {
        const long = await this.count(key, m, true);
        if (long !== null) longContext[m] = long;
      }
    }));
    if (gen !== this.gen) return this.view(); // the key changed meanwhile: these answers were for the old one
    this.s = { checkedAt: (this.o.now ?? Date.now)(), models, longContext };
    this.save();
    return this.view();
  }

  /** One free count_tokens call; true / false / null (unknown). The key goes as x-api-key only. */
  private async count(key: string, model: ModelId, long: boolean): Promise<boolean | null> {
    const f = this.o.fetchFn ?? fetch;
    try {
      const r = await f(`${(this.o.baseUrl ?? ANTHROPIC_API).replace(/\/$/, "")}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", ...(long ? { "anthropic-beta": LONG_CONTEXT_BETA } : {}) },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }] }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
      await r.body?.cancel().catch(() => {});
      if (r.ok) return true;
      // 404 / 403: the key can't use the model. 400 counts only against the 1M beta (a refused beta), never a plain call.
      if (r.status === 404 || r.status === 403 || (long && r.status === 400)) return false;
      return null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(path.join(this.o.dir, FILE), this.s, 0o600);
    } catch (e) { log.warn("model access could not be saved", { error: String(e) }); }
  }
}
