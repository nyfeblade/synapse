import path from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { loadConfig } from "../../config";
import { SseHub } from "../../gateway/sse-hub";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { BOT_USER_HELPER, sudoBotAccounts } from "../../walls/bot-accounts";
import { botUserName } from "../../walls/bot-uid";
import { tmpConfig } from "../helpers";

/** Bug #66: the host creates a Bot's OS account with the Bot, re-checks it every start, and removes it with the Bot. */
describe("bug #66: BotService keeps each Bot's OS account in step with the Bot", () => {
  const setup = (log: string[]) => {
    const cfg = { ...tmpConfig(), perBotUid: true };
    initLayout(cfg);
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const accounts = { ensure: (id: string) => { log.push(`ensure ${id}`); }, remove: (id: string) => { log.push(`remove ${id}`); } };
    const mk = () => new BotService({ cfg, hub: new SseHub(), settings, accounts });
    return { cfg, mk };
  };

  it("create ensures the account; a group gets none", () => {
    const log: string[] = [];
    const { mk } = setup(log);
    const bots = mk();
    bots.loadAll();
    const id = bots.create({ name: "Ada", origin: "user", kickstart: false });
    expect(log).toEqual([`ensure ${id}`]);
    bots.create({ name: "Team", origin: "user", kickstart: false, group: { memberIds: [id] } });
    expect(log).toEqual([`ensure ${id}`]);
  });

  it("every host start re-ensures every Bot (idempotent helper), and delete removes it", () => {
    const log: string[] = [];
    const { mk } = setup(log);
    const first = mk();
    first.loadAll();
    const id = first.create({ name: "Ada", origin: "user", kickstart: false });
    log.length = 0;
    const second = mk();
    second.loadAll();
    expect(log).toEqual([`ensure ${id}`]);
    second.remove(id);
    expect(log).toEqual([`ensure ${id}`, `remove ${id}`]);
  });

  it("the session path moves into the Bot's own config dir", () => {
    const { mk } = setup([]);
    const bots = mk();
    bots.loadAll();
    const id = bots.create({ name: "Ada", origin: "user", kickstart: false });
    bots.setSessionId(id, "s1");
    expect(bots.sessionFilePath(id)).toBe(`/home/bots/${botUserName(id)}/.claude/projects/${bots["d"].cfg.workspace.replace(/[^a-zA-Z0-9]/g, "-")}/s1.jsonl`);
  });

  it("sudoBotAccounts: only on a migrated box with the real brain; calls the helper through sudo -n", () => {
    expect(sudoBotAccounts(loadConfig({}))).toBeUndefined();
    expect(sudoBotAccounts(loadConfig({ SYNAPSE_PER_BOT_UID: "1", BRAIN: "fake" }))).toBeUndefined();
    const calls: string[][] = [];
    const a = sudoBotAccounts(loadConfig({ SYNAPSE_PER_BOT_UID: "1" }), (f, args) => { calls.push([f, ...args]); })!;
    a.ensure("b1");
    a.remove("b1");
    expect(calls).toEqual([["sudo", "-n", BOT_USER_HELPER, "ensure", "b1"], ["sudo", "-n", BOT_USER_HELPER, "remove", "b1"]]);
    const failing = sudoBotAccounts(loadConfig({ SYNAPSE_PER_BOT_UID: "1" }), () => { throw new Error("boom"); })!;
    expect(() => failing.ensure("b1")).not.toThrow();
  });
});
