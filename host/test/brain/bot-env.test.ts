import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp } from "../../app";
import { buildBotEnv } from "../../brain/spawn-options";
import { loadConfig } from "../../config";
import { log } from "../../util/log";
import { tmpConfig } from "../helpers";

/**
 * Security fix C1/I3/I4 (P2→P3 merge review, 06:45 rulings): ONE env builder for the CLI, child sessions,
 * background Shell and compaction. Secrets and display env go FIRST; the fixed keys (PATH, HOME, LANG,
 * USER, CLAUDE_CONFIG_DIR, BOT_ID, ENABLE_TOOL_SEARCH, and every
 * GIT_CONFIG_* pin) are written LAST, and secret names are re-validated at env time.
 */
const cfg = loadConfig({});
const PINS = { GIT_CONFIG_COUNT: "27", GIT_PAGER: "cat", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false" };

describe("buildBotEnv (C1, I4)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the fixed keys and the git pins after the secrets and display env", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const env = buildBotEnv({
      cfg, botId: "b1",
      display: { DISPLAY: ":3", BOT_CDP_PORT: "9225" },
      secrets: { PATH: "/evil", HOME: "/evil", GIT_CONFIG_COUNT: "0", GIT_CONFIG_KEY_0: "core.pager", BOT_ID: "other", ENABLE_TOOL_SEARCH: "false", STRIPE_KEY: "sk_test_1234" },
    });
    expect(env).toMatchObject({ PATH: `${cfg.ccManagedDir}/git-bin:/usr/local/bin:/usr/bin:/bin`, HOME: cfg.boxHome, USER: "box", LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: cfg.claudeConfigDir, BOT_ID: "b1", ENABLE_TOOL_SEARCH: "true", DISPLAY: ":3", BOT_CDP_PORT: "9225", STRIPE_KEY: "sk_test_1234", ...PINS });
    const keys = Object.keys(env);
    // Order matters for readers that apply "last wins": every fixed key comes after every secret.
    expect(keys.indexOf("STRIPE_KEY")).toBeLessThan(keys.indexOf("PATH"));
    expect(keys.indexOf("DISPLAY")).toBeLessThan(keys.indexOf("GIT_CONFIG_COUNT"));
  });

  it("no env ever contains a Claude login, even if a stale secret has that name", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const env = buildBotEnv({ cfg, botId: "b1", secrets: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stolen", API_KEY: "abcd1234" } });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-oat01-stolen");
    expect(env.API_KEY).toBe("abcd1234");
  });

  it("drops stale or invalid secret names at env time and logs them by NAME only (I3/I4)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const secrets = { GIT_CONFIG_COUNT: "val-gcc-9999", GIT_EXTERNAL_DIFF: "val-ged-9999", BASH_ENV: "val-be-9999", NODE_OPTIONS: "val-no-9999", https_proxy: "val-hp-9999", OK_NAME: "val-ok-9999" };
    const env = buildBotEnv({ cfg, botId: "b1", secrets });
    for (const n of ["GIT_EXTERNAL_DIFF", "BASH_ENV", "NODE_OPTIONS", "https_proxy"]) expect(env[n], n).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe("27"); // bug-log 121: 9 more fixed-name exec keys pinned
    expect(env.OK_NAME).toBe("val-ok-9999");
    const logged = JSON.stringify(warn.mock.calls);
    for (const n of ["GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF", "BASH_ENV", "NODE_OPTIONS", "https_proxy"]) expect(logged).toContain(n);
    expect(logged).not.toMatch(/val-/);
  });
});

describe("Shell env through the real Phase 3 wiring (C1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Shell `git status` in a repo whose .git/config sets core.fsmonitor never runs it", async () => {
    let hasGit = true;
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
    if (!hasGit) return;
    const c = tmpConfig({ FUZZ: "1" });
    const app = await createHostApp(c);
    try {
      const { id } = await app.handlers.createAgent!({ name: "Git" });
      const repo = path.join(c.workspace, "repo");
      fs.mkdirSync(repo);
      const genv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo };
      const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, env: genv, stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
      git("add", "a.txt");
      git("commit", "-qm", "c1");
      const marker = path.join(repo, "pwned-fsmonitor");
      git("config", "core.fsmonitor", `sh -c 'touch ${marker}'`);
      fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
      const shell = app.services.phase3.botTools(id).find((t) => t.name === "Shell")!;
      const r = await shell.handler({ command: "git status", working_directory: repo });
      expect(r.text).toMatch(/exit code 0/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await app.close();
      fs.rmSync(path.dirname(c.workspace), { recursive: true, force: true });
    }
  });

  it("the Shell env never carries the OAuth token and carries the git pins", async () => {
    const c = tmpConfig({ FUZZ: "1" });
    fs.mkdirSync(c.hostPrivate, { recursive: true });
    fs.writeFileSync(path.join(c.hostPrivate, "claude-oauth-token"), "sk-ant-oat01-shell-must-not-see"); // an old install's
    const app = await createHostApp(c);
    try {
      const { id } = await app.handlers.createAgent!({ name: "Env" });
      const env = app.services.phase3.spawnEnv(id);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env).toMatchObject(PINS);
      const shell = app.services.phase3.botTools(id).find((t) => t.name === "Shell")!;
      const r = await shell.handler({ command: 'echo "tok=${CLAUDE_CODE_OAUTH_TOKEN-unset} n=$GIT_CONFIG_COUNT"' });
      expect(r.text).toContain("tok=unset n=27");
    } finally {
      await app.close();
      fs.rmSync(path.dirname(c.workspace), { recursive: true, force: true });
    }
  });
});
