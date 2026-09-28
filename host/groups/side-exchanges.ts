import type { AgentMessageEntry } from "@synapse/shared";
import type { ChainStore } from "../b2b/chains";
import type { BotService } from "../bots/bot-service";
import type { GroupService } from "./group-service";

/** GRP-14 / ORIG-18 §18.5: Bot-to-Bot messages of a chain that started in a room turn of group G are mirrored into G's transcript. */
export class SideExchangeMirror {
  constructor(private d: { bots: BotService; chains: ChainStore; groups: GroupService; now(): number }) {}

  onAgentMessage(chainId: string, entry: AgentMessageEntry, botId: string): void {
    if (!entry.toAgent) return; // only the sender's outbound entry is mirrored, so each message appears once
    const groupId = this.d.chains.get(chainId)?.groupId;
    if (!groupId || !this.d.groups.isGroup(groupId) || !this.d.bots.has(botId)) return;
    const [id] = this.d.bots.auxEntryIds(groupId, 1);
    const sender = this.d.bots.summary(botId).profile.name;
    const copy: AgentMessageEntry = {
      kind: "message", id: id!, role: "assistant", content: entry.content, chainId, createdAt: entry.createdAt || this.d.now(),
      fromAgent: { ...entry.toAgent, id: botId, name: sender },
      toAgent: entry.toAgent,
      ...(entry.inbox ? { inbox: true } : {}),
    };
    this.d.bots.appendEntry(groupId, copy);
  }
}
