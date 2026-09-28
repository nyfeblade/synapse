import type { BotService } from "../bots/bot-service";
import type { TurnHooks } from "../runner/hooks";
import type { MemoryStore } from "./memory-store";
import { renderMemorySection } from "./render";

/** MEM-05: called only when the frozen prompt re-renders (a new compaction epoch); records which fact ids it showed. */
export function createMemoryPromptHooks(d: { store: MemoryStore; bots: BotService; dataRoot: string }): TurnHooks {
  return {
    promptSections: (botId) => {
      const { text, ids } = renderMemorySection({ store: d.store, botId, nameOf: (id) => (d.bots.has(id) ? d.bots.summary(id).profile.name : "a deleted Bot"), dataRoot: d.dataRoot });
      d.bots.require(botId).store.setKv("memoryPromptSnapshot", { render: text, ids, compactionEpoch: d.bots.compactionEpoch(botId) });
      return { memory: text, skills: "" };
    },
  };
}

export function frozenFactIds(bots: BotService, botId: string): Set<string> {
  return new Set(bots.require(botId).store.getKv<{ ids?: string[] }>("memoryPromptSnapshot", {}).ids ?? []);
}
