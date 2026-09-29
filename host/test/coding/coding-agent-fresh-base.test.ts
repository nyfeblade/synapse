import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config";
import { prepareWorktree, umaskGit } from "../../coding/coding-agents";
import { homeWorktreePrep, type RunAsBot } from "../../coding/home-worktree";
import { botUserName } from "../../walls/bot-uid";

/**
 * Code audit 2026-09-29 §2.1 and its pre-release review. A coding agent branches from the remote's default branch as
 * just fetched from origin (never `--all`), not whatever the clone had checked out. Unpushed commits on the local
 * default branch are kept. When the fetch fails (offline, a dead origin), it starts from what was last fetched and
 * says so. The user's own origin/HEAD is never rewritten. With no remote, the local default branch is the base.
 */
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function originRepo(): string {
  const r = tmp("origin-");
  git(r, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "README.md"), "v1\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "v1");
  return r;
}
function commit(r: string, text: string, file = "README.md"): string {
  fs.writeFileSync(path.join(r, file), `${text}\n`);
  git(r, "add", "-A");
  git(r, "commit", "-qm", text);
  return git(r, "rev-parse", "HEAD");
}

type Prep = (branch: string, agentId: string) => Promise<{ repoDir: string; worktree: string; note?: string | null }>;

/** The same behaviour on both paths: the shared /workspace/repos (host git) and the Bot's own ~/code (a script). */
const paths: [string, (src: string) => Prep][] = [
  ["/workspace/repos", (src) => {
    const ws = tmp("ws-");
    return (branch, agentId) => prepareWorktree({ git: umaskGit, workspace: ws, source: `file://${src}`, branch, agentId });
  }],
  ["~/code", (src) => {
    const ID = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
    const root = tmp("homes-");
    const cfg = loadConfig({ SYNAPSE_PER_BOT_UID: "1", BOT_HOMES: root, WORKSPACE: tmp("ws-") });
    const home = path.join(root, botUserName(ID));
    fs.mkdirSync(home, { mode: 0o700 });
    const run: RunAsBot = async (_b, script) => {
      try {
        const out = execFileSync("sh", ["-c", script], { cwd: home, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, output: out.toString() };
      } catch (e) {
        const x = e as { status?: number; stderr?: Buffer; stdout?: Buffer };
        return { code: x.status ?? 1, output: `${String(x.stdout ?? "")}${String(x.stderr ?? "")}` };
      }
    };
    const prep = homeWorktreePrep({ cfg, run });
    return async (branch, agentId) => (await prep(ID, { source: `file://${src}`, branch, agentId }))!;
  }],
];

for (const [where, make] of paths) {
  describe(`a coding agent's base (${where})`, () => {
    it("is the fetched origin default branch, not the clone's checked-out branch, and doesn't track it", async () => {
      const src = originRepo();
      const prep = make(src);
      const first = await prep("bots/one", "coding-1");
      git(first.repoDir, "checkout", "-q", "-b", "old-work", "HEAD");
      const fresh = commit(src, "v2");
      const second = await prep("bots/two", "coding-2");
      expect(git(second.worktree, "rev-parse", "HEAD")).toBe(fresh);
      expect(second.note ?? null).toBeNull();
      expect(() => git(second.worktree, "config", "--get", "branch.bots/two.remote")).toThrow();
    });

    it("follows a changed default branch on the remote without rewriting the clone's origin/HEAD", async () => {
      const src = originRepo();
      const prep = make(src);
      const first = await prep("bots/one", "coding-1");
      const before = git(first.repoDir, "symbolic-ref", "refs/remotes/origin/HEAD");
      git(src, "checkout", "-q", "-b", "trunk");
      const tip = commit(src, "on trunk");
      const second = await prep("bots/two", "coding-2");
      expect(git(second.worktree, "rev-parse", "HEAD")).toBe(tip);
      expect(git(first.repoDir, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(before);
    });

    it("keeps unpushed commits on the local default branch", async () => {
      const src = originRepo();
      const prep = make(src);
      const first = await prep("bots/one", "coding-1");
      const mine = commit(first.repoDir, "mine, not pushed", "local.txt");
      const second = await prep("bots/two", "coding-2");
      expect(git(second.worktree, "rev-parse", "HEAD")).toBe(mine);
    });

    it("offline (origin gone): starts from the last fetch and says so", async () => {
      const src = originRepo();
      const prep = make(src);
      const first = await prep("bots/one", "coding-1");
      const last = git(first.repoDir, "rev-parse", "refs/remotes/origin/main");
      fs.renameSync(src, `${src}-gone`);
      try {
        const second = await prep("bots/two", "coding-2");
        expect(git(second.worktree, "rev-parse", "HEAD")).toBe(last);
        expect(second.note).toMatch(new RegExp(`^Couldn't fetch the latest from origin; starting from ${last.slice(0, 7)}[0-9a-f]*, committed .+ ago\\.$`));
      } finally { fs.renameSync(`${src}-gone`, src); }
    });

    it("another dead remote doesn't matter: only origin is fetched", async () => {
      const src = originRepo();
      const prep = make(src);
      const first = await prep("bots/one", "coding-1");
      git(first.repoDir, "remote", "add", "dead", "file:///nonexistent/repo.git");
      const fresh = commit(src, "v2");
      const second = await prep("bots/two", "coding-2");
      expect(git(second.worktree, "rev-parse", "HEAD")).toBe(fresh);
      expect(second.note ?? null).toBeNull();
    });
  });
}

describe("a coding agent's base with no remote (/workspace/repos)", () => {
  it("is the local default branch", async () => {
    const src = originRepo();
    const ws = tmp("ws-");
    const first = await prepareWorktree({ git: umaskGit, workspace: ws, source: `file://${src}`, branch: "bots/one", agentId: "coding-1" });
    git(first.repoDir, "remote", "remove", "origin");
    const head = git(first.repoDir, "rev-parse", "HEAD");
    const second = await prepareWorktree({ git: umaskGit, workspace: ws, source: `file://${src}`, branch: "bots/two", agentId: "coding-2" });
    expect(git(second.worktree, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("an agent started without a fresh fetch says so", () => {
  it("on its view (the launch result and card) and in its own prompt", async () => {
    const { CodingAgents } = await import("../../coding/coding-agents");
    const { AsyncQueue } = await import("../../util/async-queue");
    const src = originRepo();
    const ws = tmp("ws-");
    const prompts: string[] = [];
    const agents = new CodingAgents({ workspace: ws, registryFile: path.join(ws, ".reg.json"), now: () => Date.now(), git: umaskGit, model: () => "m", onChange: () => {}, onDone: () => {},
      child: (o) => { prompts.push(o.prompt); const q = new AsyncQueue<{ type: string }>(); return { push: () => {}, interrupt: async () => {}, close: () => q.end(), messages: q }; } });
    const a = await agents.launch("b1", { repo: `file://${src}`, task: "Fix it" });
    expect(a.note ?? null).toBeNull();
    agents.cancel(a.id);
    fs.renameSync(src, `${src}-gone`);
    try {
      const b = await agents.launch("b1", { repo: `file://${src}`, task: "Fix it" });
      expect(b.note).toMatch(/^Couldn't fetch the latest from origin; starting from [0-9a-f]{7,}, committed /);
      expect(prompts.at(-1)).toContain(b.note!);
      agents.cancel(b.id);
    } finally { fs.renameSync(`${src}-gone`, src); }
  });
});
