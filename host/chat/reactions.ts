import { LIMITS, isAgentMessage, type AgentMessageEntry, type Reaction, type TranscriptEntry } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { toolError, type BotToolExtensions } from "../tools/registry";
import { quoteOf } from "./threads";

// AckLedger#clear returns boolean; narrowed to `boolean | void` so a test double like `() => {}` (void) type-checks too.
export interface AckClear { clear(botId: string, token: string): boolean | void }

const validEmoji = (e: string) => e.length > 0 && e.length <= LIMITS.reactionEmojiMax && !/\s/.test(e);

export function toggleReaction(list: Reaction[] | undefined, r: Reaction): { list: Reaction[]; added: boolean } {
  const cur = list ?? [];
  const has = cur.some((x) => x.emoji === r.emoji && x.by === r.by);
  return has ? { list: cur.filter((x) => !(x.emoji === r.emoji && x.by === r.by)), added: false } : { list: [...cur, r], added: true };
}

function reactable(e: TranscriptEntry | null): e is Exclude<Extract<TranscriptEntry, { kind: "message" | "send-message" }>, AgentMessageEntry> {
  return Boolean(e && (e.kind === "message" || e.kind === "send-message") && !isAgentMessage(e));
}

/** CHAT-12. Reactions never resolve approvals: nothing here touches the approval gate. */
export function createReactionCommands(d: { bots: BotService; wake(botId: string, text: string): void }): CommandHandlers {
  return {
    reactToMessage: async (a) => {
      const emoji = String(a.emoji ?? "").trim();
      if (!validEmoji(emoji)) throw new GatewayError("BAD_EMOJI", "A reaction is one emoji of at most 16 characters.");
      const e = d.bots.getEntry(a.id, a.entryId);
      if (!reactable(e)) throw new GatewayError("NOT_FOUND", "No such message.", 404);
      const t = toggleReaction(e.reactions, { emoji, by: "user" });
      d.bots.updateEntry(a.id, { ...e, reactions: t.list });
      if (t.added && e.kind === "send-message") {
        d.wake(a.id, `[The user reacted ${emoji} to your message: "${quoteOf(e, LIMITS.reactionQuoteMax)}". You don't need to reply unless it changes what you should do.]`);
      }
      return { reactions: t.list };
    },
  };
}

export function createReactionToolExtension(d: { bots: BotService; acks: AckClear }): BotToolExtensions {
  return {
    extraTools: (botId, slot) => [{
      name: "ReactToMessage",
      description: "React to one of the user's messages with an emoji (toggle). A reaction is a complete reply when words aren't needed.",
      readOnly: false,
      schema: { message_address: z.string(), emoji: z.string() },
      handler: async (a) => {
        const s = slot();
        const emoji = String(a.emoji ?? "").trim();
        if (!validEmoji(emoji)) return toolError("emoji must be one emoji of at most 16 characters.");
        const e = d.bots.getEntry(botId, String(a.message_address));
        if (!e || e.kind !== "message" || isAgentMessage(e)) return toolError(`${String(a.message_address)} is not one of the user's messages.`);
        const t = toggleReaction(e.reactions, { emoji, by: botId });
        d.bots.updateEntry(botId, { ...e, reactions: t.list });
        if (s && t.added) {
          s.reacted = true;
          if (s.userSeqMax > 0) d.bots.confirmUserSeq(botId, s.userSeqMax);
          if (s.ackToken) d.acks.clear(botId, s.ackToken);
        }
        return { text: t.added ? `Reacted ${emoji} to ${e.id}.` : `Removed ${emoji} from ${e.id}.` };
      },
    }],
  };
}
