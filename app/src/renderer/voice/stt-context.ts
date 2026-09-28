import { buildSttContext, type TranscriptEntry, type BotSummary } from "@synapse/shared";

// Bug 162: what this dictation session should expect to hear. The renderer is the only place that
// knows all of it at once — the Bot names, which chat is open and what has just been said in it —
// so it assembles the list and the main process caps and tidies it before the helper sees it.

/** How many recent messages are mined for vocabulary. Enough for the topic, small enough to be free. */
export const STT_RECENT_MESSAGES = 40;

/** The plain text of a transcript entry, or "" for anything that is not a message. */
function messageText(e: TranscriptEntry): string {
  return e.kind === "message" && typeof (e as { content?: unknown }).content === "string" ? (e as { content: string }).content : "";
}

/**
 * The contextual strings for a session: every Bot's name, then the words the open chat keeps using.
 * A group Bot's name counts too — the user says it to call the group.
 */
export function sttContextFor(bots: Record<string, BotSummary>, transcripts: Record<string, TranscriptEntry[]>, activeBotId: string | null): string[] {
  const botNames = Object.values(bots)
    .map((b) => b?.profile?.name)
    .filter((n): n is string => typeof n === "string");
  const entries = (activeBotId ? transcripts[activeBotId] : undefined) ?? [];
  const recentText = entries.slice(-STT_RECENT_MESSAGES).map(messageText).filter(Boolean).join("\n");
  return buildSttContext({ botNames, recentText });
}
