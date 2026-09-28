import { LONG_CONTEXT_ESCALATE_TOKENS } from "@synapse/shared";
import type { TurnEvent } from "./types";
import { readJsonOrQuarantine, writeJsonAtomic } from "../util/atomic-json";
import { log } from "../util/log";

/**
 * saving-settings, "Long-context model: Only when needed": which chats have escalated to [1m]. A chat is the Bot's
 * session: once its context reached LONG_CONTEXT_ESCALATE_TOKENS it stays on [1m] (a compaction doesn't take it back —
 * every model-name change can re-write the prompt cache, so at most one per chat); a new session starts on standard
 * context again. Kept on disk so a host restart doesn't switch an escalated chat back.
 */
export class LongContextChats {
  private chats: Record<string, string>;

  constructor(private file: string, private d: { sessionId(botId: string): string | null; ctxTokens(botId: string): number }) {
    const { value, quarantined } = readJsonOrQuarantine<Record<string, string>>(file, {});
    if (quarantined) log.warn("long-context escalations could not be read; starting empty", { kept: quarantined });
    this.chats = value && typeof value === "object" ? value : {};
  }

  /** Whether this Bot's current chat runs on [1m]: it escalated before, or its context is past the line now (recorded). */
  escalated(botId: string): boolean {
    const sid = this.d.sessionId(botId);
    if (sid && this.chats[botId] === sid) return true;
    if (this.d.ctxTokens(botId) < LONG_CONTEXT_ESCALATE_TOKENS) return false;
    this.record(botId, sid);
    return true;
  }

  /** A model call reported this context (the context meter's event): past the line, the chat escalates for good. */
  onEvent(botId: string, e: TurnEvent): void {
    if (e.kind !== "context" || e.tokens < LONG_CONTEXT_ESCALATE_TOKENS) return;
    this.record(botId, this.d.sessionId(botId));
  }

  forget(botId: string): void {
    if (!(botId in this.chats)) return;
    delete this.chats[botId];
    this.save();
  }

  private record(botId: string, sid: string | null): void {
    if (!sid || this.chats[botId] === sid) return;
    this.chats[botId] = sid;
    this.save();
  }

  private save(): void {
    try { writeJsonAtomic(this.file, this.chats, 0o640); } catch (e) { log.warn("long-context escalations could not be saved", { error: String(e) }); }
  }
}
