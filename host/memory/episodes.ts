import { LIMITS } from "@synapse/shared";
import type { OneShotModel } from "../brain/one-shot";
import type { BotService } from "../bots/bot-service";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { isoDate, normalizeFact } from "./facts";
import { looksLikeSecret, stripUntrusted } from "./extractor";
import type { MemoryStore } from "./memory-store";

interface PendingTurn { at: number; user: string; bot: string }

/** MEM-06 / §05.2: every 6 visible turns, one or two journal sentences stored as an [episode] log line. */
export class EpisodeWriter {
  private now: () => number;
  constructor(private d: { bots: BotService; store: MemoryStore; model: OneShotModel; timeZone(): string; nameOf(botId: string): string; secrets(botId: string): string[]; now?: () => number }) {
    this.now = d.now ?? Date.now;
  }

  /** captured: the secret values captured when the turn settled (I5). */
  async note(botId: string, turn: PendingTurn, captured: string[] = []): Promise<boolean> {
    const pending = this.append(botId, turn);
    if (pending.length < LIMITS.episodeEveryTurns) return false;
    return this.write(botId, pending, captured);
  }

  /** S1 engineering mode: keep the turn for the episode written at the next compaction (no model call now). */
  async stash(botId: string, turn: PendingTurn): Promise<void> {
    this.append(botId, turn);
  }

  /** S1: the session compacted. The pending turns (the last LIMITS.episodeFlushMax) become one episode. */
  async flush(botId: string, captured: string[] = []): Promise<boolean> {
    const pending = this.d.bots.require(botId).store.getKv<PendingTurn[]>("episodePending", []).slice(-LIMITS.episodeFlushMax);
    if (!pending.length) return false;
    return this.write(botId, pending, captured);
  }

  private append(botId: string, turn: PendingTurn): PendingTurn[] {
    const kv = this.d.bots.require(botId).store;
    const pending = [...kv.getKv<PendingTurn[]>("episodePending", []), {
      at: turn.at, user: stripUntrusted(turn.user).slice(0, LIMITS.episodeSideMax), bot: stripUntrusted(turn.bot).slice(0, LIMITS.episodeSideMax),
    }].slice(-LIMITS.episodePendingMax);
    kv.setKv("episodePending", pending);
    return pending;
  }

  private async write(botId: string, pending: PendingTurn[], captured: string[]): Promise<boolean> {
    this.d.bots.require(botId).store.setKv("episodePending", []);
    const tz = this.d.timeZone();
    const input = { today: isoDate(this.now(), tz), botName: this.d.nameOf(botId), turns: pending.map((t) => ({ at: isoDate(t.at, tz), user: t.user, bot: t.bot })) };
    const out = (await this.d.model.complete({ system: fillTemplate(loadPrompt("orig/memory-episode.md"), { botName: input.botName }), user: JSON.stringify(input), tag: { purpose: "episode", botId } })).trim();
    if (!out || out === "NONE" || looksLikeSecret(out, [...captured, ...this.d.secrets(botId)])) return false;
    this.d.store.add({ kind: "agent", botId }, { content: normalizeFact(out), tier: "log", kind: "episode", date: isoDate(pending.at(-1)!.at, tz) });
    return true;
  }
}
