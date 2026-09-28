import type { Lane, TurnEvent, TurnResult, WakeSource } from "../brain/types";
import { log } from "../util/log";

/** Phase 5 seam: a settled turn's summary, for modules that want to react without owning `hooks`. */
export interface SettledTurn {
  botId: string;
  requestId: string;
  lane: Lane;
  source: WakeSource;
  hidden: boolean;
  startedAt: number;
  endedAt: number;
  model: string;
  userText: string | null;
  sentTexts: string[];
  result: TurnResult;
  /** saving-settings: a spoken call turn, and whether a call the Bot is on was live when it started (usage.db). */
  voice?: boolean;
  callLive?: boolean;
}

export interface TurnObserver {
  onEvent?(botId: string, e: TurnEvent): void;
  onSettled?(t: SettledTurn): void;
}

export function notifyEvent(obs: readonly TurnObserver[] | undefined, botId: string, e: TurnEvent): void {
  for (const o of obs ?? []) {
    try {
      o.onEvent?.(botId, e);
    } catch (err) {
      log.warn("turn observer failed", { botId, error: String(err) });
    }
  }
}

export function notifySettled(obs: readonly TurnObserver[] | undefined, t: SettledTurn): void {
  for (const o of obs ?? []) {
    try {
      o.onSettled?.(t);
    } catch (err) {
      log.warn("turn observer failed", { botId: t.botId, error: String(err) });
    }
  }
}
