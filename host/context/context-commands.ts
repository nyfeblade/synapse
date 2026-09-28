import { isHistoryKeep } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { CommandHandlers } from "../gateway/server";
import type { Compactor } from "./compactor";
import { contextView } from "./context-meter";
import type { Rollover } from "./rollover";

export function createContextCommands(d: { bots: BotService; compactor: Pick<Compactor, "compactNow">; rollover: Pick<Rollover, "rollNow">; sizeOf(p: string): number | null }): CommandHandlers {
  return {
    getAgentContext: (a) => {
      const f = d.bots.sessionFilePath(a.id);
      return contextView(d.bots, a.id, f ? d.sizeOf(f) : null);
    },
    compactAgentNow: (a) => ({ scheduled: d.compactor.compactNow(a.id, "user") }),
    newAgentSession: (a) => ({ scheduled: d.rollover.rollNow(a.id, "user") }),
    // Token diet (2): the Advanced "Keep more history" choice. The spawn key carries it, so the next
    // turn respawns with the new cap; the Compactor reads it on its next check.
    setAgentHistoryKeep: (a) => {
      if (!isHistoryKeep(a.keep)) throw new Error(`Unknown history setting "${String(a.keep)}".`);
      const cur = d.bots.summary(a.id).settings;
      return { agent: d.bots.updateSettings(a.id, { advanced: { ...(cur.advanced ?? {}), historyKeep: a.keep } }) };
    },
  };
}
