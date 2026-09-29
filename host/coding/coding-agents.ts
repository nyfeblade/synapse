import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LIMITS5, STR5, type CodingAgentView } from "@synapse/shared";
import { buildBotEnv } from "../brain/spawn-options";
import type { ConformanceFlags } from "../brain/conformance/flags";
import type { TurnUsage } from "../brain/types";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { fillTemplate, loadPrompt } from "../prompts";
import { runUsageOf } from "../usage/metered-query";
import { slugify } from "../util/text";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export type Git = (args: string[], cwd?: string) => Promise<string>;

/** The root helper that runs git as user box (box/files/bot-git-as-box). */
export const GIT_AS_BOX = "/usr/local/libexec/bot-git-as-box";
/** C2: the fixed flags every coding-agent git call carries (a Bot-writable repo's hooks and fsmonitor never run). */
export const GIT_SAFE_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Bots", "-c", "user.email=bots@localhost"];

interface BoxGitOpts { cfg: HostConfig; runAs: ConformanceFlags["runAs"]; token?: string | null }

/** C2: the buildBotEnv minimal env (never the OAuth token, never the host's own env) + GIT_CONFIG_NOSYSTEM. */
export function gitEnv(o: BoxGitOpts): Record<string, string> {
  return { ...buildBotEnv({ cfg: o.cfg, botId: "coding-git" }), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * P5 review C2: how one coding-agent git call is executed. On the box (setpriv) it goes through the root
 * run-as-box helper via sudo, so bothost never runs git inside a Bot-writable repo; the helper receives the
 * env as NAME=VALUE argv (sudo resets the environment). Elsewhere (FUZZ, same-uid) git runs directly with
 * the same minimal env and flags.
 */
export function gitInvocation(o: BoxGitOpts, args: string[], cwd: string): { file: string; args: string[]; env: Record<string, string> } {
  const env = gitEnv(o);
  if (o.runAs === "setpriv") {
    return { file: "sudo", args: ["-n", GIT_AS_BOX, cwd, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "--", ...GIT_SAFE_FLAGS, ...args], env: { PATH: "/usr/bin:/bin" } };
  }
  return { file: "sh", args: ["-c", 'umask 002; exec git "$@"', "git", ...GIT_SAFE_FLAGS, ...args], env };
}

export function boxGit(o: BoxGitOpts): Git {
  return async (args, cwd) => {
    const dir = cwd ?? o.cfg.workspace;
    const inv = gitInvocation(o, args, dir);
    return (await promisify(execFile)(inv.file, inv.args, { cwd: o.runAs === "setpriv" ? "/" : dir, timeout: 300_000, env: inv.env })).stdout;
  };
}

/** Tests only: git with the same safe flags and minimal env, run as the current user. */
export const umaskGit: Git = async (args, cwd) =>
  (await promisify(execFile)("sh", ["-c", 'umask 002; exec git "$@"', "git", ...GIT_SAFE_FLAGS, ...args], { cwd, timeout: 300_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } })).stdout;

export function repoName(source: string): string {
  return path.basename(source.replace(/\/+$/, "")).replace(/\.git$/, "") || "repo";
}

export function cloneUrl(source: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return `https://github.com/${source}.git`;
  if (/^(https:\/\/|file:\/\/\/|git@)/.test(source)) return source;
  throw new GatewayError("BAD_ARGS", "repo must be a GitHub owner/repo, an https/ssh git URL, or a folder in /workspace/repos.");
}

/** Final box verification: the host runs as bothost (umask 022) but git runs as box, so every directory the host
 *  makes for git is group-writable (group bots via the setgid /workspace), never bothost-only 0755. */
function mkdirForBoxGit(dir: string): void {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (!first) {
    // one an older host left as bothost 0755: repair it (only our own; box's directories are box's business)
    const st = fs.statSync(dir);
    if (st.uid === process.getuid?.() && (st.mode & 0o070) !== 0o070) fs.chmodSync(dir, 0o2775);
    return;
  }
  for (let d = dir; ; d = path.dirname(d)) {
    fs.chmodSync(d, 0o2775);
    if (d === first) break;
  }
}

/** The line an agent's launch shows when origin couldn't be fetched. */
export const staleBaseNote = (shaAndAge: string) => `Couldn't fetch the latest from origin; starting from ${shaAndAge}.`;

/**
 * What a new agent branches from (code audit 2026-09-29 §2.1 and its review):
 *  - the remote's default branch, read with `ls-remote --symref` (so a renamed default is followed) without rewriting
 *    the clone's own origin/HEAD; after a failed fetch, or when that fails, the existing origin/HEAD;
 *  - the local default branch instead when it is AHEAD of origin's (unpushed commits are kept);
 *  - with no origin, or no such branch, the clone's HEAD.
 */
async function freshBase(git: Git, repo: string, fetched: boolean): Promise<string> {
  const ok = (args: string[]) => git(args, repo).then(() => true, () => false);
  if (!(await git(["remote"], repo)).split("\n").map((x) => x.trim()).includes("origin")) return "HEAD";
  let def = "";
  if (fetched) {
    const out = await git(["ls-remote", "--symref", "origin", "HEAD"], repo).catch(() => "");
    def = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1] ?? "";
  }
  if (!def) def = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo).catch(() => "")).trim().replace(/^refs\/remotes\/origin\//, "");
  const remote = `refs/remotes/origin/${def}`;
  if (!def || !(await ok(["rev-parse", "--verify", "--quiet", `${remote}^{commit}`]))) return "HEAD";
  const local = `refs/heads/${def}`;
  if (await ok(["rev-parse", "--verify", "--quiet", `${local}^{commit}`])) {
    const [l, r] = await Promise.all([git(["rev-parse", local], repo), git(["rev-parse", remote], repo)]);
    if (l.trim() !== r.trim() && (await ok(["merge-base", "--is-ancestor", remote, local]))) return local;
  }
  return remote;
}

export async function prepareWorktree(o: { git: Git; workspace: string; source: string; branch: string; agentId: string }): Promise<{ repoDir: string; worktree: string; note: string | null }> {
  const repos = path.join(o.workspace, "repos");
  mkdirForBoxGit(repos);
  const local = path.join(repos, repoName(o.source));
  let fetched = true;
  if (!fs.existsSync(path.join(local, ".git"))) await o.git(["clone", cloneUrl(o.source), local], repos);
  else if ((await o.git(["remote"], local)).split("\n").map((x) => x.trim()).includes("origin")) {
    // origin only (never --all: one dead remote failed every launch). Offline, the last fetch is used, and said.
    fetched = await o.git(["fetch", "--prune", "origin"], local).then(() => true, () => false);
  }
  await o.git(["config", "core.sharedRepository", "group"], local);
  const worktree = path.join(repos, `${repoName(o.source)}.worktrees`, o.agentId);
  mkdirForBoxGit(path.dirname(worktree));
  const base = await freshBase(o.git, local, fetched);
  const note = fetched ? null : staleBaseNote((await o.git(["log", "-1", "--format=%h, committed %cr", base], local)).trim());
  await o.git(["worktree", "add", "--no-track", "-b", o.branch, worktree, base], local);
  return { repoDir: local, worktree, note };
}

export interface CodingChild { push(text: string): void; interrupt(): Promise<void>; close(): void; messages: AsyncIterable<{ type: string; [k: string]: unknown }> }
export type ChildFactory = (o: { botId: string; cwd: string; model: string; prompt: string }) => CodingChild;

interface Live { child: CodingChild; timers: ReturnType<typeof setTimeout>[] }

export class CodingAgents {
  private agents = new Map<string, CodingAgentView>();
  private live = new Map<string, Live>();

  /** ladder: I13 — launches and replies run only when the usage ladder allows background work. onUsage: I13 — a finished
   *  agent's usage counts toward the Bot's spend (USE-06 helper rows). */
  /** prepare: bug 231 — the worktree in the Bot's own ~/code, made as the Bot (home-worktree.ts); null = no account of
   *  its own yet, so the shared /workspace/repos below. */
  constructor(private d: { workspace: string; registryFile: string; now(): number; git: Git; child: ChildFactory; model(botId: string): string; onChange(a: CodingAgentView): void; onDone(a: CodingAgentView): void; wallClockMs?: number; maxPerBot?: number; maxTotal?: number;
    ladder?(): { allowsBackground(kind: "coding"): boolean }; onUsage?(botId: string, model: string, u: TurnUsage): void;
    prepare?(botId: string, a: { source: string; branch: string; agentId: string }): Promise<{ repoDir: string; worktree: string; note?: string | null } | null> }) {
    for (const a of readJson<{ agents: CodingAgentView[] }>(d.registryFile, { agents: [] }).agents) this.agents.set(a.id, a);
  }

  list(botId: string): CodingAgentView[] { return [...this.agents.values()].filter((a) => a.botId === botId).sort((a, b) => b.startedAt - a.startedAt); }
  get(id: string): CodingAgentView | null { return this.agents.get(id) ?? null; }
  dumpPath(id: string): string { return path.join(this.d.workspace, "coding-agent-transcripts", `${id}.jsonl`); }

  private assertLadder(): void {
    if (this.d.ladder && !this.d.ladder().allowsBackground("coding")) throw new GatewayError("USAGE_HIGH", "Usage is high right now, so background coding agents are paused. Try again later.");
  }

  async launch(botId: string, a: { repo: string; task: string; title?: string }): Promise<CodingAgentView> {
    this.assertLadder();
    const running = [...this.agents.values()].filter((x) => x.status === "running");
    const perBot = this.d.maxPerBot ?? 4;
    if (running.filter((x) => x.botId === botId).length >= perBot) throw new GatewayError("CAP", `A Bot can run at most ${perBot} coding agents at once. Wait for one to finish.`);
    if (running.length >= (this.d.maxTotal ?? 12)) throw new GatewayError("CAP", "The limit of running coding agents is reached. Let one finish first.");
    const id = `coding-${randomUUID()}`;
    const title = (a.title?.trim() || a.task.trim().split("\n")[0]!).slice(0, 80);
    const branch = `bots/${slugify(title).slice(0, 40)}-${id.slice(7, 11)}`;
    // fix round 1, finding 2: reserve this Bot's slot in `this.agents` synchronously, before the
    // first `await`, so two launch() calls issued in the same tick (e.g. two tool_use blocks in one
    // assistant turn) can't both read the pre-launch running count above and both pass the cap check.
    const agent: CodingAgentView = { id, botId, title, repo: repoName(a.repo), branch, worktree: "", status: "running", startedAt: this.d.now(), endedAt: null, prUrl: null, summary: null };
    this.agents.set(id, agent);
    let worktree: string;
    let note: string | null | undefined;
    try {
      ({ worktree, note } = (await this.d.prepare?.(botId, { source: a.repo, branch, agentId: id }))
        ?? await prepareWorktree({ git: this.d.git, workspace: this.d.workspace, source: a.repo, branch, agentId: id }));
    } catch (e) {
      this.agents.delete(id);
      throw e;
    }
    agent.worktree = worktree;
    // Couldn't fetch: the launch result, the card and the agent itself all say what it started from.
    if (note) agent.note = note;
    this.save();
    const task = note ? `${a.task}\n\n(${note})` : a.task;
    const child = this.d.child({ botId, cwd: worktree, model: this.d.model(botId), prompt: fillTemplate(loadPrompt("orig/coding-agent.md"), { task }) });
    const wall = this.d.wallClockMs ?? LIMITS5.codingAgentWallClockMs;
    const timers = [
      setTimeout(() => child.push(STR5.steerTimeUp), Math.floor(wall * LIMITS5.steerAtFraction)),
      setTimeout(() => this.finish(id, "timed-out", "Stopped after the 5-hour limit."), wall),
    ];
    this.live.set(id, { child, timers });
    void this.pump(id, child);
    this.d.onChange(agent);
    return agent;
  }

  async reply(id: string, text: string, interrupt = true): Promise<void> {
    const l = this.live.get(id);
    if (!l) throw new GatewayError("NOT_RUNNING", "That coding agent isn't running.");
    this.assertLadder();
    if (interrupt) await l.child.interrupt();
    l.child.push(text);
  }

  cancel(id: string): void { this.finish(id, "cancelled", "Cancelled."); }

  remove(id: string): void {
    this.cancel(id);
    this.agents.delete(id);
    this.save();
  }

  /** I12: a deleted Bot's coding agents are cancelled and forgotten. */
  removeBot(botId: string): void {
    for (const a of [...this.agents.values()].filter((x) => x.botId === botId)) this.remove(a.id);
  }

  /** Host restart: running agents can't be resumed; mark them and let the caller revive their Bots. */
  markInterruptedAtBoot(): CodingAgentView[] {
    const hit = [...this.agents.values()].filter((a) => a.status === "running");
    for (const a of hit) Object.assign(a, { status: "error", endedAt: this.d.now(), summary: "Interrupted by a restart of the computer's host." });
    if (hit.length) this.save();
    return hit;
  }

  private async pump(id: string, child: CodingChild): Promise<void> {
    const file = this.dumpPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      for await (const m of child.messages) {
        fs.appendFileSync(file, `${JSON.stringify(m)}\n`, { mode: 0o664 });
        if (m.type === "result") {
          const agent = this.agents.get(id);
          const u = (m.usage ?? {}) as Record<string, number | undefined>;
          // total_cost_usd is a RUNNING total across this child's turns; the metered query has its own share.
          const own = runUsageOf(m);
          if (agent) this.d.onUsage?.(agent.botId, this.d.model(agent.botId), own ?? {
            inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            ...(typeof m.total_cost_usd === "number" ? { costUsd: m.total_cost_usd } : {}),
          });
          const summary = String(m.result ?? "").slice(0, 2000);
          this.finish(id, m.subtype === "success" ? "done" : "error", summary);
        }
      }
    } catch (e) {
      this.finish(id, "error", String((e as Error).message ?? e).slice(0, 500));
    }
  }

  private finish(id: string, status: CodingAgentView["status"], summary: string): void {
    const a = this.agents.get(id);
    const l = this.live.get(id);
    if (!a || a.status !== "running") return;
    if (l) { l.timers.forEach(clearTimeout); l.child.close(); this.live.delete(id); }
    Object.assign(a, { status, endedAt: this.d.now(), summary, prUrl: /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/.exec(summary)?.[0] ?? a.prUrl });
    this.save();
    this.d.onChange(a);
    this.d.onDone(a);
  }

  private save(): void {
    writeJsonAtomic(this.d.registryFile, { agents: [...this.agents.values()].slice(-200) }, 0o600);
  }
}
