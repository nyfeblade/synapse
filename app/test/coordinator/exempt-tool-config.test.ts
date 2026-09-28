/**
 * exempt-tool-config (bug 237): a pinned tool that runs unwrapped reads config a sandboxed Bot could write — hooks in
 * ~/.claude/settings.json or a project's .claude/settings.json, ~/.codex/config.toml, git's core.fsmonitor / hooks via
 * ~/.gitconfig, ~/.config/git or .git/config.
 *  1. The sandbox and the fixed rules (app-side write/edit too) deny writes to ~/.claude/settings(.local).json,
 *     ~/.claude/hooks, ~/.codex/**, ~/.gitconfig and ~/.config/git/**; the user's own edit goes through a card whose
 *     approval runs it unwrapped for that call.
 *  2. Unwrapped runs get GIT_CONFIG_COUNT/KEY/VALUE (core.fsmonitor=false, core.hooksPath=/dev/null, core.sshCommand=)
 *     and GIT_CONFIG_NOSYSTEM=1. (Bug 239: claude and codex no longer run unwrapped at all; they run in the sandbox.)
 * HOME is a temp dir; PATH is narrowed so only the temp home's fake `claude` resolves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, localBindTarget, macSafeGitConfigSet, macSandboxExemptSimple, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor, UNWRAPPED_GIT_ENV, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "etc-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"));
  fs.mkdirSync(path.join(home, ".config", "git"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  const v1 = path.join(home, ".local", "share", "claude", "versions", "1.0");
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(v1, "claude"), "#!/bin/sh\necho \"ARGS:$*\"\nenv | grep '^GIT_CONFIG' | sort\n", { mode: 0o755 });
  fs.symlinkSync(path.join(v1, "claude"), path.join(home, ".local", "bin", "claude"));
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = FIXED_PATH;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
async function sh(command: string, approvalId: string | null = null): Promise<string> {
  const chunks: string[] = [];
  await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return chunks.join("");
}
const CONFIGS = () => [
  path.join(home, ".claude", "settings.json"), path.join(home, ".claude", "settings.local.json"), path.join(home, ".claude", "hooks", "pre.sh"),
  path.join(home, ".codex", "config.toml"), path.join(home, ".gitconfig"), path.join(home, ".config", "git", "config"),
];

describe("1. the profile and the hand-off rule", () => {
  it("the profile denies writes to each", () => {
    const p = ownDataSandboxProfile(userData, home);
    for (const f of [".claude/settings.json", ".claude/settings.local.json", ".gitconfig"]) expect(p).toContain(`(literal "${home}/${f}")`);
    for (const d of [".claude/hooks", ".codex", ".config/git"]) expect(p).toContain(`(subpath "${home}/${d}")`);
  });
  it.each([
    `echo '{"hooks":{}}' > ~/.claude/settings.json`, "cp evil.toml ~/.codex/config.toml", "tee -a ~/.gitconfig < x", "echo x > ~/.config/git/config",
    `python3 -c "open('/x/.claude/settings.json','w').write('{}')"`, "git config --global core.fsmonitor /tmp/evil", "git config --global --add core.hooksPath /tmp/h",
  ])("a write asks: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull());
  it.each(["git config --global --get user.name", "git config --list", "cat ~/.gitconfig", "git config user.name x"])(
    "not a hand-off: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).toBeNull());
  // Bug 151's decision stands: an ordinary global setting is not a card; it runs unwrapped (the sandbox denies ~/.gitconfig).
  it.each(["git config --global user.email me@example.com", `git config --global user.name "Ada Lovelace"`, "git config --global init.defaultBranch main"])(
    "an ordinary global setting is quiet and runs unwrapped: %s", (cmd) => { expect(macUnsandboxedHandoff(cmd, { home })).toBeNull(); expect(macSafeGitConfigSet(cmd)).toBe(true); });
  it.each(["git config --global alias.st '!sh evil.sh'", "git config --global credential.helper '!evil'", "git config --global include.path /tmp/x", "git config --global core.pager evil", "git config --global user.email x && ./evil"])(
    "anything else is not the quiet path: %s", (cmd) => expect(macSafeGitConfigSet(cmd)).toBe(false));
});

describe.runIf(process.platform === "darwin")("1. live (temp HOME)", () => {
  it("under the wrapper, python can't write any of them (direct or by rename)", async () => {
    for (const f of CONFIGS()) {
      await sh(`python3 -c "open('${f}','w').write('PLANTED')" 2>&1; python3 -c "import os; open('${home}/t.x','w').write('PLANTED'); os.replace('${home}/t.x','${f}')" 2>&1`);
      expect(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "", f).not.toContain("PLANTED");
    }
  });

  it("an ordinary `git config --global user.email` still works (unwrapped, no card); a hooks key under the wrapper doesn't", async () => {
    await sh("git config --global user.email me@example.com");
    expect(fs.readFileSync(path.join(home, ".gitconfig"), "utf8")).toContain("me@example.com");
    await sh("git config --global core.hooksPath /tmp/evil 2>&1");
    expect(fs.readFileSync(path.join(home, ".gitconfig"), "utf8")).not.toContain("hooksPath");
  });

  it("an approved settings edit runs unwrapped for that call; without approval it is denied", async () => {
    const f = path.join(home, ".claude", "settings.json");
    const cmd = `echo '{"theme":"dark"}' > ${f}`;
    await sh(cmd);
    expect(fs.readFileSync(f, "utf8")).toBe("{}\n");
    await sh(cmd, "approved");
    expect(fs.readFileSync(f, "utf8")).toContain("dark");
  });
});

describe("1. app-side write-file / edit-file", () => {
  const store = () => {
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 6), { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    for (const a of ["write-file", "edit-file"] as const) p.grant("b1", a);
    p.setBotMode("b1", "full-auto");
    return p;
  };
  it("needs a card in every mode (Full auto and grants included)", () => {
    const p = store();
    for (const f of CONFIGS()) for (const op of ["write-file", "edit-file"] as const) {
      const v = p.check({ execId: "x", botId: "b1", approvalId: null, op, path: f, content: "{}", oldString: "a", newString: "b" });
      expect(v.ok, `${op} ${f}`).toBe(false);
      expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL), `${op} ${f}`).toBe(true);
    }
  });
  it("the card's approval lets that one write through", () => {
    const p = store();
    const r = { execId: "x", botId: "b1", approvalId: "a1", op: "write-file" as const, path: path.join(home, ".claude", "settings.json"), content: "{}" };
    p.recordApproval("a1", { botId: "b1", expiresAt: Date.now() + 60_000, bind: bindHash("write-file", localBindTarget(r)) });
    expect(p.check(r).ok).toBe(true);
    expect(p.check(r).ok).toBe(false);
  });
});

describe("2. the unwrapped run itself", () => {
  it("the git env is fixed and deliberate", () => {
    expect(UNWRAPPED_GIT_ENV).toEqual({
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "core.sshCommand", GIT_CONFIG_VALUE_2: "",
    });
  });

  // Bug 239: claude is no longer exempt (it runs in the sandbox), so the unwrapped git env is shown on `swift`.
  it.runIf(process.platform === "darwin")("an exempt one-shot (`swift build`) gets the git env", async () => {
    const tbin = path.join(home, "tbin"); // ahead of /usr/bin, so the real swift is never run
    fs.mkdirSync(tbin);
    fs.writeFileSync(path.join(tbin, "swift"), "#!/bin/sh\necho \"ARGS:$*\"\nenv | grep '^GIT_CONFIG' | sort\n", { mode: 0o755 });
    process.env.PATH = `${tbin}:${FIXED_PATH}`;
    const out = await sh("swift build");
    expect(out).toContain("ARGS:build");
    for (const [k, v] of Object.entries(UNWRAPPED_GIT_ENV)) expect(out).toContain(`${k}=${v}\n`);
  });

  it.runIf(process.platform === "darwin")("an approved hand-off gets the git env too", async () => {
    // A hand-off that touches only the temp HOME (a tool-config write), never the user's real system state.
    const cmd = `echo '{}' > '${home}/.claude/settings.local.json'; env | grep '^GIT_CONFIG_KEY_1'`;
    expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull();
    const out = await sh(cmd, "approved");
    expect(fs.readFileSync(path.join(home, ".claude", "settings.local.json"), "utf8").trim()).toBe("{}");
    expect(out).toContain("GIT_CONFIG_KEY_1=core.hooksPath");
  });

  it.each(["claude -p hi -- --setting-sources project", "npx @anthropic-ai/claude-code -p hi", "bunx claude -p hi"])(
    "claude never runs unwrapped (bug 239): %s", (cmd) => expect(macSandboxExemptSimple(cmd)).toBeNull());
});
