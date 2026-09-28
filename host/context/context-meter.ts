import { contextWindow, type AgentContextView } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { fillTemplate, loadPrompt } from "../prompts/index";
import type { TurnHooks } from "../runner/hooks";

export interface CtxState {
  ctxTokens: number; window: number; ratio: number; turnsSinceCompact: number; compactions: number;
  restorePending: boolean; lastTurnEndAt: number | null; lastCompactAt: number | null;
  overflowRetries: number; // ORIG-07 §07.7 (Task 18)
}
const EMPTY: CtxState = { ctxTokens: 0, window: 200_000, ratio: 0, turnsSinceCompact: 0, compactions: 0, restorePending: false, lastTurnEndAt: null, lastCompactAt: null, overflowRetries: 0 };

export function readCtx(bots: BotService, botId: string): CtxState {
  return { ...EMPTY, ...bots.brainKv<Partial<CtxState>>(botId, "ctx", {}) };
}
export function patchCtx(bots: BotService, botId: string, patch: Partial<CtxState>): CtxState {
  const next = { ...readCtx(bots, botId), ...patch };
  bots.setBrainKv(botId, "ctx", next);
  return next;
}
/** §07.3: either compaction path bumps the epoch; the next turn re-renders the Bot prompt and gets the restore block (§07.4). */
export function noteCompaction(bots: BotService, botId: string, now: number): void {
  bots.bumpCompactionEpoch(botId);
  const c = readCtx(bots, botId);
  patchCtx(bots, botId, { ctxTokens: 0, ratio: 0, turnsSinceCompact: 0, compactions: c.compactions + 1, restorePending: true, lastCompactAt: now });
}
export function contextView(bots: BotService, botId: string, sessionBytes: number | null): AgentContextView {
  const c = readCtx(bots, botId);
  return { ctxTokens: c.ctxTokens, window: c.window, ratio: c.ratio, compactionEpoch: bots.compactionEpoch(botId), compactions: c.compactions, sessionBytes };
}
export function compactInstructions(p: { botName: string; botId: string }): string {
  return fillTemplate(loadPrompt("orig/compact.md"), { botName: p.botName, botId: p.botId });
}

export function createContextMeterHooks(d: { bots: BotService; modelOf(botId: string): string; now(): number }): TurnHooks {
  return {
    onEvent: (botId, e) => {
      if (e.kind === "context") {
        const window = contextWindow(d.modelOf(botId));
        patchCtx(d.bots, botId, { ctxTokens: e.tokens, window, ratio: Math.round((e.tokens / window) * 1000) / 1000 });
      } else if (e.kind === "compact_boundary") noteCompaction(d.bots, botId, d.now());
    },
    afterSettle: (botId, t) => {
      const c = readCtx(d.bots, botId);
      patchCtx(d.bots, botId, { turnsSinceCompact: c.turnsSinceCompact + 1, lastTurnEndAt: t.endedAt });
    },
  };
}
