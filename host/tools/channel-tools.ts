import { normalizeAvatarColor, normalizeAvatarShape, type AvatarShape } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { GroupService } from "../groups/group-service";
import type { ToolProvider, TurnRunner } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";

const err = (text: string): BotToolResult => ({ text, isError: true });
const msg = (e: unknown) => (e instanceof GatewayError ? e.message : String(e));

function avatar(a: Record<string, unknown>): { avatarShape?: AvatarShape; avatarColor?: string } | string {
  const out: { avatarShape?: AvatarShape; avatarColor?: string } = {};
  if (a.avatar_shape !== undefined) {
    const s = normalizeAvatarShape(a.avatar_shape); // bug 292: an old id still works
    if (!s) return `Unknown avatar_shape "${String(a.avatar_shape)}".`;
    out.avatarShape = s;
  }
  if (a.avatar_color !== undefined) {
    const c = normalizeAvatarColor(a.avatar_color);
    if (!c) return `Unknown avatar_color "${String(a.avatar_color)}".`;
    out.avatarColor = c;
  }
  return out;
}

/**
 * CreateChannel, UpdateChannel, LeaveChannel (GRP-01, GRP-02, ORIG-17 §17.1-17.2).
 * None of these is Auto-reviewed (ORIG-17 §17.1). Creation is registration only: no member
 * process starts (ORIG-16 §16.1).
 */
export function channelProvider(d: { groups: GroupService; bots: BotService; runner: TurnRunner; now(): number }): ToolProvider {
  const names = (ids: string[]) => ids.map((id) => d.bots.summary(id).profile.name).join(", ");
  /**
   * Per-turn token floor: a tool's schema is re-sent on every model call of the session, so a tool
   * that cannot succeed is a standing tax. These three cannot. A group needs 2 to 6 Bots, so on an
   * app with one Bot CreateChannel has nothing to make a group out of; UpdateChannel and LeaveChannel
   * both begin by refusing a Bot that is not already a member. Measured with the CLI's own /context
   * accounting on 2026-09-19: 250 + 248 + 123 = 621 tokens a turn.
   */
  const botCount = () => d.bots.list().filter((b) => !b.group).length;
  return (botId: string, _slot: () => TurnSlot | null): BotToolDef[] => {
    const all: BotToolDef[] = [
    {
      name: "CreateChannel",
      description: "Create a group chat with 2 to 6 Bots (you may include yourself). An existing group with the same members is reused. Post to it with SendToAgent target_id <group id>.",
      readOnly: false,
      schema: { member_ids: z.array(z.string()), name: z.string().optional(), avatar_shape: z.string().optional(), avatar_color: z.string().optional() },
      handler: async (a) => {
        const av = avatar(a);
        if (typeof av === "string") return err(av);
        const memberIds = [...new Set((a.member_ids as string[] | undefined) ?? [])];
        try {
          const { id, reused } = d.groups.create(memberIds, { name: a.name === undefined ? undefined : String(a.name), ...av, origin: "bot" });
          const name = d.bots.summary(id).profile.name;
          if (reused) return { text: `A group with these members already exists: "${name}" (id: ${id}).` };
          const [eid] = d.bots.auxEntryIds(botId, 1);
          d.bots.appendEntry(botId, { kind: "event", id: eid!, createdAt: d.now(), event: { type: "group-created", groupId: id, name } });
          return { text: `Created group "${name}" (id: ${id}). Post to it with SendToAgent target_id ${id}.` };
        } catch (e) {
          return err(msg(e));
        }
      },
    },
    {
      name: "UpdateChannel",
      description: "Rename a group, change its avatar, or add and remove members.",
      readOnly: false,
      schema: {
        channel_id: z.string(), name: z.string().optional(), add_member_ids: z.array(z.string()).optional(), remove_member_ids: z.array(z.string()).optional(),
        avatar_shape: z.string().optional(), avatar_color: z.string().optional(),
      },
      handler: async (a) => {
        const gid = String(a.channel_id);
        if (!d.groups.isGroup(gid)) return err(`No group with id ${gid}.`);
        if (!d.groups.members(gid).includes(botId)) return err("You aren't a member of that group.");
        const av = avatar(a);
        if (typeof av === "string") return err(av);
        try {
          const add = (a.add_member_ids as string[] | undefined) ?? [];
          const remove = new Set((a.remove_member_ids as string[] | undefined) ?? []);
          if (add.length || remove.size) {
            const next = [...d.groups.members(gid).filter((m) => !remove.has(m)), ...add.filter((m) => !remove.has(m))];
            d.groups.setMembers(gid, [...new Set(next)]);
          }
          const before = d.bots.summary(gid).profile.name;
          const patch: { name?: string; avatarShape?: AvatarShape; avatarColor?: string } = { ...av };
          if (a.name !== undefined && String(a.name).trim()) patch.name = String(a.name);
          const s = d.bots.update(gid, patch);
          if (s.profile.name !== before) {
            const [eid] = d.bots.auxEntryIds(gid, 1);
            d.bots.appendEntry(gid, { kind: "event", id: eid!, createdAt: d.now(), event: { type: "renamed", name: s.profile.name } });
          }
          return { text: `Updated group "${s.profile.name}": ${names(d.groups.members(gid))}.` };
        } catch (e) {
          return err(msg(e));
        }
      },
    },
    {
      name: "LeaveChannel",
      description: "Leave a group you are a member of.",
      readOnly: false,
      schema: { channel_id: z.string() },
      handler: async (a) => {
        const gid = String(a.channel_id);
        if (!d.groups.isGroup(gid)) return err(`No group with id ${gid}.`);
        if (!d.groups.members(gid).includes(botId)) return err("You aren't a member of that group.");
        try {
          d.groups.leave(gid, botId);
          return { text: `You left "${d.bots.summary(gid).profile.name}".` };
        } catch (e) {
          return err(msg(e));
        }
      },
    },
    ];
    return all.filter((t) => (t.name === "CreateChannel" ? botCount() >= 2 : d.groups.groupsOf(botId).length > 0));
  };
}
