import fs from "node:fs";
import path from "node:path";
import type { SkillView } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { botDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { writeTextAtomic } from "../util/atomic-text";
import { deleteSkillDir, SKILL_REL_RE, writeSkillFile, writeSkillHelperFile } from "./skill-box-ops";
import { parseSkill, serializeSkill, slugify, validateSkill, type SkillFile } from "./skill-file";
import { othersThirdPartySkills } from "./third-party";

const FILE_MODE = 0o664; // box:bots 2775 folder (Task 3): the CLI (user box) reads and edits these

export class SkillLibrary {
  private now: () => number;
  private writeSkill: (id: string, content: string) => void;
  private deleteSkill: (id: string) => void;
  private writeSkillHelper: (id: string, rel: string, text: string) => void;
  constructor(
    private d: {
      cfg: HostConfig;
      now?: () => number;
      onChange?: () => void;
      /** Injectable for unit tests; production (cfg.brain === "claude") defaults to the real box-routed writer/deleter (skill-box-ops.ts). */
      writeSkillFile?: (id: string, content: string) => void;
      deleteSkillDir?: (id: string) => void;
      writeSkillHelperFile?: (id: string, rel: string, text: string) => void;
    },
  ) {
    this.now = d.now ?? Date.now;
    // CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): ~/.claude/skills is
    // box:bots 2775 -- box-writable by a Bot too -- so in production the host process must never
    // mutate it with its own fs calls (a Bot could swap the directory for a symlink and redirect a
    // host mkdir/write/rm). Production (cfg.brain === "claude") routes through the root-owned
    // bot-claude-skill-write/-delete/-write-file helpers; the "fake" brain used by local/dev/unit
    // tests (no box, no adversarial Bot) keeps the plain fs fallback below, matching the existing
    // readSessionFile/writeSessionFile convention (host/brain/conformance/session-file.ts, gated the
    // same way in app.ts).
    this.writeSkill = d.writeSkillFile ?? (d.cfg.brain === "claude" ? writeSkillFile : (id, content) => localWriteSkill(this.dir(id), content));
    this.deleteSkill = d.deleteSkillDir ?? (d.cfg.brain === "claude" ? deleteSkillDir : (id) => fs.rmSync(this.dir(id), { recursive: true, force: true }));
    // Follow-up controller ruling: writeHelper() (the non-SKILL.md helper files) carries the same
    // race as write()/remove(), so it routes the same way.
    this.writeSkillHelper = d.writeSkillHelperFile ?? (d.cfg.brain === "claude" ? writeSkillHelperFile : (id, rel, text) => writeTextAtomic(path.join(this.dir(id), rel), text, FILE_MODE));
  }

  root(): string {
    return path.join(this.d.cfg.claudeConfigDir, "skills");
  }
  private dir(id: string): string {
    if (slugify(id) !== id) throw new GatewayError("BAD_SKILL_ID", `Invalid skill id "${id}".`);
    return path.join(this.root(), id);
  }
  /**
   * The SKILL.md path for `id`, or null if it doesn't safely resolve to a real file strictly
   * inside the skills dir. Reads stay direct fs (per the CONTROLLER RULING, only write()/remove()
   * must route through the box helpers), but they must never follow a symlink out of the skills
   * dir: the root itself, the skill's own directory, and SKILL.md are each lstat-checked (never
   * followed) before anything is read.
   */
  private safeSkillFile(id: string): string | null {
    const root = this.root();
    let rootStat: fs.Stats;
    try { rootStat = fs.lstatSync(root); } catch { return null; }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const dir = this.dir(id);
    let dirStat: fs.Stats;
    try { dirStat = fs.lstatSync(dir); } catch { return null; }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const f = path.join(dir, "SKILL.md");
    let fileStat: fs.Stats;
    try { fileStat = fs.lstatSync(f); } catch { return null; }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    return f;
  }
  ids(): string[] {
    const root = this.root();
    let rootStat: fs.Stats;
    try { rootStat = fs.lstatSync(root); } catch { return []; }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
    return fs.readdirSync(root).filter((id) => slugify(id) === id && this.safeSkillFile(id) !== null).sort();
  }
  read(id: string): { file: SkillFile; dir: string; updatedAt: number } | null {
    const f = this.safeSkillFile(id);
    if (!f) return null;
    return { file: parseSkill(fs.readFileSync(f, "utf8")), dir: path.dirname(f), updatedAt: fs.statSync(f).mtimeMs };
  }
  findByName(nameOrId: string): string | null {
    const want = nameOrId.trim();
    if (this.ids().includes(want)) return want;
    return this.ids().find((id) => this.read(id)!.file.name.toLowerCase() === want.toLowerCase()) ?? null;
  }
  /** Every skill whose id is `nameOrId` or whose name matches it (case-insensitive). */
  findAllByName(nameOrId: string): string[] {
    const want = nameOrId.trim().toLowerCase();
    if (!want) return [];
    return this.ids().filter((id) => id === nameOrId.trim() || this.read(id)?.file.name.toLowerCase() === want);
  }
  findBySource(url: string): string | null {
    return this.ids().find((id) => this.read(id)!.file.metadata.source === url) ?? null;
  }

  write(input: { name: string; description: string; body: string; source?: string | null; managed?: boolean; id?: string }): { id: string; created: boolean } {
    const id = input.id ?? slugify(input.name);
    const prev = this.read(id);
    const metadata = { ...(prev?.file.metadata ?? {}) };
    if (input.source !== undefined) { if (input.source) metadata.source = input.source; else delete metadata.source; }
    if (input.managed !== undefined) metadata.managed = input.managed;
    const file: SkillFile = { name: input.name.trim(), description: input.description, metadata, body: input.body, disableModelInvocation: prev?.file.disableModelInvocation ?? false };
    const err = validateSkill(file);
    if (err) throw new GatewayError("BAD_SKILL", err);
    this.dir(id); // validates the id shape (throws BAD_SKILL_ID); the helper owns creating the directory
    this.writeSkill(id, serializeSkill(file));
    this.d.onChange?.();
    return { id, created: !prev };
  }
  remove(id: string): boolean {
    if (!this.read(id)) return false;
    this.deleteSkill(id);
    this.d.onChange?.();
    return true;
  }
  helperFiles(id: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (r !== "SKILL.md") out.push(r);
        if (out.length >= 50) return;
      }
    };
    if (this.read(id)) walk(this.dir(id), "");
    return out.sort();
  }
  writeHelper(id: string, rel: string, text: string): void {
    if (!SKILL_REL_RE.test(rel) || rel === "SKILL.md") throw new GatewayError("BAD_PATH", `Invalid helper file path "${rel}".`);
    this.dir(id); // validates the id shape (throws BAD_SKILL_ID); the helper owns creating the directory
    this.writeSkillHelper(id, rel, text);
  }

  // ---- per-Bot opt-out (enabled-workflows.json) ----
  private optFile(botId: string): string {
    return path.join(botDir(this.d.cfg, botId), "enabled-workflows.json");
  }
  /** Off for this Bot: its own opt-outs, plus every third-party skill that came with another Bot (Bot sharing). */
  disabledFor(botId: string): string[] {
    const own = this.optedOut(botId);
    return [...new Set([...own, ...othersThirdPartySkills(this.d.cfg, botId)])];
  }
  private optedOut(botId: string): string[] {
    return readJson<{ disabled: string[] }>(this.optFile(botId), { disabled: [] }).disabled;
  }
  setEnabled(botId: string, id: string, enabled: boolean): string[] {
    // A skill that came with another Bot (Bot sharing) can't be turned on here; say so rather than flip back.
    if (enabled && othersThirdPartySkills(this.d.cfg, botId).includes(id)) throw new GatewayError("SKILL_STAYS", "Shared skills stay with the Bot they came with.", 409);
    const cur = this.optedOut(botId).filter((x) => x !== id);
    const next = enabled ? cur : [...cur, id];
    writeJsonAtomic(this.optFile(botId), { disabled: next }, 0o640);
    this.d.onChange?.();
    return this.disabledFor(botId);
  }

  view(id: string, botIds: string[]): SkillView {
    const r = this.read(id);
    if (!r) throw new GatewayError("NOT_FOUND", "No such skill.", 404);
    return {
      id, name: r.file.name, description: r.file.description, source: typeof r.file.metadata.source === "string" ? r.file.metadata.source : null,
      managed: r.file.metadata.managed === true, bodyChars: r.file.body.length, disabledFor: botIds.filter((b) => this.disabledFor(b).includes(id)), updatedAt: r.updatedAt,
    };
  }
  views(botIds: string[]): SkillView[] {
    return this.ids().map((id) => this.view(id, botIds));
  }
}

/** The plain-fs fallback for local dev / "fake" brain unit tests (no box, no adversarial Bot). */
function localWriteSkill(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o2775 });
  writeTextAtomic(path.join(dir, "SKILL.md"), content, FILE_MODE);
}
