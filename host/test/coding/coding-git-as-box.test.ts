import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { boxGit, gitInvocation, prepareWorktree } from "../../coding/coding-agents";
import { loadConfig } from "../../config";

// P5 review C2: ALL git for coding agents runs as user box with the buildBotEnv minimal env,
// `-c core.hooksPath=/dev/null -c core.fsmonitor=false` and GIT_CONFIG_NOSYSTEM=1; bothost never runs git in a Bot-writable repo.
describe("coding agent git runs as box with a minimal env (C2)", () => {
  const cfg = { ...loadConfig({ BOX_HOME: "/home/box" }), workspace: "/workspace" };

  it("on the box (setpriv) every git call goes through the root run-as-box helper via sudo", () => {
    process.env.C2_LEAK_CHECK = "secret-host-env";
    const inv = gitInvocation({ cfg, runAs: "setpriv", token: "tok-should-not-leak" }, ["fetch", "--all"], "/workspace/repos/app");
    expect(inv.file).toBe("sudo");
    expect(inv.args.slice(0, 3)).toEqual(["-n", "/usr/local/libexec/bot-git-as-box", "/workspace/repos/app"]);
    const sep = inv.args.indexOf("--");
    const envPairs = inv.args.slice(3, sep);
    const gitArgs = inv.args.slice(sep + 1);
    expect(gitArgs.slice(0, 4)).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
    expect(gitArgs.slice(-2)).toEqual(["fetch", "--all"]);
    expect(envPairs).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(envPairs).toContain("HOME=/home/box");
    expect(envPairs).toContain("USER=box");
    expect(envPairs.join("\n")).not.toContain("tok-should-not-leak");
    expect(envPairs.join("\n")).not.toContain("secret-host-env");
    expect(envPairs.some((p) => p.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))).toBe(false);
  });

  it("the helper script exists, is bash-valid, and drops to box with hooks and fsmonitor off", () => {
    const f = path.resolve(__dirname, "../../../box/files/bot-git-as-box");
    const src = fs.readFileSync(f, "utf8");
    expect(src).toContain('[ "${SUDO_USER:-}" = "bothost" ]');
    expect(src).toMatch(/setpriv --reuid=box --regid=box/);
    expect(src).toContain("core.hooksPath=/dev/null");
    expect(src).toContain("core.fsmonitor=false");
    expect(src).toContain("GIT_CONFIG_NOSYSTEM=1");
    execFileSync("bash", ["-n", f]);
    const sudoers = fs.readFileSync(path.resolve(__dirname, "../../../box/files/sudoers-bothost"), "utf8");
    expect(sudoers).toContain("/usr/local/libexec/bot-git-as-box *");
    expect(fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8")).toContain("bot-git-as-box");
  });

  it("locally (FUZZ/same-uid) a repo's hooks and fsmonitor never run, and the host env is not inherited", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "c2-home-"));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "c2-ws-"));
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), "c2-origin-"));
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: origin });
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "README.md"), "hi\n");
    g("add", "-A"); g("commit", "-qm", "init");
    const git = boxGit({ cfg: { ...cfg, boxHome: home, workspace: ws }, runAs: "same-uid" as never, token: null });
    await prepareWorktree({ git, workspace: ws, source: `file://${origin}`, branch: "bots/a", agentId: "coding-1" });
    // A Bot plants a hook and an fsmonitor in the (Bot-writable) clone; the next launch must not run them.
    const local = path.join(ws, "repos", path.basename(origin));
    const marker = path.join(home, "pwned");
    const hook = path.join(local, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hook), { recursive: true }); // the Bot env pins init.templateDir="" (bug-log 121): no sample hooks dir
    fs.writeFileSync(hook, `#!/bin/sh\necho hook >> ${marker}\n`, { mode: 0o755 });
    const fsm = path.join(local, "fsm.sh");
    fs.writeFileSync(fsm, `#!/bin/sh\necho fsmonitor >> ${marker}\nenv >> ${marker}.env\n`, { mode: 0o755 });
    execFileSync("git", ["config", "core.fsmonitor", fsm], { cwd: local });
    process.env.C2_LEAK_CHECK = "secret-host-env";
    await prepareWorktree({ git, workspace: ws, source: `file://${origin}`, branch: "bots/b", agentId: "coding-2" });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(ws, "repos", `${path.basename(origin)}.worktrees`, "coding-2", "README.md"))).toBe(true);
  });

  it("final box verification: directories the host (bothost, umask 022) makes for box's git are group-writable", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "c2-perm-"));
    fs.mkdirSync(path.join(ws, "repos", "p5demo", ".git"), { recursive: true }); // an existing local repo
    const old = process.umask(0o022);
    try {
      const calls: string[][] = [];
      await prepareWorktree({ git: async (args) => { calls.push(args); return ""; }, workspace: ws, source: "p5demo", branch: "bots/x", agentId: "coding-9" });
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "c2-perm2-"));
      await prepareWorktree({ git: async () => "", workspace: ws2, source: "owner/repo", branch: "bots/y", agentId: "coding-10" });
      expect(calls.at(-1)).toEqual(["worktree", "add", "--no-track", "-b", "bots/x", path.join(ws, "repos", "p5demo.worktrees", "coding-9"), "HEAD"]);
      for (const d of [path.join(ws2, "repos"), path.join(ws, "repos", "p5demo.worktrees"), path.join(ws2, "repos", "repo.worktrees")]) {
        if (fs.existsSync(d)) expect((fs.statSync(d).mode & 0o070).toString(8), d).toBe("70");
      }
    } finally { process.umask(old); }
  });

  it("a host-owned 0755 <repo>.worktrees left by an older host is repaired to group-writable", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "c2-perm3-"));
    fs.mkdirSync(path.join(ws, "repos", "p5demo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(ws, "repos", "p5demo.worktrees"), { mode: 0o755 });
    fs.chmodSync(path.join(ws, "repos", "p5demo.worktrees"), 0o755);
    await prepareWorktree({ git: async () => "", workspace: ws, source: "p5demo", branch: "bots/z", agentId: "coding-11" });
    expect((fs.statSync(path.join(ws, "repos", "p5demo.worktrees")).mode & 0o070).toString(8)).toBe("70");
  });
});

