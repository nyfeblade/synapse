import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { botUserName } from "../../walls/bot-uid";
import { buildMigrationPlan, planToTsv, readPlanBots, relocateSessionRecords } from "../../walls/migration-plan";
import { tmpConfig } from "../helpers";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const S1 = "11111111-2222-4333-8444-555555555555";
const S2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const cfg = { claudeConfigDir: "/home/box/.claude", boxHome: "/home/box", botHomes: "/home/bots" };
const L = "/home/box/.claude/projects/-workspace";

describe("bug #66: the per-Bot-uid migration plan", () => {
  it("one account per Bot (none for a group), its recorded sessions and their folders, and its screen's profile", () => {
    const u = botUserName(A);
    const steps = buildMigrationPlan(cfg, [
      { id: A, group: false, sessionFiles: [`${L}/${S1}.jsonl`, `${L}/${S2}.jsonl`, `${L}/${S1}.jsonl`], display: 3 },
      { id: "gggggggg-0000-4000-8000-000000000000", group: true, sessionFiles: [], display: null },
    ]);
    const mine = `/home/bots/${u}/.claude/projects/-workspace`;
    expect(steps).toEqual([
      { op: "account", botId: A, account: u },
      { op: "move", what: "session", botId: A, account: u, from: `${L}/${S1}.jsonl`, to: `${mine}/${S1}.jsonl` },
      { op: "move", what: "session-dir", botId: A, account: u, from: `${L}/${S1}`, to: `${mine}/${S1}` },
      { op: "move", what: "session", botId: A, account: u, from: `${L}/${S2}.jsonl`, to: `${mine}/${S2}.jsonl` },
      { op: "move", what: "session-dir", botId: A, account: u, from: `${L}/${S2}`, to: `${mine}/${S2}` },
      { op: "move", what: "chrome-profile", botId: A, account: u, from: "/home/box/.chrome-screens/3", to: `/home/bots/${u}/chrome-profile` },
    ]);
  });

  it("never plans a path outside the two session roots, a traversal, or a file that isn't a session", () => {
    const steps = buildMigrationPlan(cfg, [{ id: A, group: false, display: 1, sessionFiles: [
      "/etc/shadow", `${L}/../../../../etc/${S1}.jsonl`, `${L}/notes.txt`, `/home/box/.claude/projects/${S1}.jsonl`, `${L}/x/${S1}.jsonl`,
    ] }]);
    expect(steps.filter((s) => s.op === "move")).toEqual([]); // display 1 is box's own screen, never a Bot's
  });

  it("is idempotent across a partial run: a record already pointing into the Bot's tree plans the same move", () => {
    const u = botUserName(A);
    const a = buildMigrationPlan(cfg, [{ id: A, group: false, display: null, sessionFiles: [`${L}/${S1}.jsonl`] }]);
    const b = buildMigrationPlan(cfg, [{ id: A, group: false, display: null, sessionFiles: [`/home/bots/${u}/.claude/projects/-workspace/${S1}.jsonl`] }]);
    expect(b).toEqual(a);
    expect(planToTsv(a).split("\n")[1]).toBe(["move", "session", A, u, `${L}/${S1}.jsonl`, `/home/bots/${u}/.claude/projects/-workspace/${S1}.jsonl`].join("\t"));
  });

  it("reads each Bot's recorded sessions and screen from the stores (what the script is handed)", () => {
    const c = tmpConfig();
    initLayout(c);
    const bots = new BotService({ cfg: c, hub: new SseHub(), settings: new HostSettingsStore(path.join(c.dataRoot, "settings.json")) });
    bots.loadAll();
    const id = bots.create({ name: "Ada", origin: "user", kickstart: false });
    bots.setSessionId(id, S1);
    const legacy = path.join(c.claudeConfigDir, "projects", c.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
    bots.setBrainKv(id, "childSessionFiles", [{ file: `${legacy}/${S2}.jsonl` }]);
    fs.writeFileSync(path.join(c.hostPrivate, "window-assignments.json"), JSON.stringify({ assignments: { [id]: 4 }, tokens: {} }));
    const got = readPlanBots({ ...c, perBotUid: true });
    expect(got).toEqual([{ id, group: false, sessionFiles: [`${legacy}/${S1}.jsonl`, `${legacy}/${S2}.jsonl`], display: 4 }]);
  });

  it("host start points recorded session paths at the tree the Bot runs in, both ways, idempotently", () => {
    const c = { ...tmpConfig(), botHomes: "/home/bots" };
    initLayout(c);
    const mk = (perBotUid: boolean) => { const b = new BotService({ cfg: { ...c, perBotUid }, hub: new SseHub(), settings: new HostSettingsStore(path.join(c.dataRoot, "settings.json")) }); b.loadAll(); return b; };
    const off = mk(false);
    const id = off.create({ name: "Ada", origin: "user", kickstart: false });
    const legacyFile = path.join(c.claudeConfigDir, "projects", "-workspace", `${S1}.jsonl`);
    off.setBrainKv(id, "rolledSessionFiles", [{ id: S1, file: legacyFile, rolledAt: 1 }]);
    const on = mk(true);
    const mineFile = `/home/bots/${botUserName(id)}/.claude/projects/-workspace/${S1}.jsonl`;
    expect(relocateSessionRecords({ ...c, perBotUid: true }, on)).toBe(1);
    expect(on.brainKv(id, "rolledSessionFiles", [])).toEqual([{ id: S1, file: mineFile, rolledAt: 1 }]);
    expect(relocateSessionRecords({ ...c, perBotUid: true }, on)).toBe(0);
    const back = mk(false);
    expect(relocateSessionRecords({ ...c, perBotUid: false }, back)).toBe(1); // the rollback
    expect(back.brainKv(id, "rolledSessionFiles", [])).toEqual([{ id: S1, file: legacyFile, rolledAt: 1 }]);
  });
});
