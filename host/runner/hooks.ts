import type { UserMessageEntry } from "@synapse/shared";
import type { ClassifiedError, Lane, ModelMessage, PreToolDecision, ToolCall, TurnEvent, TurnUsage, WakeSource } from "../brain/types";
import type { TurnSlot } from "./turn-slot";
import { log } from "../util/log";

export interface MessageDecoration { before: ModelMessage[]; after: ModelMessage[] }
export interface TurnBlockInput { source: WakeSource; hidden: boolean; silenceAllowed: boolean; queryText: string }
export interface PromptSections { memory: string; skills: string }

/** A finished turn (never a maintenance job). Memory extraction, context and rollover read it. */
export interface SettledTurn {
  source: WakeSource; lane: Lane; hidden: boolean; requestId: string; turnNo: number; userSeqMax: number;
  userTexts: string[]; sentTexts: string[]; finalText: string;
  aborted: boolean; superseded: boolean; error: ClassifiedError | null; usage: TurnUsage;
  startedAt: number; firstEventAt: number | null; endedAt: number;
}

export interface TurnHooks {
  decorateUserMessage?(botId: string, entry: UserMessageEntry): MessageDecoration;
  turnBlocks?(botId: string, t: TurnBlockInput): ModelMessage[];
  preToolUse?(botId: string, call: ToolCall, slot: TurnSlot | null): PreToolDecision | null;
  onEvent?(botId: string, e: TurnEvent, slot: TurnSlot): void;
  afterSettle?(botId: string, t: SettledTurn): void;
  onIdle?(botId: string): void;
  promptSections?(botId: string): PromptSections;
}

/** One failing hook must not fail the user's turn (the message would never reach the Bot). preToolUse is not isolated: a deny must never be lost. */
function safe<T>(hook: string, botId: string, f: () => T, fallback: T): T {
  try {
    return f();
  } catch (e) {
    log.warn("turn hook failed", { hook, botId, error: String(e) });
    return fallback;
  }
}

export function composeHooks(list: TurnHooks[]): TurnHooks {
  return {
    decorateUserMessage: (botId, entry) => {
      const out: MessageDecoration = { before: [], after: [] };
      for (const h of list) {
        const d = safe("decorateUserMessage", botId, () => h.decorateUserMessage?.(botId, entry), undefined);
        if (d) { out.before.push(...d.before); out.after.push(...d.after); }
      }
      return out;
    },
    turnBlocks: (botId, t) => list.flatMap((h) => safe("turnBlocks", botId, () => h.turnBlocks?.(botId, t) ?? [], [])),
    preToolUse: (botId, call, slot) => {
      for (const h of list) {
        const d = h.preToolUse?.(botId, call, slot);
        if (d) return d;
      }
      return null;
    },
    onEvent: (botId, e, slot) => { for (const h of list) safe("onEvent", botId, () => h.onEvent?.(botId, e, slot), undefined); },
    afterSettle: (botId, t) => { for (const h of list) safe("afterSettle", botId, () => h.afterSettle?.(botId, t), undefined); },
    onIdle: (botId) => { for (const h of list) safe("onIdle", botId, () => h.onIdle?.(botId), undefined); },
    promptSections: (botId) => {
      const s: PromptSections = { memory: "", skills: "" };
      for (const h of list) {
        const p = safe("promptSections", botId, () => h.promptSections?.(botId), undefined);
        if (p?.memory) s.memory = p.memory;
        if (p?.skills) s.skills = p.skills;
      }
      return s;
    },
  };
}
