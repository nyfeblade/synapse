import type { SendMessageEntry, SendMessagePayload } from "@synapse/shared";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { TurnSlot } from "../runner/turn-slot";

export type SendType = "attachment" | "widget" | "card" | "secret-request" | "coding-agent";
export type UpdateTarget = "memory" | "routine" | "workflow" | "project" | "avatar" | "settings";

export interface SendContext {
  botId: string;
  slot: TurnSlot;
  args: Record<string, unknown>;
  now(): number;
  /** Appends the send-message entry and does the common bookkeeping (counters, ack, preview, threading). */
  deliver(message: SendMessagePayload, extra?: Partial<SendMessageEntry>, preview?: string): SendMessageEntry;
}
export type SendTypeHandler = (c: SendContext) => Promise<BotToolResult> | BotToolResult;
export interface UpdateStateContext { botId: string; slot: TurnSlot | null; args: Record<string, unknown>; now(): number }
export type UpdateStateHandler = (c: UpdateStateContext) => Promise<BotToolResult> | BotToolResult;

export interface BotToolExtensions {
  sendTypes?: Partial<Record<SendType, SendTypeHandler>>;
  updateState?: Partial<Record<UpdateTarget, UpdateStateHandler>>;
  extraTools?: (botId: string, slot: () => TurnSlot | null) => BotToolDef[];
}

export const toolError = (text: string): BotToolResult => ({ text, isError: true });

export function mergeExtensions(list: BotToolExtensions[]): BotToolExtensions {
  const out: Required<Pick<BotToolExtensions, "sendTypes" | "updateState">> & BotToolExtensions = { sendTypes: {}, updateState: {} };
  const extra: NonNullable<BotToolExtensions["extraTools"]>[] = [];
  for (const e of list) {
    Object.assign(out.sendTypes, e.sendTypes ?? {});
    Object.assign(out.updateState, e.updateState ?? {});
    if (e.extraTools) extra.push(e.extraTools);
  }
  out.extraTools = (botId, slot) => extra.flatMap((f) => f(botId, slot));
  return out;
}
