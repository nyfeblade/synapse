import { sendEntryId, type CardPayload, type SendMessageEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { TurnSlot } from "../runner/turn-slot";

/** Appends a CHAT-16-style card as a send-message entry of the running turn; returns its entry id. */
export function postCard(ctx: { bots: BotService; now(): number }, botId: string, slot: TurnSlot, card: CardPayload): string {
  slot.nextSendK += 1;
  const entry: SendMessageEntry = { kind: "send-message", id: sendEntryId(slot.turnNo, slot.nextSendK), requestId: slot.requestId, createdAt: ctx.now(), message: { type: "card", card } };
  ctx.bots.appendEntry(botId, entry);
  slot.segment += 1;
  return entry.id;
}

export function updateCard(bots: BotService, botId: string, entryId: string, card: CardPayload): void {
  const prev = bots.getEntry(botId, entryId);
  if (!prev || prev.kind !== "send-message") return;
  bots.updateEntry(botId, { ...prev, message: { type: "card", card } });
}
