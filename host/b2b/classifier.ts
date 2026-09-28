import { createHash } from "node:crypto";
import { LIMITS, type B2BKind } from "@synapse/shared";
import type { OneShotModel } from "../helper-model/one-shot";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";
import { normalizeText } from "./text";

export interface ClassifierVerdict { verdict: "deliver" | "inbox" | "drop"; kind_suggestion: string | null; reason: string }

export const GATE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["deliver", "inbox", "drop"] },
    kind_suggestion: { type: ["string", "null"] },
    reason: { type: "string", maxLength: 120 },
  },
  required: ["verdict", "kind_suggestion", "reason"],
  additionalProperties: false,
} as const;

const FALLBACK: ClassifierVerdict = { verdict: "inbox", kind_suggestion: null, reason: "classifier unavailable; kept in the inbox" };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
type Cache = Record<string, { v: ClassifierVerdict; at: number }>;

/** ORIG-09 §09.2: Haiku classifier for ambiguous gate cases. 4 s timeout; on any failure → inbox (never wake on a guess). */
export class GateClassifier {
  private cache: Cache;
  private now: () => number;

  constructor(private d: { model: OneShotModel; cacheFile: string; metrics: RuntimeMetrics | null; now?(): number; timeoutMs?: number }) {
    this.now = d.now ?? Date.now;
    this.cache = readJson<Cache>(d.cacheFile, {});
  }

  async classify(i: { botId: string; chainId: string | null; kind: B2BKind; message: string; expects: string | null; thread_digest: string }): Promise<ClassifierVerdict> {
    const key = sha256(JSON.stringify([i.kind, normalizeText(i.message), sha256(i.thread_digest)]));
    const hit = this.cache[key];
    if (hit && this.now() - hit.at < LIMITS.classifierCacheMs) {
      this.d.metrics?.recordB2B({ botId: i.botId, chainId: i.chainId, event: "classifier_cache_hit", kind: i.kind });
      return hit.v;
    }
    this.d.metrics?.recordB2B({ botId: i.botId, chainId: i.chainId, event: "classifier_call", kind: i.kind });
    const timeoutMs = this.d.timeoutMs ?? LIMITS.classifierTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = this.d.model.run<ClassifierVerdict>({
        prompt: "orig/b2b-gate.md", schema: GATE_SCHEMA, timeoutMs, botId: i.botId,
        input: { kind: i.kind, message: i.message, expects: i.expects, thread_digest: i.thread_digest },
      });
      const timeout = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("classifier timed out")), timeoutMs); });
      const v = await Promise.race([call, timeout]);
      if (!v || !["deliver", "inbox", "drop"].includes(v.verdict)) throw new Error(`malformed verdict ${JSON.stringify(v)}`);
      const clean: ClassifierVerdict = { verdict: v.verdict, kind_suggestion: typeof v.kind_suggestion === "string" ? v.kind_suggestion : null, reason: String(v.reason ?? "").slice(0, 120) };
      this.cache[key] = { v: clean, at: this.now() };
      for (const [k, e] of Object.entries(this.cache)) if (this.now() - e.at >= LIMITS.classifierCacheMs) delete this.cache[k];
      writeJsonAtomic(this.d.cacheFile, this.cache, 0o600);
      return clean;
    } catch (e) {
      log.warn("b2b gate classifier failed; message goes to the inbox", { error: String(e) });
      return FALLBACK;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
