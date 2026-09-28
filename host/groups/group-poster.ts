import { LIMITS, sendEntryId, type SendMessageEntry, type SendToAgentArgs } from "@synapse/shared";
import { gatePost } from "../b2b/gate";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult } from "../brain/types";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import type { GroupPoster } from "../tools/send-to-agent";
import { log } from "../util/log";
import { isPass, mentionedMembers } from "./addressing";
import type { GroupService } from "./group-service";
import type { GroupOrchestrator } from "./orchestrator";

const WAKING = new Set(["request", "question", "blocker", "handoff"]);
const err = (text: string): BotToolResult => ({ text, isError: true });

/** GRP-09: SendToAgent{target_id: <groupId>} posts as a member send; only asks start a room turn (ORIG-09 §09.7). */
export class BotGroupPoster implements GroupPoster {
  constructor(private d: { groups: GroupService; orchestrator: GroupOrchestrator; bots: BotService; now(): number; metrics?: RuntimeMetrics | null }) {}

  isGroup(id: string): boolean {
    return this.d.groups.isGroup(id);
  }

  async postFromBot(groupId: string, fromBotId: string, args: SendToAgentArgs, chainId: string): Promise<BotToolResult> {
    if (!this.d.groups.isGroup(groupId)) return err(`No group with id ${groupId}.`);
    const groupName = this.d.bots.summary(groupId).profile.name;
    if (!this.d.groups.members(groupId).includes(fromBotId)) return err(`Not sent: you're not a member of "${groupName}".`);
    const text = args.message.trim().slice(0, LIMITS.b2bMessageMax);
    if (!text) return err("Not sent: message is required.");
    if (isPass(text)) return err('Not sent: "(pass)" is only for your own turn in a group chat.');
    const history = this.d.orchestrator.roomHistory(groupId);
    const lastOwn = [...history].reverse().find((m) => m.from === fromBotId)?.text ?? null;
    const gate = gatePost({ text, history: history.filter((m) => m.from !== fromBotId).slice(-LIMITS.groupPromptHistory).map((m) => m.text), lastOwnPost: lastOwn, now: this.d.now() });
    if (gate.verdict === "drop") {
      this.d.metrics?.bump(fromBotId, "dropped");
      return { text: `Not sent: it adds nothing new to "${groupName}". Post only new results, questions, requests or blockers.` };
    }
    const notes: string[] = [];
    if (args.images?.length) notes.push("Images aren't posted to groups; only the text was sent.");
    if (args.priority) notes.push("Priority doesn't apply to group posts.");
    const name = this.d.bots.summary(fromBotId).profile.name;
    const entry: SendMessageEntry = {
      kind: "send-message", id: sendEntryId(this.d.bots.nextTurnNo(groupId), 1), requestId: `b2b_${chainId}`, createdAt: this.d.now(),
      message: { type: "text", content: text }, author: { id: fromBotId, name },
    };
    this.d.bots.appendEntry(groupId, entry);
    this.d.groups.notePost(groupId, name, text);
    let head: string;
    if (!WAKING.has(args.kind)) head = `Posted to "${groupName}" (no one was woken: ${args.kind} posts don't start a room turn).`;
    else if (this.d.orchestrator.isActive(groupId)) head = `Posted to "${groupName}". The room is already talking; its members will see your post on their turn.`;
    else {
      const others = this.d.groups.members(groupId).filter((m) => m !== fromBotId && this.d.bots.has(m)).map((m) => ({ id: m, name: this.d.bots.summary(m).profile.name }));
      void this.d.orchestrator.startRoomTurn(groupId, { mentioned: mentionedMembers(text, others), chainId, lane: "agent", exclude: [fromBotId] }).catch((e) =>
        log.error("group room turn failed", { groupId, error: e instanceof Error ? e.message : String(e) }),
      );
      head = `Posted to "${groupName}". The other members will take turns.`;
    }
    return { text: [head, ...notes].join(" ") };
  }
}
