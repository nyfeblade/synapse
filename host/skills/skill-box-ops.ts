import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";

/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-skill-write. */
export const SKILL_WRITE_HELPER = "/usr/local/libexec/bot-claude-skill-write";
/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-skill-delete. */
export const SKILL_DELETE_HELPER = "/usr/local/libexec/bot-claude-skill-delete";
/** Root-owned helper installed by box/provision.sh; see box/files/bot-claude-skill-write-file. */
export const SKILL_WRITE_FILE_HELPER = "/usr/local/libexec/bot-claude-skill-write-file";

/**
 * Same slug shape SkillLibrary.dir() already enforces on every id it hands here. Checked again in
 * this module too, so it never trusts a caller (CONTROLLER RULING). The leading `[a-z0-9]` class
 * alone rules out both "." and ".." as a whole id, but both are still rejected explicitly, matching
 * the box helper scripts' own belt-and-suspenders checks.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function assertSkillId(id: string): void {
  if (id === "." || id === ".." || id.includes("..") || !SKILL_ID_RE.test(id)) {
    throw new Error(`invalid skill id ${JSON.stringify(id)}`);
  }
}

/**
 * Writes (or overwrites) a user-authored skill's SKILL.md through the root-owned
 * bot-claude-skill-write helper, via `sudo -n`, piping the content on stdin.
 *
 * CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): `~/.claude/skills` is
 * `box:bots 2775` -- box-writable by design, because Bot processes (running as box) edit skills
 * too. That same group-write bit is exactly the danger: a Bot could swap the skills directory
 * itself, or one skill's own directory, for a symlink and, if bothost then used its own
 * fs.mkdirSync/fs.writeFileSync, redirect the write into a path bothost owns (e.g. its hostPrivate
 * token store). So the host process never touches this tree with its own fs calls for a mutation;
 * it always shells out to this helper, which runs the actual mkdir/write as user box, re-resolves
 * every path component and refuses on any symlink before ever touching it.
 */
export function writeSkillFile(id: string, content: string, exec: typeof execFileSync = execFileSync): void {
  assertSkillId(id);
  exec("sudo", ["-n", SKILL_WRITE_HELPER, id], { env: scrubClaudeLogin(process.env), input: content, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Same as writeSkillFile, but refuses (throws) instead of overwriting if SKILL.md already exists
 * (the helper publishes with `ln` instead of `mv -f`). Used by templates/importer.ts, which writes
 * into a brand-new, never-before-seen skill directory and must never silently clobber a file.
 */
export function writeSkillFileNoClobber(id: string, content: string, exec: typeof execFileSync = execFileSync): void {
  assertSkillId(id);
  exec("sudo", ["-n", SKILL_WRITE_HELPER, id, "--no-clobber"], { env: scrubClaudeLogin(process.env), input: content, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Deletes a user-authored skill's directory through the root-owned bot-claude-skill-delete helper
 * (same CONTROLLER RULING as writeSkillFile). Idempotent: a missing skill directory is not an error.
 */
export function deleteSkillDir(id: string, exec: typeof execFileSync = execFileSync): void {
  assertSkillId(id);
  exec("sudo", ["-n", SKILL_DELETE_HELPER, id], { env: scrubClaudeLogin(process.env), stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Same relative-path shape SkillLibrary.writeHelper() already enforces on every path it hands
 * here: no leading "/", no ".." segment, and each segment limited to word characters, space, ".",
 * "@", "+" and "-". Exported so SkillLibrary can reuse the exact same pattern for its own
 * user-facing validation (BAD_PATH) instead of duplicating it.
 */
export const SKILL_REL_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w .@+-]+(?:\/[\w .@+-]+)*$/;

function assertSkillRel(rel: string): void {
  if (rel === "SKILL.md" || !SKILL_REL_RE.test(rel)) throw new Error(`invalid skill helper file path ${JSON.stringify(rel)}`);
}

/**
 * Writes one non-SKILL.md helper file (a template, a script, a reference doc, …) inside a
 * user-authored skill's own directory, through the root-owned bot-claude-skill-write-file helper,
 * via `sudo -n`, piping the content on stdin.
 *
 * Follow-up CONTROLLER RULING: this carries the exact same race as writeSkillFile (same
 * `box:bots 2775` tree), so SkillLibrary.writeHelper() must route through a run-as-box helper too,
 * confined to that skill's own directory, with O_NOFOLLOW-equivalent checks at every path
 * component and a validated relative path (no absolute path, no ".." segment).
 */
export function writeSkillHelperFile(id: string, rel: string, content: string, exec: typeof execFileSync = execFileSync): void {
  assertSkillId(id);
  assertSkillRel(rel);
  exec("sudo", ["-n", SKILL_WRITE_FILE_HELPER, id, rel], { env: scrubClaudeLogin(process.env), input: content, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Same as writeSkillHelperFile, but refuses (throws) instead of overwriting if the target already
 * exists (the helper publishes with `ln` instead of `mv -f`). Used by templates/importer.ts for the
 * same reason as writeSkillFileNoClobber.
 */
export function writeSkillHelperFileNoClobber(id: string, rel: string, content: string, exec: typeof execFileSync = execFileSync): void {
  assertSkillId(id);
  assertSkillRel(rel);
  exec("sudo", ["-n", SKILL_WRITE_FILE_HELPER, id, rel, "--no-clobber"], { env: scrubClaudeLogin(process.env), input: content, maxBuffer: 8 * 1024 * 1024 });
}
