import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR, type SseEvent } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { GroupService, defaultGroupName, groupHandlers } from "../../groups/group-service";
import { HostSettingsStore } from "../../store/host-settings";
import { botDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const groups = new GroupService({ bots, cfg });
  const mk = (name: string) => bots.create({ origin: "user", kickstart: false, name });
  return { cfg, hub, events, settings, bots, groups, mk };
}

describe("defaultGroupName (GRP-01)", () => {
  it("joins member first names with commas and an ampersand", () => {
    expect(defaultGroupName(["Kenny Rogers", "Tyler", "Jenny Lee"])).toBe("Kenny, Tyler & Jenny");
    expect(defaultGroupName(["Scout", "Ledger"])).toBe("Scout & Ledger");
  });
});

describe("GroupService (GRP-01, §4.2)", () => {
  it("creates a group folder with group.json, a group-created event and a summary with members", () => {
    const { cfg, bots, groups, mk } = setup();
    const a = mk("Planner"), b = mk("Scout"), c = mk("Ledger");
    const { id, reused } = groups.create([a, b, c], { origin: "user" });
    expect(reused).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(botDir(cfg, id), "group.json"), "utf8"))).toEqual({ version: 1, memberIds: [a, b, c] });
    const s = bots.summary(id);
    expect(s.profile.name).toBe("Planner, Scout & Ledger");
    expect(s.group).toEqual({ memberIds: [a, b, c] });
    expect(bots.summary(a).group).toBeNull();
    expect(groups.isGroup(id)).toBe(true);
    expect(groups.isGroup(a)).toBe(false);
    const first = bots.tail(id, 5)[0]!;
    expect(first).toMatchObject({ kind: "event", event: { type: "group-created", groupId: id, name: "Planner, Scout & Ledger" } });
  });

  it("reuses an existing group with the same member set in any order", () => {
    const { groups, mk } = setup();
    const a = mk("A"), b = mk("B");
    const g1 = groups.create([a, b], { origin: "user", name: "Pair" });
    const g2 = groups.create([b, a], { origin: "bot" });
    expect(g2).toEqual({ id: g1.id, reused: true });
  });

  it("enforces 2–6 members, existing Bots, no nesting, no duplicates", () => {
    const { groups, mk } = setup();
    const ids = Array.from({ length: 7 }, (_, i) => mk(`B${i}`));
    expect(() => groups.create([ids[0]!], { origin: "user" })).toThrow(STR.groupMembersRange);
    expect(() => groups.create(ids, { origin: "user" })).toThrow(STR.groupMembersRange);
    expect(() => groups.create([ids[0]!, ids[0]!], { origin: "user" })).toThrow(STR.groupMembersRange);
    expect(() => groups.create([ids[0]!, "4a0c6f0e-1111-4222-8333-944455556666"], { origin: "user" })).toThrow("No such Bot");
    const g = groups.create([ids[0]!, ids[1]!], { origin: "user" });
    expect(() => groups.create([g.id, ids[2]!], { origin: "user" })).toThrow(STR.groupNested);
  });

  it("counts groups toward the 50 cap", () => {
    const { groups, mk } = setup();
    const ids = Array.from({ length: 49 }, (_, i) => mk(`B${i}`));
    groups.create([ids[0]!, ids[1]!], { origin: "user" });
    expect(() => mk("one too many")).toThrow(STR.maxBots);
  });

  it("changes membership, leaves, drops deleted members and survives a reload", () => {
    const { cfg, hub, settings, bots, groups, mk } = setup();
    const a = mk("A"), b = mk("B"), c = mk("C");
    const { id } = groups.create([a, b], { origin: "user" });
    expect(groups.setMembers(id, [a, b, c]).group?.memberIds).toEqual([a, b, c]);
    expect(groups.groupsOf(c)).toEqual([id]);
    groups.leave(id, c);
    expect(groups.members(id)).toEqual([a, b]);
    groups.onBotRemoved(b);
    expect(groups.members(id)).toEqual([a]);
    const reloaded = new BotService({ cfg, hub, settings });
    reloaded.loadAll();
    expect(reloaded.summary(id).group).toEqual({ memberIds: [a] });
    expect(() => groups.setMembers(a, [b, c])).toThrow("Not a group");
  });

  it("refuses to duplicate a group", () => {
    const { groups, mk } = setup();
    const { id } = groups.create([mk("A"), mk("B")], { origin: "user" });
    expect(() => groups.assertDuplicable(id)).toThrow(STR.groupsCantDuplicate);
  });

  it("writes the row preview: '<Sender>: first line', 'You: …' without unread (GRP-15)", () => {
    const { bots, groups, mk } = setup();
    const { id } = groups.create([mk("Planner"), mk("Scout")], { origin: "user" });
    groups.notePost(id, "Planner", "**Blocked** Oct 24–25 on your calendar\nand more");
    expect(bots.summary(id).statusLine).toBe("Planner: Blocked Oct 24–25 on your calendar");
    groups.notePost(id, "You", "book the cabin");
    expect(bots.summary(id).statusLine).toBe("You: book the cabin");
  });

  it("exposes createGroup and setGroupMembers gateway handlers", async () => {
    const { groups, mk } = setup();
    const a = mk("A"), b = mk("B"), c = mk("C");
    const h = groupHandlers(groups);
    const r = await h.createGroup!({ memberIds: [a, b], name: "Duo" });
    expect(r.reused).toBe(false);
    expect((await h.setGroupMembers!({ id: r.id, memberIds: [a, b, c] })).agent.group?.memberIds).toHaveLength(3);
  });
});
