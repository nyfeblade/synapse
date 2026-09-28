import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildBotEnv } from "../brain/spawn-options";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { ShellSpawner } from "../background/shell-spawner";
import { createTerminalFile, envFileText, parseTerminal, terminalDirFor, terminalFileFor } from "../background/shells";
import { botCodeDir, botOsUser } from "../walls/bot-uid";
import { cloneUrl, GIT_SAFE_FLAGS, repoName } from "./coding-agents";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs a script as the Bot's own OS account, in its home, and returns its exit code and output. */
export type RunAsBot = (botId: string, script: string, timeoutMs: number) => Promise<{ code: number; output: string }>;

/**
 * Bug 231: the git steps of a coding agent's worktree, run AS THE BOT in its own ~/code (0700, inside its 0700 home), so
 * no other Bot can plant hooks or npm scripts in the tree the agent then works in. The same fixed flags as the host's git.
 * Round 1: an existing ~/code/<name> is reused only when it is a real folder whose origin is this same URL; otherwise the
 * next candidate name is tried (owner-name, then name-<hash>), so a launch never works in some other repo that happens to
 * share the name. The chosen folder is printed last as `SYNAPSE_REPO_DIR=<name>`.
 */
export function homeWorktreeScript(o: { codeDir: string; source: string; names: string[]; branch: string; agentId: string }): string {
  const g = `git ${GIT_SAFE_FLAGS.map(q).join(" ")}`;
  return [
    "set -eu",
    "umask 077",
    `[ -d ${q(o.codeDir)} ] || mkdir -m 700 ${q(o.codeDir)}`,
    `cd -P -- ${q(o.codeDir)}`,
    `url=${q(cloneUrl(o.source))}`,
    'pick=""',
    `for n in ${o.names.map(q).join(" ")}; do`,
    '  if [ -e "$n" ] || [ -L "$n" ]; then',
    `    if [ ! -L "$n" ] && [ -d "$n/.git" ] && [ ! -L "$n/.git" ] && [ "$(${g} -C "$n" config --get remote.origin.url 2>/dev/null || true)" = "$url" ]; then`,
    `      ${g} -C "$n" fetch --all --prune || true; pick="$n"; break`,
    "    fi",
    "    continue",
    "  fi",
    `  ${g} clone -- "$url" "$n"; pick="$n"; break`,
    "done",
    '[ -n "$pick" ] || { echo "no free folder in ~/code for this repo" >&2; exit 3; }',
    'mkdir -p "$pick.worktrees"',
    // The worktree path is absolute: `git -C <repo>` reads a relative one from inside the clone.
    `${g} -C "$pick" worktree add -b ${q(o.branch)} ${q(o.codeDir)}/"$pick.worktrees"/${q(o.agentId)}`,
    'echo "SYNAPSE_REPO_DIR=$pick"',
    "",
  ].join("\n");
}

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The folder names a source may use in ~/code, in order: <name>, <owner>-<name>, <name>-<hash of the URL>. */
export function repoDirNames(source: string): string[] {
  const name = repoName(source);
  if (!NAME_RE.test(name)) throw new GatewayError("BAD_ARGS", "That repo name can't be used as a folder name.");
  const owner = /^([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+$/.exec(source)?.[1] ?? path.posix.basename(path.posix.dirname(source.replace(/^[a-z]+:\/\/[^/]*/, "").replace(/^git@[^:]+:/, "/").replace(/\/+$/, "")));
  const hash = createHash("sha256").update(cloneUrl(source)).digest("hex").slice(0, 8);
  return [...new Set([name, ...(NAME_RE.test(owner) ? [`${owner}-${name}`] : []), `${name}-${hash}`])];
}

/**
 * Bug 231: where a coding agent works once the box runs per-Bot accounts: `~/code/<repo>.worktrees/<agent id>` of the
 * Bot's own clone `~/code/<repo>`, made by the Bot's own account. Returns null when the Bot has no account (then the
 * caller keeps the shared /workspace/repos, where every Bot is uid box anyway).
 */
export function homeWorktreePrep(d: { cfg: HostConfig; run: RunAsBot; timeoutMs?: number }) {
  return async (botId: string, a: { source: string; branch: string; agentId: string }): Promise<{ repoDir: string; worktree: string } | null> => {
    if (!botOsUser(d.cfg, botId)) return null;
    const codeDir = botCodeDir(d.cfg, botId);
    const names = repoDirNames(a.source);
    const r = await d.run(botId, homeWorktreeScript({ codeDir, source: a.source, names, branch: a.branch, agentId: a.agentId }), d.timeoutMs ?? 300_000);
    if (r.code !== 0) throw new GatewayError("GIT_FAILED", `Couldn't set up the repo in ~/code: ${r.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
    const picked = /(?:^|\n)SYNAPSE_REPO_DIR=([^\n]*)\s*$/.exec(r.output)?.[1];
    if (!picked || !names.includes(picked)) throw new GatewayError("GIT_FAILED", "Couldn't set up the repo in ~/code.");
    return { repoDir: path.posix.join(codeDir, picked), worktree: path.posix.join(codeDir, `${picked}.worktrees`, a.agentId) };
  };
}

/**
 * The box's RunAsBot: a transient unit under the Bot's own uid through the root helper bot-shell (as bug 195's gh
 * sign-in does), started in its home with the Bot env baseline and no secrets. Its transcript is deleted once it exits.
 */
export function shellRunAsBot(d: { cfg: HostConfig; spawner: ShellSpawner; pollMs?: number }): RunAsBot {
  return async (botId, script, timeoutMs) => {
    const { cfg, spawner } = d;
    const u = botOsUser(cfg, botId);
    if (!u) throw new GatewayError("NO_ACCOUNT", "This Bot has no account of its own on the computer yet.", 409);
    const id = `shell-git-${randomBytes(6).toString("hex")}`;
    fs.mkdirSync(terminalDirFor(cfg, botId), { recursive: true, mode: 0o750 });
    const runDir = path.join(cfg.hostPrivate, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const term = terminalFileFor(cfg, botId, id);
    createTerminalFile(term, 0o640, "---\ncommand: git (coding agent setup)\nstatus: running\n---\n");
    const scriptFile = path.join(runDir, `${id}.sh`), envFile = path.join(runDir, `${id}.env`);
    fs.writeFileSync(scriptFile, script, { mode: 0o600 });
    fs.writeFileSync(envFile, envFileText(buildBotEnv({ cfg, botId, asBot: botId })), { mode: 0o600 });
    try {
      await spawner.start(id, u.home, u.name, botId);
    } catch (e) {
      fs.rmSync(term, { force: true });
      throw e;
    } finally {
      fs.rmSync(envFile, { force: true });
      fs.rmSync(scriptFile, { force: true });
    }
    const read = () => { try { return parseTerminal(fs.readFileSync(term, "utf8")); } catch { return null; } };
    const until = Date.now() + timeoutMs;
    try {
      for (let n = 1; ; n++) {
        const t = read();
        if (t?.footer) return { code: t.footer.exitCode, output: t.body };
        if (Date.now() > until) { await spawner.stop(id).catch(() => {}); return { code: 124, output: `${t?.body ?? ""}\ntimed out` }; }
        if (n % 8 === 0 && (await spawner.status(id).catch(() => "stopped")) === "stopped") {
          const last = read();
          return last?.footer ? { code: last.footer.exitCode, output: last.body } : { code: 143, output: last?.body ?? "" };
        }
        await new Promise((r) => setTimeout(r, d.pollMs ?? 250));
      }
    } finally {
      fs.rmSync(term, { force: true });
    }
  };
}
