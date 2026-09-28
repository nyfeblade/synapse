import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "@synapse/shared";
import YAML from "yaml";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { loadPrompt } from "../prompts/index";
import { writeSkillFile } from "../skills/skill-box-ops";
import { slugify } from "../skills/skill-file";

export const TEACH_SECTIONS = ["## When to use", "## Inputs and access", "## Steps", "## Decision points", "## Validation", "## Output", "## Approval points", "## Failure handling"] as const;
const PARAM_TYPES = new Set(["string", "date", "email", "number", "file", "choice", "secret"]);
const defaultWrite = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const MANAGED_SKILL_ID = "learn-from-demonstration";

export function parseSkill(md: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error("no front matter");
  const front = YAML.parse(m[1]!) as unknown;
  if (!front || typeof front !== "object" || Array.isArray(front)) throw new Error("front matter is not a mapping");
  return { front: front as Record<string, unknown>, body: m[2]! };
}

/**
 * Installs (or refreshes) the managed skill in the Bot skills library (§4.2).
 *
 * Follow-up CONTROLLER RULING (same as SkillLibrary.write()/.remove()): `~/.claude/skills` is
 * box:bots 2775 -- box-writable by a Bot too -- so in production (cfg.brain === "claude") this
 * writes through the root-owned bot-claude-skill-write helper (skills/skill-box-ops.ts) instead of
 * its own fs.mkdirSync/fs.writeFileSync. An explicit `write` override (used by no caller today, kept
 * for tests) always wins; the "fake" brain local/dev fallback is unchanged.
 */
export function installManagedSkill(cfg: HostConfig, write?: (file: string, text: string) => void): boolean {
  const text = loadPrompt("skills/learn-from-demonstration/SKILL.md");
  const file = path.join(cfg.claudeConfigDir, "skills", MANAGED_SKILL_ID, "SKILL.md");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return false;
  const w = write ?? (cfg.brain === "claude" ? (_file: string, t: string) => writeSkillFile(MANAGED_SKILL_ID, t) : defaultWrite);
  w(file, text);
  return true;
}

/**
 * Boot-path install. `~/.claude/skills` is box-writable by design and the root helper that publishes SKILL.md now
 * runs as box (final secfix round 3, ruling 1), so a skill directory box cannot write -- a legacy host-owned one, or
 * one a Bot made -- makes the write throw. That must never take the host down: it crash-looped the gateway on the
 * live box, because boot() ran before the gateway listened.
 */
export function installManagedSkillOnBoot(cfg: HostConfig, write?: (file: string, text: string) => void): boolean {
  try {
    return installManagedSkill(cfg, write);
  } catch (e) {
    console.error(`installManagedSkill: could not refresh the managed skill ${MANAGED_SKILL_ID}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** ORIG-08 §08.4 lint: the eight sections, valid front matter and parameters, ≤ 100,000 chars. */
export function lintTeachSkill(md: string): string[] {
  const errors: string[] = [];
  if (md.length > LIMITS.skillBodyMax) errors.push("The skill is longer than 100,000 characters.");
  let parsed: { front: Record<string, unknown>; body: string };
  try {
    parsed = parseSkill(md);
  } catch {
    return [...errors, "The skill needs YAML front matter."];
  }
  const { front, body } = parsed;
  if (typeof front.name !== "string" || !front.name.trim()) errors.push("Front matter needs a name.");
  if (typeof front.description !== "string" || !front.description.trim()) errors.push("Front matter needs a description.");
  const meta = (front.metadata ?? {}) as Record<string, unknown>;
  if (meta.status !== undefined && meta.status !== "draft" && meta.status !== "tested") errors.push("metadata.status must be draft or tested.");
  const params = meta.parameters;
  if (params !== undefined && !Array.isArray(params)) errors.push("metadata.parameters must be a list.");
  for (const p of Array.isArray(params) ? (params as Record<string, unknown>[]) : []) {
    const name = String(p.name ?? "");
    if (!/^[a-z][a-z0-9_]*$/.test(name)) errors.push(`Parameter "${name}" must be snake_case.`);
    if (!PARAM_TYPES.has(String(p.type))) errors.push(`Parameter "${name}" has an unknown type "${String(p.type)}".`);
    if (p.type === "secret" && p.example !== undefined) errors.push(`Secret parameter "${name}" must not have an example.`);
  }
  let from = 0;
  for (const s of TEACH_SECTIONS) {
    const i = body.indexOf(`${s}\n`, from);
    if (i < 0) { errors.push(`Missing section "${s}".`); continue; }
    from = i + s.length;
  }
  const fh = body.slice(body.indexOf("## Failure handling"));
  if (body.includes("## Failure handling") && !/request_box_help/.test(fh)) errors.push('"## Failure handling" must mention request_box_help.');
  return errors;
}

/**
 * Derives the skill id from an already-validated `skillPath` (teachReviewProvider checks it starts
 * under the skills root and ends in "SKILL.md" before this ever runs), and only if that path is
 * exactly `<claudeConfigDir>/skills/<id>/SKILL.md` for an `<id>` shaped like `SkillLibrary.dir()`
 * requires (`slugify(id) === id`). Anything else (a deeper path, or one that doesn't round-trip) is
 * refused (null) rather than guessed at, so a mismatch fails closed instead of routing an
 * unvalidated id into the box helper.
 */
function skillIdFromPath(cfg: HostConfig, skillPath: string): string | null {
  const id = path.basename(path.dirname(skillPath));
  if (slugify(id) !== id) return null;
  return path.join(cfg.claudeConfigDir, "skills", id, "SKILL.md") === skillPath ? id : null;
}

/**
 * Follow-up CONTROLLER RULING (same as SkillLibrary.write()/.remove()/installManagedSkill()): edits
 * an *existing* skill's SKILL.md in place (its `metadata.status`), in the same box:bots 2775
 * `~/.claude/skills` tree. An explicit `write` override always wins (used by tests and by
 * `setSkillStatus(f, ...)` calls with no `cfg`, which keep the old plain-fs behavior — there's
 * nothing to route safely without a `cfg` to resolve the skills root against).
 *
 * Controller correction: with a `cfg` whose `brain` is `"claude"` (production, real box) and no
 * `FUZZ=1` (fuzz runs have no real box/sudo either), this MUST route through `writeSkillFile`, and a
 * path that doesn't cleanly resolve to a real skill id (`skillIdFromPath` returns null) REFUSES
 * outright — it must never fall back to a local fs write, because that local write is exactly the
 * unsafe bothost-fs-under-a-Bot-writable-tree operation the ruling exists to close off. Only the
 * "fake" brain, or FUZZ mode, may use the local write (matching app.ts's own `fuzz` flag:
 * `process.env.FUZZ === "1" || cfg.brain === "fake"`).
 */
export function setSkillStatus(skillPath: string, status: "draft" | "tested" | null, write?: (file: string, text: string) => void, cfg?: HostConfig): void {
  const md = fs.readFileSync(skillPath, "utf8");
  const { front, body } = parseSkill(md);
  const meta = { ...((front.metadata ?? {}) as Record<string, unknown>) };
  if (status === null) delete meta.status;
  else meta.status = status;
  const content = `---\n${YAML.stringify({ ...front, metadata: meta }).trimEnd()}\n---\n${body}`;
  if (write) { write(skillPath, content); return; }
  const localWriteAllowed = cfg === undefined || cfg.brain !== "claude" || process.env.FUZZ === "1";
  if (localWriteAllowed) { defaultWrite(skillPath, content); return; }
  const id = skillIdFromPath(cfg, skillPath);
  if (!id) throw new GatewayError("BAD_SKILL_PATH", "That skill can't be updated safely: its path doesn't resolve to a skill in the library.");
  writeSkillFile(id, content);
}
