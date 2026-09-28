import type { BotService } from "./bot-service";
import type { CommandHandlers } from "../gateway/server";

export function createBotAdminCommands(d: { bots: BotService }): CommandHandlers {
  return {
    setAgentHiddenFromSidebar: (a) => ({ agent: d.bots.setHidden(a.id, Boolean(a.hidden)) }),
    duplicateAgent: (a) => ({ id: d.bots.duplicate(a.id) }),
    setAgentUnread: (a) => ({ agent: d.bots.setUnread(a.id, Boolean(a.unread)) }),
    setAgentNotificationsEnabled: (a) => ({ agent: d.bots.setNotify(a.id, Boolean(a.enabled)) }),
  };
}
