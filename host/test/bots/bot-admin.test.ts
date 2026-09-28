import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBotAdminCommands } from "../../bots/commands";
import { createSettingsToolExtension } from "../../bots/settings-tool";
import { botDir } from "../../store/layout";
import { makeRunnerHarness } from "../runner/harness";

describe("Bot admin (BOT-08, BOT-10, BOT-14, SET-15)", () => {
  it("hides (and unpins), unhides, marks unread and toggles notifications", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const cmd = createBotAdminCommands({ bots: h.bots });
    const id = h.bots.create({ name: "Scout", origin: "user", kickstart: false });
    h.bots.setPinned(id, true);
    const hidden = await cmd.setAgentHiddenFromSidebar!({ id, hidden: true });
    expect(hidden.agent.settings.hiddenFromSidebar).toBe(true);
    expect(h.settings.view().pinnedAgentIds).not.toContain(id);
    expect((await cmd.setAgentHiddenFromSidebar!({ id, hidden: false })).agent.settings.hiddenFromSidebar).toBe(false);
    expect((await cmd.setAgentUnread!({ id, unread: true })).agent.marker).toBe("unread");
    expect((await cmd.setAgentUnread!({ id, unread: false })).agent.marker).toBeNull();
    expect((await cmd.setAgentNotificationsEnabled!({ id, enabled: false })).agent.settings.notifyOnAgentUpdates).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(botDir(h.cfg, id), "settings.json"), "utf8")).notifyOnAgentUpdates).toBe(false);
  });

  it("duplicates profile, settings, enabled skills, avatar and routine definitions — not conversation, memory or session", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const cmd = createBotAdminCommands({ bots: h.bots });
    const id = h.bots.create({ name: "Scout", description: "ONLY job: research", model: "claude-opus-5", origin: "user", kickstart: false });
    h.bots.setHidden(id, true);
    const dir = botDir(h.cfg, id);
    fs.writeFileSync(path.join(dir, "enabled-workflows.json"), JSON.stringify({ disabled: ["x"] }));
    fs.writeFileSync(path.join(dir, "avatar.svg"), "<svg/>");
    fs.mkdirSync(path.join(dir, "automations", "r1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "automations", "r1", "automation.json"), JSON.stringify({ name: "Daily", enabled: true }));
    fs.writeFileSync(path.join(dir, "automations", "r1", "runs.json"), "[]");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "profile.md"), "# About the user\n");
    h.bots.setSessionId(id, "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a");
    const { id: copy } = await cmd.duplicateAgent!({ id });
    const s = h.bots.summary(copy);
    expect(s.profile).toMatchObject({ name: "Scout copy", description: "ONLY job: research", model: "claude-opus-5" });
    expect(s.settings.hiddenFromSidebar).toBe(false);
    const cdir = botDir(h.cfg, copy);
    expect(JSON.parse(fs.readFileSync(path.join(cdir, "enabled-workflows.json"), "utf8"))).toEqual({ disabled: ["x"] });
    expect(fs.existsSync(path.join(cdir, "avatar.svg"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(cdir, "automations", "r1", "automation.json"), "utf8"))).toEqual({ name: "Daily", enabled: true });
    expect(fs.existsSync(path.join(cdir, "automations", "r1", "runs.json"))).toBe(false);
    expect(fs.existsSync(path.join(cdir, "memory"))).toBe(false);
    expect(h.bots.sessionId(copy)).toBeNull();
    expect(h.bots.tail(copy, 10).map((e) => e.kind)).toEqual(["event"]); // only its own bot-created row
  });

  it("refuses to duplicate a group", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Team", origin: "user", kickstart: false });
    fs.writeFileSync(path.join(botDir(h.cfg, id), "group.json"), JSON.stringify({ version: 1, memberIds: [] }));
    expect(() => h.bots.duplicate(id)).toThrow("Groups can't be duplicated yet.");
  });

  it("update_state settings sets hide and notify (TOOL-19)", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const id = h.bots.create({ name: "Scout", origin: "user", kickstart: false });
    const ext = createSettingsToolExtension({ bots: h.bots });
    const r = await ext.updateState!.settings!({ botId: id, slot: null, args: { target: "settings", action: "set", hidden_from_sidebar: true, notify_on_updates: false }, now: Date.now });
    expect(r.text).toBe("Updated your settings.");
    expect(h.bots.summary(id).settings).toEqual({ notifyOnAgentUpdates: false, hiddenFromSidebar: true });
  });
});
