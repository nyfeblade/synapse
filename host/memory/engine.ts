import { userEntryId } from "@synapse/shared";
import type { SettledTurn, TurnHooks } from "../runner/hooks";
import { log } from "../util/log";
import type { EpisodeWriter } from "./episodes";
import { isMemorable, type MemoryExtractor } from "./extractor";

export function settledExchange(t: SettledTurn): { user: string; bot: string } {
  return { user: t.userTexts.join("\n\n"), bot: [...t.sentTexts, t.finalText].filter((s) => s.trim()).join("\n\n") };
}

/**
 * cost-diet-2 lever 4: memorable exchanges (isMemorable) are extracted in batches: one Haiku call
 * per EXTRACTION_BATCH of them, sharing the prompt and the existing memories, or fewer after EXTRACTION_IDLE_MS of
 * quiet, and whatever is left at shutdown (drain). The pending batch lives in the Bot's store, so a restart keeps it.
 * Simulator: helper tokens per 100 messages -49% to -52% (host/bench/compare, "memBatch3").
 */
export const EXTRACTION_BATCH = 3;
export const EXTRACTION_IDLE_MS = 10 * 60_000;
export interface PendingExchange { at: number; user: string; bot: string; ref?: string }

export interface MemoryEngineDeps {
  extractor: MemoryExtractor;
  episodes: EpisodeWriter;
  /** I5: the secret scanner's redact (raw, base64, hex and URL forms), applied when the turn settles. */
  redact?(botId: string, text: string): string;
  /** I5: the Bot's secret values, captured when the turn settles (the vault may be gone by the time a job runs). */
  secrets?(botId: string): string[];
  /**
   * S1 lean engineering profile: true while the Bot's engineering mode is ON (engineering/lean-profile.ts leanMemoryGate).
   * A lean turn is extracted in the same batches as an everyday one; its episode is written when the session compacts
   * (`compacted`), not every LIMITS.episodeEveryTurns turns.
   */
  lean?(botId: string): boolean;
  /** Lever 4: batch size and idle flush (defaults EXTRACTION_BATCH, EXTRACTION_IDLE_MS). */
  batch?: number;
  idleMs?: number;
  /** Lever 4: where a Bot's pending (already redacted) exchanges wait; absent = memory only. */
  pending?: { get(botId: string): PendingExchange[]; set(botId: string, list: PendingExchange[]): void };
}

/** MEM-06: runs after a visible, non-superseded user turn settles; errors are swallowed; one chain per Bot keeps writes ordered. */
export function createMemoryEngineHooks(d: MemoryEngineDeps & { settings?: { extra<T>(key: string, fallback: T): T } }): TurnHooks & { drain(): Promise<void>; dropBot(botId: string): Promise<void>; compacted(botId: string): void } {
  const chains = new Map<string, Promise<void>>();
  const dropped = new Set<string>();
  const batch = Math.max(1, d.batch ?? EXTRACTION_BATCH);
  const idleMs = d.idleMs ?? EXTRACTION_IDLE_MS;
  const mem = new Map<string, PendingExchange[]>();
  const store = d.pending ?? { get: (b: string) => mem.get(b) ?? [], set: (b: string, l: PendingExchange[]) => { mem.set(b, l); } };
  const known = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const captured = new Map<string, Set<string>>();
  const episodeSecrets = new Map<string, Set<string>>();
  const clearTimer = (botId: string) => { const t = timers.get(botId); if (t) clearTimeout(t); timers.delete(botId); };
  const enqueue = (botId: string, job: () => Promise<unknown>) => {
    const guarded = () => (dropped.has(botId) ? undefined : job()); // I6: a queued job of a deleted Bot never starts
    const next = (chains.get(botId) ?? Promise.resolve()).then(guarded).then(() => undefined, (e) => log.warn("memory job failed", { botId, error: String(e) }));
    chains.set(botId, next);
  };
  const flush = (botId: string) => {
    clearTimer(botId);
    const list = store.get(botId);
    if (!list.length || dropped.has(botId)) return;
    store.set(botId, []);
    const secrets = [...(captured.get(botId) ?? [])];
    captured.delete(botId);
    enqueue(botId, () => d.extractor.run(botId, list.map(({ user, bot, ref }) => ({ user, bot, ...(ref ? { ref } : {}) })), secrets));
  };
  return {
    afterSettle: (botId, t) => {
      if (d.settings?.extra<"standard" | "dreaming">("memoryMode", "standard") === "dreaming") return; // MEM-07 replaces MEM-06
      if (dropped.has(botId) || t.hidden || t.source !== "user" || t.superseded || t.aborted || t.error) return;
      // I5: capture and redact now, not when the job runs.
      const secrets = d.secrets?.(botId) ?? [];
      const raw = settledExchange(t);
      const ex = d.redact ? { user: d.redact(botId, raw.user), bot: d.redact(botId, raw.bot) } : raw;
      const lean = d.lean?.(botId) ?? false;
      if (isMemorable(ex.user)) {
        known.add(botId);
        store.set(botId, [...store.get(botId), { at: t.endedAt, ...ex, ...(t.userSeqMax > 0 ? { ref: userEntryId(t.userSeqMax) } : {}) }]);
        captured.set(botId, new Set([...(captured.get(botId) ?? []), ...secrets]));
        if (store.get(botId).length >= batch) flush(botId);
        else {
          clearTimer(botId);
          const timer = setTimeout(() => flush(botId), idleMs);
          timer.unref?.();
          timers.set(botId, timer);
        }
      }
      if (lean) {
        // S1: an engineering turn's episode waits for the compaction (one journal call per session, not per 6 turns).
        episodeSecrets.set(botId, new Set([...(episodeSecrets.get(botId) ?? []), ...secrets]));
        enqueue(botId, () => d.episodes.stash(botId, { at: t.endedAt, ...ex }));
        return;
      }
      enqueue(botId, () => d.episodes.note(botId, { at: t.endedAt, ...ex }, secrets));
    },
    /** The Bot's session compacted: an engineering-mode Bot's stashed turns become one episode. */
    compacted: (botId) => {
      if (dropped.has(botId) || !d.lean?.(botId)) return;
      const secrets = [...(episodeSecrets.get(botId) ?? [])];
      episodeSecrets.delete(botId);
      enqueue(botId, () => d.episodes.flush(botId, secrets));
    },
    /** Shutdown: every pending batch is extracted now, then every job finishes. */
    drain: async () => {
      for (const b of known) flush(b);
      await Promise.all(chains.values());
    },
    /** I6: drop the Bot's queued jobs and wait for the one in flight, before its memory and vault are removed. */
    dropBot: async (botId) => {
      dropped.add(botId);
      clearTimer(botId);
      store.set(botId, []);
      captured.delete(botId);
      episodeSecrets.delete(botId);
      const c = chains.get(botId);
      chains.delete(botId);
      await c;
    },
  };
}
