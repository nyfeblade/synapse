import { LIMITS } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { CommandHandlers } from "../gateway/server";
import type { SearchIndex } from "./search-index";

export function createSearchCommands(d: { index: SearchIndex; bots: BotService }): CommandHandlers {
  return {
    search: (a) => ({ results: d.index.search(String(a.query ?? "")).filter((r) => d.bots.has(r.botId)) }),
    getAgentTranscriptPage: (a) =>
      d.bots.require(a.id).store.page(
        a.aroundEntryId,
        Math.min(a.before ?? LIMITS.transcriptPageDefault, LIMITS.transcriptPageMax),
        Math.min(a.after ?? LIMITS.transcriptPageDefault, LIMITS.transcriptPageMax),
      ),
  };
}
