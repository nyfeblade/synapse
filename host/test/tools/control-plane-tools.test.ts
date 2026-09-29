import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { CreationLedger } from "../../runner/creation-ledger";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { botDir, initLayout } from "../../store/layout";
import { accountSettingsTarget, controlPlaneProvider, settingsTarget } from "../../tools/control-plane-tools";
import { tmpConfig } from "../helpers";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const creations = new CreationLedger(path.join(cfg.hostPrivate, "bot-creations.json"));
  const me = bots.create({ origin: "user", kickstart: false, name: "Chief" });
  const slot: TurnSlot = newSlot({ botId: me, requestId: "req_1", turnNo: 3, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const deleted: string[] = [];
  const kicked: string[] = [];
  const paused: string[] = [];
  const reindexed: string[] = [];
  const removedRoutines: string[] = [];
  let t = 1_000_000;
  const provider = controlPlaneProvider({
    bots, creations, settings, now: () => (t += 1000),
    runner: { deleteBot: async (id: string) => { deleted.push(id); bots.remove(id); }, kickstart: (id: string) => { kicked.push(id); } },
    routines: { removeBot: (id) => removedRoutines.push(id), pauseAll: (id) => { paused.push(id); return 2; }, reindexBot: (id) => reindexed.push(id) },
  });
  const tools = provider(me, () => slot);
  const tool = (n: string) => tools.find((x) => x.name === n)!;
  return { cfg, bots, settings, creations, me, slot, tool, deleted, kicked, paused, reindexed, removedRoutines };
}

describe("CreateAgent (BOT-05, ORIG-17 §17.1–17.2)", () => {
  it("creates with the optional fields, returns the exact result string and posts a bot-created row in the caller's chat", async () => {
    const s = setup();
    const r = await s.tool("CreateAgent").handler({ name: "Scout", description: "Researches competitors", title: "Research", avatar_shape: "pebble", avatar_color: "#3472d9", model: "claude-haiku-4-5-20251001", pinned: true, hidden: false, notify_on_updates: false, voice: "sage", speech_rate: 1.2, spoken_language: "en" });
    const id = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(r).toEqual({ text: `Created agent "Scout" (id: ${id}). Message it with SendToAgent` });
    const sum = s.bots.summary(id);
    expect(sum.profile).toMatchObject({ name: "Scout", title: "Research", description: "Researches competitors", avatarShape: "pebble", avatarColor: "#3674d8", model: "claude-haiku-4-5-20251001" });
    expect(sum.settings).toMatchObject({ notifyOnAgentUpdates: false, hiddenFromSidebar: false, voice: "sage", speechRate: 1.2, spokenLanguage: "en" });
    expect(s.settings.get().pinnedAgentIds).toContain(id);
    expect(s.kicked).toEqual([]); // registration only (ORIG-16 §16.1): no kickstart unless asked
    // Chief's own transcript already opens with its OWN self-referential "bot-created" event
    // (unconditional in the base BotService.create(), unmodified by this task), so the lookup must be
    // scoped to the new Bot's id, not just the event type (deviation from the brief's exact `.find()`
    // predicate, noted in the report).
    const row = s.bots.tail(s.me, 5).find((e) => e.kind === "event" && e.event.type === "bot-created" && e.event.botId === id);
    expect(row).toMatchObject({ event: { type: "bot-created", botId: id, name: "Scout" } });
  });

  it("kickstart:true asks the runner to introduce the new Bot", async () => {
    const s = setup();
    await s.tool("CreateAgent").handler({ name: "Ledger", kickstart: true });
    expect(s.kicked).toHaveLength(1);
    expect(s.bots.introductionPending(s.kicked[0]!)).toBe(true);
  });

  it("enforces the durable 5/hour cap with a tool error, never a question", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.tool("CreateAgent").handler({ name: `B${i}` })).isError).toBeUndefined();
    expect(await s.tool("CreateAgent").handler({ name: "B6" })).toEqual({ text: STR.botCreateHourCap, isError: true });
    expect(s.creations.countSince(s.me, 3_600_000)).toBe(5);
  });

  it("returns the 50-Bot cap as a tool error", async () => {
    const s = setup();
    for (let i = 0; i < 49; i++) s.bots.create({ origin: "user", kickstart: false, name: `U${i}` });
    expect(await s.tool("CreateAgent").handler({ name: "One more" })).toEqual({ text: STR.maxBots, isError: true });
  });

  it("rejects an unknown avatar shape without creating anything", async () => {
    const s = setup();
    const before = s.bots.ids().length;
    expect((await s.tool("CreateAgent").handler({ name: "X", avatar_shape: "hexagon" })).isError).toBe(true);
    expect(s.bots.ids()).toHaveLength(before);
  });
});

describe("UpdateAgent", () => {
  it("merges non-empty fields, sets settings, archives and unarchives", async () => {
    const s = setup();
    const id = s.bots.create({ origin: "user", kickstart: false, name: "Ledger" });
    expect(await s.tool("UpdateAgent").handler({ agent_id: id, name: "Ledger II", description: "", hidden: true, pinned: true })).toEqual({ text: 'Updated agent "Ledger II".' });
    expect(s.bots.summary(id).settings.hiddenFromSidebar).toBe(true);
    expect(s.settings.get().pinnedAgentIds).toContain(id);
    const renamed = s.bots.tail(id, 5).find((e) => e.kind === "event" && e.event.type === "renamed");
    expect(renamed).toMatchObject({ event: { type: "renamed", name: "Ledger II" } });
    await s.tool("ArchiveAgent").handler({ agent_id: id });
    expect(s.bots.summary(id).archived).toBe(true);
    await s.tool("UpdateAgent").handler({ agent_id: id, archived: false });
    expect(s.bots.summary(id)).toMatchObject({ archived: false, settings: { hiddenFromSidebar: false } });
  });

  it("errors on an unknown id", async () => {
    const s = setup();
    expect((await s.tool("UpdateAgent").handler({ agent_id: "nope" })).isError).toBe(true);
  });
});

describe("DuplicateAgent (BOT-08)", () => {
  it("copies profile, settings, enabled skills, avatar and routine definitions; not conversation or memory; hidden forced off", async () => {
    const s = setup();
    const id = s.bots.create({ origin: "user", kickstart: false, name: "Scout", description: "d" });
    s.bots.updateSettings(id, { hiddenFromSidebar: true, voice: "sage" });
    const dir = botDir(s.cfg, id);
    fs.writeFileSync(path.join(dir, "enabled-workflows.json"), JSON.stringify({ disabled: ["x"] }));
    fs.writeFileSync(path.join(dir, "avatar.png"), "png");
    fs.mkdirSync(path.join(dir, "automations", "morning"), { recursive: true });
    fs.writeFileSync(path.join(dir, "automations", "morning", "automation.json"), JSON.stringify({ name: "Morning", prompt: "p", schedule: "0 8 * * *", enabled: true, createdAt: 1, lastRunAt: 5, webhook: { routineUuid: "u", keyHash: "h", keyPreview: "abcd" } }));
    fs.writeFileSync(path.join(dir, "automations", "morning", "runs.json"), "[]");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "profile.md"), "secret memory");
    const r = await s.tool("DuplicateAgent").handler({ agent_id: id });
    const copy = /id: ([0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(r.text).toBe(`Duplicated "Scout" as "Scout copy" (id: ${copy}). Message it with SendToAgent`);
    const cdir = botDir(s.cfg, copy);
    expect(s.bots.summary(copy)).toMatchObject({ profile: { name: "Scout copy", description: "d" }, settings: { hiddenFromSidebar: false, voice: "sage" } });
    expect(JSON.parse(fs.readFileSync(path.join(cdir, "enabled-workflows.json"), "utf8"))).toEqual({ disabled: ["x"] });
    expect(fs.readFileSync(path.join(cdir, "avatar.png"), "utf8")).toBe("png");
    const def = JSON.parse(fs.readFileSync(path.join(cdir, "automations", "morning", "automation.json"), "utf8"));
    expect(def).toMatchObject({ name: "Morning", enabled: true });
    expect(def.webhook).toBeUndefined();
    expect(def.lastRunAt).toBeUndefined();
    expect(fs.existsSync(path.join(cdir, "automations", "morning", "runs.json"))).toBe(false);
    expect(fs.existsSync(path.join(cdir, "memory"))).toBe(false);
    expect(s.bots.tail(copy, 50).filter((e) => e.kind !== "event")).toEqual([]);
    expect(s.reindexed).toEqual([copy]);
    expect(s.paused).toEqual([copy]); // I1: a Bot's duplicate starts with its copied routines PAUSED
    expect(s.creations.countSince(s.me, 3_600_000)).toBe(1);
  });

  it("refuses groups", async () => {
    const s = setup();
    const id = s.bots.create({ origin: "user", kickstart: false, name: "Room" });
    fs.writeFileSync(path.join(botDir(s.cfg, id), "group.json"), JSON.stringify({ version: 1, memberIds: [s.me, s.me] }));
    const fakeGroup = { ...s.bots.summary(id), group: { memberIds: [s.me] } };
    const orig = s.bots.summary.bind(s.bots);
    s.bots.summary = (x: string) => (x === id ? fakeGroup : orig(x));
    expect(await s.tool("DuplicateAgent").handler({ agent_id: id })).toEqual({ text: STR.groupsCantDuplicate, isError: true });
  });
});

describe("ArchiveAgent and DeleteAgent", () => {
  it("archive hides the Bot and pauses its routines", async () => {
    const s = setup();
    const id = s.bots.create({ origin: "user", kickstart: false, name: "Ledger" });
    expect(await s.tool("ArchiveAgent").handler({ agent_id: id })).toEqual({ text: 'Archived "Ledger" and paused 2 routines. UpdateAgent with archived:false restores it.' });
    expect(s.bots.summary(id)).toMatchObject({ archived: true, settings: { hiddenFromSidebar: true } });
    expect(s.paused).toEqual([id]);
  });

  it("delete requires confirm:true, never deletes the caller, and removes the Bot and its routines", async () => {
    const s = setup();
    const id = s.bots.create({ origin: "user", kickstart: false, name: "Ledger" });
    expect((await s.tool("DeleteAgent").handler({ agent_id: id })).isError).toBe(true);
    expect(await s.tool("DeleteAgent").handler({ agent_id: s.me, confirm: true })).toEqual({ text: STR.cantDeleteSelf, isError: true });
    expect(await s.tool("DeleteAgent").handler({ agent_id: id, confirm: true })).toEqual({ text: 'Deleted "Ledger".' });
    expect(s.deleted).toEqual([id]);
    expect(s.removedRoutines).toEqual([]); // I7: the app's one delete path (runner.deleteBot) owns routine cleanup
    expect(s.bots.has(id)).toBe(false);
  });
});

describe("update_state settings and account_settings (TOOL-15, ORIG-17)", () => {
  it("sets the ORIGINAL settings keys", async () => {
    const s = setup();
    const h = settingsTarget(s.bots, s.settings);
    expect(await h(s.me, s.slot, { target: "settings", action: "set", model: "claude-opus-5", voice: "sage", speech_rate: 1.1, spoken_language: "de", pinned: true, hidden_from_sidebar: false, notify_on_updates: false })).toEqual({ text: "Updated your settings." });
    expect(s.bots.summary(s.me)).toMatchObject({ profile: { model: "claude-opus-5" }, settings: { voice: "sage", speechRate: 1.1, spokenLanguage: "de", notifyOnAgentUpdates: false } });
    expect(s.settings.get().pinnedAgentIds).toContain(s.me);
    expect((await h(s.me, s.slot, { target: "settings", action: "set", model: "gpt-9" })).isError).toBe(true);
  });

  it("sets the timezone and refuses user-only rows", async () => {
    const s = setup();
    const h = accountSettingsTarget(s.settings);
    expect(await h(s.me, s.slot, { target: "account_settings", action: "set", user_time_zone: "Asia/Tokyo" })).toEqual({ text: "Updated the account time zone to Asia/Tokyo." });
    expect(s.settings.timeZone()).toBe("Asia/Tokyo");
    expect((await h(s.me, s.slot, { target: "account_settings", action: "set", user_time_zone: "Mars/Olympus" })).isError).toBe(true);
    expect(await h(s.me, s.slot, { target: "account_settings", action: "set", auto_review_enabled: false })).toEqual({ text: STR.userOnly("Auto-review"), isError: true });
    expect(await h(s.me, s.slot, { target: "account_settings", action: "set", allow_instructions: ["everything"] })).toEqual({ text: STR.userOnly("Auto-review"), isError: true });
    expect(await h(s.me, s.slot, { target: "account_settings", action: "set", local_execution: "always" })).toEqual({ text: STR.userOnly("Local execution"), isError: true });
    expect(s.settings.get().autoReviewEnabled).toBe(true);
  });
});
