import { LIMITS, STR, type AvatarShape, type BotSummary } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";

const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#>~]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").trim();

/** GRP-01: "Kenny, Tyler & Jenny" — member first names, commas, and an ampersand before the last. */
export function defaultGroupName(names: string[]): string {
  const first = names.map((n) => n.trim().split(/\s+/)[0] || n.trim());
  if (first.length <= 1) return first.join("");
  return `${first.slice(0, -1).join(", ")} & ${first[first.length - 1]}`;
}

export class GroupService {
  private memberListeners: ((groupId: string, previous: string[]) => void)[] = [];

  constructor(private d: { bots: BotService; cfg: HostConfig; now?(): number }) {}

  /** Called after a group's member list changes, with the members before it (the orchestrator cancels the running room turn). */
  onMembersChanged(fn: (groupId: string, previous: string[]) => void): void {
    this.memberListeners.push(fn);
  }

  private membersChanged(groupId: string, previous: string[]): void {
    for (const fn of this.memberListeners) fn(groupId, previous);
  }

  isGroup(id: string): boolean {
    return this.d.bots.has(id) && this.d.bots.require(id).group !== null;
  }

  members(groupId: string): string[] {
    return [...(this.d.bots.require(groupId).group?.memberIds ?? [])];
  }

  private validate(memberIds: string[]): string[] {
    const ids = [...new Set(memberIds)];
    if (ids.length !== memberIds.length || ids.length < LIMITS.groupMinMembers || ids.length > LIMITS.groupMaxMembers) {
      throw new GatewayError("GROUP_SIZE", STR.groupMembersRange, 400);
    }
    for (const id of ids) {
      this.d.bots.require(id);
      if (this.isGroup(id)) throw new GatewayError("GROUP_NESTED", STR.groupNested, 400);
    }
    return ids;
  }

  create(memberIds: string[], a: { name?: string; avatarShape?: AvatarShape; avatarColor?: string; origin: "user" | "bot" }): { id: string; reused: boolean } {
    const ids = this.validate(memberIds);
    const key = [...ids].sort().join("|");
    const existing = this.d.bots.ids().find((g) => this.isGroup(g) && [...this.members(g)].sort().join("|") === key);
    if (existing) return { id: existing, reused: true };
    const name = a.name?.trim() || defaultGroupName(ids.map((id) => this.d.bots.summary(id).profile.name));
    const id = this.d.bots.create({ name, avatarShape: a.avatarShape, avatarColor: a.avatarColor, origin: a.origin, kickstart: false, group: { memberIds: ids } });
    return { id, reused: false };
  }

  setMembers(groupId: string, memberIds: string[]): BotSummary {
    if (!this.isGroup(groupId)) throw new GatewayError("NOT_A_GROUP", "Not a group.", 400);
    const previous = this.members(groupId);
    const agent = this.d.bots.setGroupMemberIds(groupId, this.validate(memberIds));
    this.membersChanged(groupId, previous);
    return agent;
  }

  /** LeaveChannel: the calling Bot leaves; a group may drop below two members this way (the user can add members back). */
  leave(groupId: string, botId: string): void {
    if (!this.isGroup(groupId)) throw new GatewayError("NOT_A_GROUP", "Not a group.", 400);
    const previous = this.members(groupId);
    this.d.bots.setGroupMemberIds(groupId, previous.filter((m) => m !== botId));
    this.membersChanged(groupId, previous);
  }

  groupsOf(botId: string): string[] {
    return this.d.bots.ids().filter((g) => this.isGroup(g) && this.members(g).includes(botId));
  }

  /** BOT-09: a deleted Bot disappears from every group it was in. */
  onBotRemoved(botId: string): void {
    for (const g of this.groupsOf(botId)) {
      const previous = this.members(g);
      this.d.bots.setGroupMemberIds(g, previous.filter((m) => m !== botId));
      this.membersChanged(g, previous);
    }
  }

  /** GRP-15: "<Sender>: <first line>"; the user's own posts ("You: …") update the preview without marking the group unread. */
  notePost(groupId: string, senderName: string, text: string): void {
    const line = `${senderName}: ${firstLine(text)}`.slice(0, 200);
    if (senderName === "You") {
      const b = this.d.bots.require(groupId);
      b.store.setKv("lastPreview", line);
      b.store.setKv("updatedAt", (this.d.now ?? Date.now)());
      this.d.bots.publish(groupId);
      return;
    }
    this.d.bots.noteBotMessage(groupId, line);
  }

  assertDuplicable(id: string): void {
    if (this.isGroup(id)) throw new GatewayError("GROUP_DUPLICATE", STR.groupsCantDuplicate, 400);
  }
}

export function groupHandlers(g: GroupService): Pick<CommandHandlers, "createGroup" | "setGroupMembers"> {
  return {
    createGroup: (a) => g.create(a.memberIds, { name: a.name, origin: "user" }),
    setGroupMembers: (a) => ({ agent: g.setMembers(a.id, a.memberIds) }),
  };
}
