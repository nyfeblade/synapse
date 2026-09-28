import type { BotService } from "../bots/bot-service";
import type { CommandHandlers } from "../gateway/server";
import type { HistoryArchive } from "./archive";

/** The storage readout: one Bot's share of the archive (the memory screen can show it). */
export function createHistoryCommands(d: { archive: HistoryArchive; bots: Pick<BotService, "require"> }): CommandHandlers {
  return {
    getHistoryArchiveStats: ({ id }) => {
      d.bots.require(id);
      const s = d.archive.stats(id);
      return { rows: s.rows, bytes: s.approxBytes, fileBytes: s.fileBytes, oldestAt: s.oldestAt, newestAt: s.newestAt };
    },
  };
}
