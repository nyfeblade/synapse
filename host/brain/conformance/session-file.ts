import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import { log } from "../../util/log";

/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-read-session. */
export const SESSION_READ_HELPER = "/usr/local/libexec/bot-claude-read-session";
/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-write-session. */
export const SESSION_WRITE_HELPER = "/usr/local/libexec/bot-claude-write-session";
/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-delete-session. */
export const SESSION_DELETE_HELPER = "/usr/local/libexec/bot-claude-delete-session";

/**
 * Reads a box-owned Claude Code session transcript (`~/.claude/projects/**​/*.jsonl`).
 *
 * The CLI writes these files `0600 box:bots` — an explicit `open()` mode, not umask-derived — so the
 * shared `bots` group membership that lets bothost list/enter `~/.claude/projects` gives it no read
 * bits on the files themselves. Rather than loosen `/home/box` permissions (session transcripts are
 * legitimately sensitive), this shells out as bothost, via `sudo -n`, to the narrow root-owned
 * `bot-claude-read-session` helper, which validates the caller and the path (a strict allowlist under
 * `/home/box/.claude/projects/`, no traversal or symlink escape) before `cat`-ing the file.
 */
export function readSessionFile(filePath: string, exec: typeof execFileSync = execFileSync): Buffer {
  return exec("sudo", ["-n", SESSION_READ_HELPER, filePath], { env: scrubClaudeLogin(process.env), maxBuffer: 256 * 1024 * 1024 }) as Buffer;
}

/**
 * Writes a NEW box-owned Claude Code session transcript (used by CT-14 to synthesize
 * rollover-sized sessions for resume-latency probing).
 *
 * bothost has no write bits under `~/.claude/projects` (the CLI-managed tree is `box:bots` with the
 * directory itself only group-writable by files the CLI creates as box), so this shells out, via
 * `sudo -n`, to the narrow root-owned `bot-claude-write-session` helper, piping the content on
 * stdin. The helper re-validates the path (the same strict allowlist as the read helper), refuses
 * to overwrite an existing file, enforces a size cap, and writes atomically as box:box 0600.
 */
export function writeSessionFile(filePath: string, content: string, exec: typeof execFileSync = execFileSync): void {
  exec("sudo", ["-n", SESSION_WRITE_HELPER, filePath], { env: scrubClaudeLogin(process.env), input: content, maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Deletes one box-owned session transcript (`/home/box/.claude/projects/-workspace/<uuid>.jsonl`, plus
 * its `<uuid>/` directory if any) through the root-owned `bot-claude-delete-session` helper: bothost
 * has no write bits there, so it can't unlink the file itself (gate M-2). Throws on a helper failure.
 */
export function deleteSessionFile(filePath: string, exec: typeof execFileSync = execFileSync): void {
  exec("sudo", ["-n", SESSION_DELETE_HELPER, filePath], { env: scrubClaudeLogin(process.env), stdio: ["ignore", "ignore", "pipe"] });
}

/** Best-effort deleteSessionFile for Bot deletion and CT-14 cleanup: logs a warning instead of throwing. */
export function removeBoxSession(filePath: string, exec: typeof execFileSync = execFileSync): boolean {
  try {
    deleteSessionFile(filePath, exec);
    return true;
  } catch (err) {
    log.warn("could not delete box session file via bot-claude-delete-session", { filePath, error: String(err) });
    return false;
  }
}
