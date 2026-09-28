import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { GroupService } from "../../groups/group-service";
import { newSlot } from "../../runner/turn-slot";
import type { TurnRunner } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { channelProvider } from "../../tools/channel-tools";
import { tmpConfig } from "../helpers";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const groups = new GroupService({ bots, cfg });
  const planner = bots.create({ origin: "user", kickstart: false, name: "Planner" });
  const scout = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const ledger = bots.create({ origin: "user", kickstart: false, name: "Ledger" });
  const slot = newSlot({ botId: planner, requestId: "r", turnNo: 2, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const provider = channelProvider({ groups, bots, runner: {} as TurnRunner, now: () => 5 });
  // The three are capability-gated (CreateChannel needs a second Bot; UpdateChannel/LeaveChannel need
  // the caller to already be in a group), so the set is rebuilt per lookup the way a real turn does.
  const names = () => provider(planner, () => slot).map((t) => t.name);
  const tool = (n: string) => {
    const t = provider(planner, () => slot).find((x) => x.name === n);
    if (!t) throw new Error(`${n} is not mounted for this Bot`);
    return t;
  };
  return { bots, groups, planner, scout, ledger, tool, names };
}

describe("CreateChannel (GRP-01)", () => {
  it("registers a group, names it from the members, posts a row in the caller's chat and reuses the same member set", async () => {
    const s = setup();
    const r = await s.tool("CreateChannel").handler({ member_ids: [s.planner, s.scout, s.ledger] });
    const id = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(r.text).toBe(`Created group "Planner, Scout & Ledger" (id: ${id}). Post to it with SendToAgent target_id ${id}.`);
    expect(s.groups.isGroup(id)).toBe(true);
    expect(s.bots.tail(s.planner, 5).at(-1)).toMatchObject({ kind: "event", event: { type: "group-created", groupId: id, name: "Planner, Scout & Ledger" } });
    const again = await s.tool("CreateChannel").handler({ member_ids: [s.ledger, s.scout, s.planner], name: "Other" });
    expect(again.text).toBe(`A group with these members already exists: "Planner, Scout & Ledger" (id: ${id}).`);
  });

  it("returns the member-count and nesting rules as tool errors", async () => {
    const s = setup();
    expect(await s.tool("CreateChannel").handler({ member_ids: [s.scout] })).toEqual({ text: STR.groupMembersRange, isError: true });
    const r = await s.tool("CreateChannel").handler({ member_ids: [s.planner, s.scout] });
    const gid = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(await s.tool("CreateChannel").handler({ member_ids: [gid, s.ledger] })).toEqual({ text: STR.groupNested, isError: true });
  });
});

describe("UpdateChannel and LeaveChannel", () => {
  it("renames, adds and removes members", async () => {
    const s = setup();
    const r = await s.tool("CreateChannel").handler({ member_ids: [s.planner, s.scout] });
    const gid = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(await s.tool("UpdateChannel").handler({ channel_id: gid, name: "Pricing", add_member_ids: [s.ledger] })).toEqual({ text: 'Updated group "Pricing": Planner, Scout, Ledger.' });
    expect(s.groups.members(gid)).toEqual([s.planner, s.scout, s.ledger]);
    expect(s.bots.tail(gid, 5).some((e) => e.kind === "event" && e.event.type === "renamed")).toBe(true);
    expect(await s.tool("UpdateChannel").handler({ channel_id: gid, remove_member_ids: [s.scout] })).toEqual({ text: 'Updated group "Pricing": Planner, Ledger.' });
    expect((await s.tool("UpdateChannel").handler({ channel_id: s.scout, name: "x" })).isError).toBe(true);
  });

  it("refuses to let a non-member mutate a group it doesn't belong to", async () => {
    const s = setup();
    // The caller is in a group of its own, so it really does hold UpdateChannel; the refusal below is
    // the membership check doing the work, not the tool being absent.
    await s.tool("CreateChannel").handler({ member_ids: [s.planner, s.scout] });
    expect(s.names()).toContain("UpdateChannel");
    const r = await s.tool("CreateChannel").handler({ member_ids: [s.scout, s.ledger] });
    const gid = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(s.groups.members(gid)).toEqual([s.scout, s.ledger]);

    // The caller (planner) is not a member of this group and must not be able to self-add.
    expect(await s.tool("UpdateChannel").handler({ channel_id: gid, add_member_ids: [s.planner] })).toEqual({
      text: "You aren't a member of that group.",
      isError: true,
    });
    expect(s.groups.members(gid)).toEqual([s.scout, s.ledger]);

    // Nor rename it or remove members from it.
    expect(await s.tool("UpdateChannel").handler({ channel_id: gid, name: "Hijacked" })).toEqual({
      text: "You aren't a member of that group.",
      isError: true,
    });
    expect(await s.tool("UpdateChannel").handler({ channel_id: gid, remove_member_ids: [s.ledger] })).toEqual({
      text: "You aren't a member of that group.",
      isError: true,
    });
    expect(s.groups.members(gid)).toEqual([s.scout, s.ledger]);
  });

  it("the caller leaves a group", async () => {
    const s = setup();
    const r = await s.tool("CreateChannel").handler({ member_ids: [s.planner, s.scout, s.ledger] });
    const gid = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    const leave = s.tool("LeaveChannel"); // held across the leave: the tool unmounts once it is in no group
    expect(await leave.handler({ channel_id: gid })).toEqual({ text: 'You left "Planner, Scout & Ledger".' });
    expect(s.groups.members(gid)).toEqual([s.scout, s.ledger]);
    // Leaving twice is still refused by the membership check…
    expect((await leave.handler({ channel_id: gid })).isError).toBe(true);
    // …and the next turn does not carry the schema at all.
    expect(s.names()).not.toContain("LeaveChannel");
  });
});
