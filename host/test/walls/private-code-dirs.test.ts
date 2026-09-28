import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { expandHome, resolveShellCwd, shellHome, terminalDirFor, terminalFileFor } from "../../background/shells";
import { benchRootScript, checkBenchRoot, repoOwnerScript } from "../../bench/coding/gateway-box";
import { loadConfig } from "../../config";
import { CodingAgents, type ChildFactory, umaskGit } from "../../coding/coding-agents";
import { homeWorktreePrep, homeWorktreeScript, shellRunAsBot, type RunAsBot } from "../../coding/home-worktree";
import { childSpawnCwd } from "../../coding/sdk-child";
import { loadPrompt } from "../../prompts/index";
import { renderBotPrompt } from "../../runner/prompt-collector";
import { AsyncQueue } from "../../util/async-queue";
import { botCodeDir, botLayoutPlan, botUserName } from "../../walls/bot-uid";
import { tmpConfig } from "../helpers";

/**
 * Bug 231: a Bot's code lives in its own ~/code (inside its 0700 home), not in the shared /workspace, which is
 * box:bots 2775 with umask 002: there any Bot can plant a git hook or an npm script another Bot then runs.
 */
const ID = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
const U = botUserName(ID);
const perBot = loadConfig({ SYNAPSE_PER_BOT_UID: "1" });
const legacy = loadConfig({});
const tmp: string[] = [];
const mkTmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmp.push(d); return d; };
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("bug 231: where a Bot's code lives", () => {
  it("~/code is the Bot's own folder: inside its home once it has an account, box's home before", () => {
    expect(botCodeDir(perBot, ID)).toBe(`/home/bots/${U}/code`);
    expect(botCodeDir(legacy, ID)).toBe("/home/box/code");
  });

  it("bot-user ensure makes ~/code, the Bot's own, 0700", () => {
    expect(botLayoutPlan(perBot, ID).find((e) => e.path === `/home/bots/${U}/code`)).toMatchObject({ type: "dir", owner: U, group: U, mode: 0o700 });
    expect(fs.readFileSync(path.resolve(__dirname, "../../../box/files/bot-user"), "utf8")).toMatch(/mkdir -p [^\n]*\bcode;[^\n]*chmod 0700 [^\n]*\bcode\b/);
  });
});

describe("bug 231: the prompts send code to ~/code and use /workspace for handing files over", () => {
  const profile = { name: "Piper", title: "", description: "", avatarShape: "pebble" as const, avatarColor: "#3472d9", avatarKind: "shape" as const };
  const text = renderBotPrompt({ profile, timeZone: "UTC", workspace: "/workspace", codeDir: `/home/bots/${U}/code`, teammates: [], sections: { memory: "", skills: "" } });

  it("names the Bot's own code folder, by its real path and as ~/code", () => {
    expect(text).toContain(`Code and repos go in your /home/bots/${U}/code/<project> (~/code).`);
    expect(text).toMatch(/\/workspace is shared: only for handing files to others; to work on a project there, clone or copy it into ~\/code first\./);
    expect(text).not.toMatch(/keep files there|Your working folder is/);
  });

  it("hands files to another Bot through /workspace or a git remote", () => {
    expect(text).toMatch(/Share files by path in \/workspace \(copy them there\) or a git remote/);
  });

  it("a subagent and the computer section no longer call /workspace where files live", () => {
    expect(loadPrompt("subagents/general-purpose.md")).toMatch(/code goes in ~\/code, yours alone; \/workspace is shared/);
    expect(loadPrompt("sections/computer.md")).not.toContain("Files live in /workspace");
    expect(loadPrompt("orig/reviewer.md")).toMatch(/outside \/workspace and the Bot's ~\/code/);
  });

  it("a real Bot's system prompt carries its own code folder", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const { id } = await app.handlers.createAgent!({ name: "Coder", isKickstartRequested: false });
    expect(app.services.runner.systemAppend(id)).toContain(`your ${botCodeDir(cfg, id)}/<project> (~/code)`);
  });
});

describe("bug 231: the Shell reads ~ as the Bot's home", () => {
  it("expands ~ and ~/… in working_directory, and nothing else", () => {
    expect(expandHome("~/code/app", "/home/bots/x")).toBe("/home/bots/x/code/app");
    expect(expandHome("~", "/home/bots/x")).toBe("/home/bots/x");
    expect(expandHome("~other/x", "/home/bots/x")).toBe("~other/x");
    expect(expandHome("app/~/x", "/home/bots/x")).toBe("app/~/x");
    expect(resolveShellCwd("/workspace", "~/code/app", null, "/home/bots/x")).toBe("/home/bots/x/code/app");
    expect(resolveShellCwd("/workspace", "app", null, "/home/bots/x")).toBe("/workspace/app");
    expect(shellHome(perBot, ID)).toBe(`/home/bots/${U}`);
    expect(shellHome(legacy, ID)).toBe("/home/box");
  });
});

describe("bug 231: a coding agent works in the Bot's own ~/code", () => {
  function originRepo(): string {
    const r = mkTmp("origin-");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: r });
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(r, "README.md"), "hi\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    return r;
  }
  /** Stands in for bot-shell: the script runs with HOME = the Bot's home, as the Bot's unit would. */
  const localRun = (home: string, seen: string[]): RunAsBot => async (_botId, script) => {
    seen.push(script);
    try {
      const out = execFileSync("sh", ["-c", script], { cwd: home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, output: out.toString() };
    } catch (e) {
      const x = e as { status?: number; stderr?: Buffer };
      return { code: x.status ?? 1, output: String(x.stderr ?? "") };
    }
  };

  it("the child's cwd is ~/code/<repo>.worktrees/<agent id>, made by the Bot, with ~/code 0700", async () => {
    const root = mkTmp("homes-");
    const cfg = loadConfig({ SYNAPSE_PER_BOT_UID: "1", BOT_HOMES: root, WORKSPACE: mkTmp("ws-") });
    const home = path.join(root, U);
    fs.mkdirSync(home, { mode: 0o700 });
    const seen: string[] = [];
    const cwds: string[] = [];
    const child: ChildFactory = (o) => { cwds.push(o.cwd); const q = new AsyncQueue<{ type: string }>(); return { push: () => {}, interrupt: async () => {}, close: () => q.end(), messages: q }; };
    const agents = new CodingAgents({ workspace: cfg.workspace, registryFile: path.join(cfg.workspace, ".reg.json"), now: () => Date.now(), git: umaskGit, child, model: () => "m",
      onChange: () => {}, onDone: () => {}, prepare: homeWorktreePrep({ cfg, run: localRun(home, seen) }) });
    const src = originRepo();
    const a = await agents.launch(ID, { repo: `file://${src}`, task: "Fix it", title: "Fix" });
    const name = path.basename(src);
    expect(a.worktree).toBe(path.join(home, "code", `${name}.worktrees`, a.id));
    expect(cwds).toEqual([a.worktree]);
    expect(execFileSync("git", ["-C", a.worktree, "branch", "--show-current"]).toString().trim()).toBe(a.branch);
    expect((fs.statSync(path.join(home, "code")).mode & 0o777).toString(8)).toBe("700");
    expect(fs.existsSync(path.join(cfg.workspace, "repos")), "nothing in the shared /workspace").toBe(false);
    // hooks and fsmonitor never run in the clone, whoever made the source
    expect(seen[0]).toContain("'core.hooksPath=/dev/null'");
    agents.cancel(a.id);
  });

  it("a Bot with no account of its own keeps the shared /workspace/repos", async () => {
    const prep = homeWorktreePrep({ cfg: legacy, run: async () => { throw new Error("must not run"); } });
    expect(await prep(ID, { source: "o/r", branch: "b", agentId: "coding-x" })).toBeNull();
  });

  it("refuses a repo name that isn't one plain folder", async () => {
    const prep = homeWorktreePrep({ cfg: perBot, run: async () => ({ code: 0, output: "" }) });
    await expect(prep(ID, { source: "https://example.com/..", branch: "b", agentId: "coding-x" })).rejects.toThrow(/folder name/);
    await expect(prep(ID, { source: "https://example.com/-x", branch: "b", agentId: "coding-x" })).rejects.toThrow(/folder name/);
  });

  it("quotes every value it puts in the script", () => {
    const s = homeWorktreeScript({ codeDir: "/home/bots/x/code", source: "https://example.com/a'b/r.git", names: ["r", "a'b-r"], branch: "bots/fix-1", agentId: "coding-1" });
    expect(s).toContain("url='https://example.com/a'\\''b/r.git'");
    expect(s).toContain("for n in 'r' 'a'\\''b-r'; do");
    expect(s).toContain("worktree add -b 'bots/fix-1' '/home/bots/x/code'/\"$pick.worktrees\"/'coding-1'");
  });

  it("round 1, item 6: reuses ~/code/<name> only when its origin is the same URL, else takes the next name", async () => {
    const root = mkTmp("homes-");
    const cfg = loadConfig({ SYNAPSE_PER_BOT_UID: "1", BOT_HOMES: root, WORKSPACE: mkTmp("ws-") });
    const home = path.join(root, U);
    fs.mkdirSync(home, { mode: 0o700 });
    const prep = homeWorktreePrep({ cfg, run: localRun(home, []) });
    const one = originRepo(), other = originRepo();
    // An unrelated repo already sits at ~/code/<name of `one`>, as a same-named project the Bot made itself.
    const name = path.basename(one);
    fs.mkdirSync(path.join(home, "code"), { mode: 0o700 });
    execFileSync("git", ["clone", "-q", `file://${other}`, path.join(home, "code", name)]);
    const a = await prep(ID, { source: `file://${one}`, branch: "b1", agentId: "coding-1" });
    expect(a!.repoDir).not.toBe(path.join(home, "code", name));
    expect(path.basename(a!.repoDir)).toBe(`${path.basename(path.dirname(one))}-${name}`);
    expect(execFileSync("git", ["-C", a!.repoDir, "config", "--get", "remote.origin.url"]).toString().trim()).toBe(`file://${one}`);
    // The same source again reuses its own clone (a fetch, not a second clone).
    const b = await prep(ID, { source: `file://${one}`, branch: "b2", agentId: "coding-2" });
    expect(b!.repoDir).toBe(a!.repoDir);
    // And the unrelated repo's own origin gets its own folder back.
    const c = await prep(ID, { source: `file://${other}`, branch: "b3", agentId: "coding-3" });
    expect(c!.repoDir).toBe(path.join(home, "code", path.basename(other)));
  });

  it("on the box the setup runs as the Bot's own account, in its home, through bot-shell", async () => {
    const cfg = loadConfig({ SYNAPSE_PER_BOT_UID: "1", WORKSPACE: mkTmp("ws-"), HOST_PRIVATE: mkTmp("host-") });
    const starts: unknown[][] = [];
    const spawner = {
      async start(id: string, cwd: string, account?: string, botId?: string) {
        starts.push([id, cwd, account, botId]);
        const script = fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.sh`), "utf8");
        expect(fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.env`), "utf8")).toContain(`BOT_UNIX_USER="${U}"`);
        const out = execFileSync("sh", ["-c", script]).toString();
        fs.appendFileSync(terminalFileFor(cfg, ID, id), `${out}\n---\nexit_code: 0\nelapsed_ms: 1\nended_at: 1\ncwd: /\n---\n`);
      },
      async stop() {}, async status() { return "stopped" as const; },
    };
    const r = await shellRunAsBot({ cfg, spawner, pollMs: 5 })(ID, "echo made-it", 5_000);
    expect(r.code).toBe(0);
    expect(r.output).toContain("made-it");
    expect(starts).toEqual([[expect.stringMatching(/^shell-git-[0-9a-f]{12}$/), `/home/bots/${U}`, U, ID]]);
    expect(fs.readdirSync(path.join(cfg.hostPrivate, "run")), "script and env removed").toEqual([]);
    expect(fs.readdirSync(terminalDirFor(cfg, ID)), "transcript removed").toEqual([]);
  });

  it("on the box the helper enters the worktree after dropping to the Bot's uid (bothost can't enter the 0700 home)", () => {
    const wt = `/home/bots/${U}/code/r.worktrees/coding-1`;
    expect(childSpawnCwd(perBot, "setpriv", ID, wt)).toEqual({ cwd: "/workspace", env: { BOT_CWD: wt } });
    expect(childSpawnCwd(perBot, "setpriv", ID, "/workspace/repos/r.worktrees/c")).toEqual({ cwd: "/workspace/repos/r.worktrees/c", env: {} });
    expect(childSpawnCwd(perBot, "same-uid", ID, wt)).toEqual({ cwd: wt, env: {} });
  });
});

describe("bug 231: the coding bench runs in the bench Bot's ~/code", () => {
  it("puts the repo in the Bot's ~/code when it has an account, else /workspace, and checks the answer", () => {
    const s = benchRootScript("abcd1234", ID);
    expect(s).toContain(`getent passwd '${U}'`);
    expect(s).toContain(`install -d -o '${U}' -g '${U}' -m 700 "$home/code"`);
    expect(s).toContain('echo "$home/code/bench-abcd1234"; else echo \'/workspace/bench-abcd1234\'');
    expect(checkBenchRoot(`/home/bots/${U}/code/bench-abcd1234\n`, "abcd1234")).toBe(`/home/bots/${U}/code/bench-abcd1234`);
    expect(checkBenchRoot("/workspace/bench-abcd1234", "abcd1234")).toBe("/workspace/bench-abcd1234");
    for (const bad of ["/", "/home/bots", `/home/bots/${U}`, `/home/bots/${U}/code/bench-zzzz9999`, "/etc/bench-abcd1234"]) {
      expect(() => checkBenchRoot(bad, "abcd1234"), bad).toThrow(/unexpected bench root/);
    }
  });

  it("in ~/code the repo's group is the Bot's private one (the fast path refuses a group-writable shared group)", () => {
    expect(repoOwnerScript(`/home/bots/${U}/code/bench-abcd1234`, ID)).toBe(`chown -R '${U}:${U}' '/home/bots/${U}/code/bench-abcd1234'`);
    expect(repoOwnerScript("/workspace/bench-abcd1234", ID)).toContain('"$owner":bots');
  });
});
