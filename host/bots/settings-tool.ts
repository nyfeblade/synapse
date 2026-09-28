import { isModelId } from "@synapse/shared";
import { toolError, type BotToolExtensions } from "../tools/registry";
import type { BotService } from "./bot-service";

/** TOOL-19 update_state target "settings": model, hidden_from_sidebar, notify_on_updates. */
export function createSettingsToolExtension(d: { bots: BotService }): BotToolExtensions {
  return {
    updateState: {
      settings: ({ botId, args }) => {
        if (args.action !== "set") return toolError(`Not available: update_state target "settings" action "${String(args.action)}".`);
        if (args.model !== undefined) {
          if (!isModelId(args.model)) return toolError(`Not saved — unknown model "${String(args.model)}".`);
          d.bots.update(botId, { model: args.model });
        }
        if (args.hidden_from_sidebar !== undefined) d.bots.setHidden(botId, Boolean(args.hidden_from_sidebar));
        if (args.notify_on_updates !== undefined) d.bots.setNotify(botId, Boolean(args.notify_on_updates));
        return { text: "Updated your settings." };
      },
    },
  };
}
