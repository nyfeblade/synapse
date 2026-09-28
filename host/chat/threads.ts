import { LIMITS, type TranscriptEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { TurnHooks } from "../runner/hooks";

export function quoteOf(e: TranscriptEntry, max: number): string {
  const raw = e.kind === "message" ? e.content
    : e.kind === "send-message" ? (e.message.type === "text" ? e.message.content : e.message.type === "attachment" ? e.message.name : e.message.type === "widget" ? e.message.widget.question : e.message.type === "card" ? `${e.message.card.kind} card` : "approval card")
    : e.kind === "user-attachment" ? e.name : "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function validateReplyTo(bots: BotService, botId: string, id: string): string {
  const e = bots.getEntry(botId, id);
  if (!e || (e.kind !== "message" && e.kind !== "send-message")) throw new GatewayError("BAD_REPLY", "You can only reply to a message in this conversation.");
  return id;
}

export function createThreadHooks(d: { bots: BotService }): TurnHooks {
  return {
    decorateUserMessage: (botId, entry) => {
      if (!entry.replyToId) return { before: [], after: [] };
      const target = d.bots.getEntry(botId, entry.replyToId);
      return { before: target ? [{ text: `[In reply to ${entry.replyToId}: "${quoteOf(target, LIMITS.replyQuoteMax)}"]` }] : [], after: [] };
    },
  };
}

export function createThreadCommands(d: { bots: BotService }): CommandHandlers {
  return {
    getAgentThread: (a) => ({
      root: d.bots.getEntry(a.id, a.entryId),
      replies: d.bots.tail(a.id, 1000).filter((e) => (e as { replyToId?: string }).replyToId === a.entryId),
    }),
  };
}
