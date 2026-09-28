import { describe, expect, it } from "vitest";
import { buildBotEnv } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { botUserName } from "../../walls/bot-uid";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";

/** Bug #66: the one env builder names the Bot's own account once the box is migrated, and keeps every pin. */
describe("bug #66: buildBotEnv and the Bot's OS account", () => {
  const on = loadConfig({ BOX_HOME: "/home/box", SYNAPSE_PER_BOT_UID: "1" });
  const off = loadConfig({ BOX_HOME: "/home/box" });

  it("migrated: the Bot's own HOME, CLAUDE_CONFIG_DIR and account, and a vault secret can't override them", () => {
    const u = botUserName(A);
    const env = buildBotEnv({ cfg: on, botId: A, asBot: A, secrets: { BOT_UNIX_USER_X: "v" } });
    expect(env).toMatchObject({ HOME: `/home/bots/${u}`, USER: u, CLAUDE_CONFIG_DIR: `/home/bots/${u}/.claude`, BOT_UNIX_USER: u, BOT_ACCOUNT_OF: A, BOT_ID: A });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // no Claude login ever (the API key is added per call, via the proxy)
    expect(env.GIT_CONFIG_COUNT).toBeDefined(); // Ruling 2's git neutralization is untouched
    expect(env.GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
  });

  it("a child's own id (e.g. <bot>-coding) still runs as the parent Bot's account", () => {
    const env = buildBotEnv({ cfg: on, botId: `${A}-coding`, asBot: A });
    expect(env.BOT_ID).toBe(`${A}-coding`);
    expect(env.BOT_UNIX_USER).toBe(botUserName(A));
    expect(env.BOT_ACCOUNT_OF).toBe(A);
  });

  it("host-internal calls (no asBot) and an unmigrated box stay on uid box, unchanged", () => {
    for (const env of [buildBotEnv({ cfg: on, botId: "reviewer" }), buildBotEnv({ cfg: off, botId: A, asBot: A })]) {
      expect(env.HOME).toBe("/home/box");
      expect(env.USER).toBe("box");
      expect(env.CLAUDE_CONFIG_DIR).toBe("/home/box/.claude");
      expect(env.BOT_UNIX_USER).toBeUndefined();
    }
  });
});
