import { LIMITS, historyCaps } from "@synapse/shared";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { BotService } from "../bots/bot-service";
import type { TurnHooks } from "../runner/hooks";
import type { TurnRunner } from "../runner/turn-runner";
import type { TrayService } from "../trays/trays";
import { noteCompaction, patchCtx, readCtx } from "./context-meter";

export interface CompactorDeps {
  bots: BotService;
  runner: Pick<TurnRunner, "runMaintenance" | "isIdle" | "retryUserTurn">;
  trays: TrayService;
  flags(): ConformanceFlags;
  now(): number;
  compact(botId: string, signal: AbortSignal): Promise<boolean>;
  onOverflowAgain(botId: string): void;
  idleMs?: number;
  /** A compaction finished: the host's own /compact (its reason) or the CLI's auto-compact mid-turn
   *  ("auto", seen as a compact_boundary on the turn's stream). The history archive's hook. */
  onCompacted?(botId: string, how: "idle" | "user" | "overflow" | "auto"): void;
}

export class Compactor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private d: CompactorDeps) {}

  shouldCompact(botId: string): boolean {
    if (this.d.flags().compactPath !== "command" || !this.d.bots.has(botId)) return false;
    const c = readCtx(this.d.bots, botId);
    // Token diet (2): an absolute cap, whatever the window. On the 1M window 70% is 700k tokens,
    // re-read on every call on the way there; the cap is 180k unless the user keeps more for this Bot.
    const cap = historyCaps(this.d.bots.summary(botId).settings.advanced?.historyKeep, c.window);
    const overCap = c.ctxTokens >= cap.idleTokens;
    const needed = overCap || c.ratio >= LIMITS.idleCompactRatio || c.turnsSinceCompact >= LIMITS.compactEveryTurns;
    // At 90% the Bot self-summarizes as soon as the turn ends. Below that we wait for idle.
    const idleLongEnough = overCap || c.ratio >= LIMITS.selfSummaryRatio
      || (c.lastTurnEndAt !== null && this.d.now() - c.lastTurnEndAt >= (this.d.idleMs ?? LIMITS.idleCompactAfterMs));
    return needed && idleLongEnough && this.d.runner.isIdle(botId) && this.d.bots.summary(botId).awaiting === null;
  }

  compactNow(botId: string, reason: "idle" | "user" | "overflow"): boolean {
    if (this.d.flags().compactPath !== "command" || !this.d.bots.has(botId)) return false;
    return this.d.runner.runMaintenance(botId, {
      id: `compact-${reason}`,
      run: async (signal) => {
        const ok = await this.d.compact(botId, signal);
        if (ok) noteCompaction(this.d.bots, botId, this.d.now());
        if (ok) this.d.onCompacted?.(botId, reason);
        if (reason === "overflow" && ok) {
          this.d.trays.list().filter((t) => t.dedupeKey === `${botId}:BOT-E0404`).forEach((t) => this.d.trays.dismiss(t.id));
          this.d.runner.retryUserTurn(botId);
        }
      },
    });
  }

  hooks(): TurnHooks {
    return {
      // The context meter already books the boundary (noteCompaction); this only tells the archive.
      onEvent: (botId, e) => { if (e.kind === "compact_boundary") this.d.onCompacted?.(botId, "auto"); },
      onIdle: (botId) => {
        clearTimeout(this.timers.get(botId));
        const t = setTimeout(() => {
          this.timers.delete(botId);
          if (this.shouldCompact(botId)) this.compactNow(botId, "idle");
        }, (this.d.idleMs ?? LIMITS.idleCompactAfterMs) + 50);
        t.unref?.();
        this.timers.set(botId, t);
      },
      afterSettle: (botId, t) => {
        if (t.error?.code !== "BOT-E0404") {
          if (!t.error) patchCtx(this.d.bots, botId, { overflowRetries: 0 });
          return;
        }
        const tries = readCtx(this.d.bots, botId).overflowRetries;
        patchCtx(this.d.bots, botId, { overflowRetries: tries + 1 });
        if (tries === 0) this.compactNow(botId, "overflow");
        else if (tries === 1) this.d.onOverflowAgain(botId); // Task 19 rolls over and retries once more; after that the tray stays
      },
    };
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
