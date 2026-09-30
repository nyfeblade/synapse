import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeHidden, encodeShareRaw, normalizeAvatarShape, redactPersonal, runsCode, SHARE_LIMITS, type CatalogAuthor, type SharePreview, type ShareSelection, type TemplateManifest, type TemplateRecord } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { slugify } from "../util/text";
import { builtInSkillIds } from "../prompts";
import { writeBotpack } from "./botpack";
import { othersThirdPartySkills, thirdPartySkillOwners } from "../skills/third-party";
import { StubTemplateDrafter, type DraftInput, type TemplateDrafter } from "./drafter";

const FACT = /^- \(\d{4}-\d{2}-\d{2}\) (?:\[(?:note|episode)\] )?(.+)$/;

export function readFacts(memoryDir: string): string[] {
  const files = [path.join(memoryDir, "profile.md")];
  const logDir = path.join(memoryDir, "log");
  if (fs.existsSync(logDir)) files.push(...fs.readdirSync(logDir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(logDir, f)));
  return files.filter((f) => fs.existsSync(f)).flatMap((f) => fs.readFileSync(f, "utf8").split("\n").map((l) => FACT.exec(l.trim())?.[1]).filter((x): x is string => !!x));
}

function frontMatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => /^([A-Za-z_-]+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1]!, x[2]!.trim()]));
}

export class TemplatePackager {
  readonly templatesDir: string;
  /** ladder: I11 — the drafter's model call runs only when the usage ladder allows background work. */
  constructor(private d: { cfg: HostConfig; bots: BotService; drafter: TemplateDrafter; plugins(): { catalogId: string; name: string }[]; author(): CatalogAuthor | undefined; now(): number; onChange?(): void; ladder?(): { allowsBackground(kind: "template-draft"): boolean } }) {
    this.templatesDir = path.join(d.cfg.dataRoot, "templates");
  }

  private botDir(botId: string): string { return path.join(this.d.cfg.dataRoot, "agents", botId); }

  gather(botId: string): { input: DraftInput; skillIds: string[] } {
    const p = this.d.bots.summary(botId).profile;
    const dir = this.botDir(botId);
    const disabled = new Set(readJson<{ disabled: string[] }>(path.join(dir, "enabled-workflows.json"), { disabled: [] }).disabled);
    for (const id of builtInSkillIds()) disabled.add(id); // new-user walk, finding 12: the app's own playbooks stay out
    for (const id of othersThirdPartySkills(this.d.cfg, botId)) disabled.add(id); // Bot sharing: another Bot's imports
    const skillsRoot = path.join(this.d.cfg.claudeConfigDir, "skills");
    const skills = (isRealDir(skillsRoot) ? fs.readdirSync(skillsRoot) : []).sort().flatMap((id) => {
      if (disabled.has(id)) return [];
      const md = skillMdFiles(skillsRoot, id)?.["SKILL.md"];
      if (md === undefined) return [];
      const fm = frontMatter(md);
      return fm.private === "true" ? [] : [{ id, name: fm.name ?? id, description: fm.description ?? "" }];
    });
    const autoDir = path.join(dir, "automations");
    const routines = (fs.existsSync(autoDir) ? fs.readdirSync(autoDir) : []).sort().flatMap((r) => {
      const a = readJson<{ name?: string; prompt?: string; schedule?: string } | null>(path.join(autoDir, r, "automation.json"), null);
      return a?.name && a.prompt ? [{ name: a.name, prompt: a.prompt, schedule: a.schedule ?? null }] : [];
    });
    return { input: { botName: p.name, description: p.description, memories: readFacts(path.join(dir, "memory")), skills, routines }, skillIds: skills.map((s) => s.id) };
  }

  async draft(botId: string): Promise<TemplateManifest> {
    const { input } = this.gather(botId);
    const allowed = this.d.ladder ? this.d.ladder().allowsBackground("template-draft") : true;
    const out = await (allowed ? this.d.drafter : new StubTemplateDrafter()).draft(botId, this.d.bots.sessionId(botId), input);
    const p = this.d.bots.summary(botId).profile;
    return {
      profile: { name: p.name, title: p.title, description: out.description, avatarShape: p.avatarShape, avatarColor: p.avatarColor, ...(p.model ? { model: p.model } : {}) },
      skills: input.skills, memories: out.memories, routines: input.routines, plugins: this.d.plugins(),
    };
  }

  export(botId: string, manifest: TemplateManifest): { template: TemplateRecord; fileName: string; bytes: Uint8Array } {
    const prev = this.get(botId);
    const now = this.d.now();
    const template: TemplateRecord = { id: prev?.id ?? randomUUID(), name: manifest.profile.name, author: this.d.author(), sourceBotId: botId, visibility: "local", createdAt: prev?.createdAt ?? now, updatedAt: now, manifest };
    writeJsonAtomic(path.join(this.templatesDir, template.id, "template.json"), template, 0o640);
    this.d.bots.require(botId).store.setKv("templateId", template.id);
    const skillsRoot = path.join(this.d.cfg.claudeConfigDir, "skills");
    const skills: Record<string, Record<string, Uint8Array>> = {};
    for (const s of manifest.skills) {
      const files = skillMdFiles(skillsRoot, s.id); // never through a symlink (security review)
      if (!files) continue;
      skills[s.id] = Object.fromEntries(Object.entries(files).map(([f, text]) => [f, new TextEncoder().encode(text)]));
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const bytes = writeBotpack({ template, skills, memoriesMd: manifest.memories.map((m) => `- (${today}) ${m}`).join("\n") + (manifest.memories.length ? "\n" : ""), avatar: this.avatar(botId) });
    this.noteExported(bytes);
    this.d.onChange?.(); // the Marketplace search index lists local templates (Task 34 fuzz)
    return { template, fileName: `${slugify(template.name)}.botpack`, bytes };
  }

  /**
   * Bot sharing: the Bot as a share link, built from what is allowed to leave (never filtered afterwards): the
   * profile, the chosen skills' .md files and the chosen tools. Never memories, routines, the avatar image, an
   * author or the source Bot. Every outgoing text is redacted (keys, emails, card numbers…) and the sheet says what
   * was hidden. `remember` marks this link copied, so the menu can offer one-click Copy link while nothing changes.
   */
  async sharePayload(botId: string, selection?: ShareSelection, remember = false): Promise<SharePreview> {
    const L = SHARE_LIMITS;
    const p = this.d.bots.summary(botId).profile;
    const store = this.d.bots.require(botId).store;
    const found: Record<string, number> = {};
    const redact = (t: string) => { const r = redactPersonal(t); for (const [k, n] of Object.entries(r.found)) found[k] = (found[k] ?? 0) + n; return r.text; };
    const skillsRoot = path.join(this.d.cfg.claudeConfigDir, "skills");
    const all = this.gather(botId).input.skills.flatMap((sk) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sk.id)) return [];
      const found = skillMdFiles(skillsRoot, sk.id) ?? {};
      const files: Record<string, string> = Object.fromEntries(Object.entries(found).filter(([f, b]) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/.test(f) && b.length <= L.skillFileChars).sort(([a], [b]) => a.localeCompare(b)).slice(0, L.skillFiles));
      return files["SKILL.md"] === undefined ? [] : [{ id: sk.id, name: sk.name.slice(0, L.name) || sk.id, description: sk.description.slice(0, L.skillDescription), files }];
    });
    const tools = this.d.plugins().filter((t) => t.catalogId && t.name).slice(0, L.tools);
    const last = store.getKv<{ selection: ShareSelection; fragment: string } | null>("lastShare", null);
    // Security review (privacy): by default only what is this Bot's own is ticked: the skills and tools it came
    // with when it was added from someone else. The shared skills library and installed plugins start unticked.
    const owners = thirdPartySkillOwners(this.d.cfg);
    const cameWith = new Set(store.getKv<string[]>("importedTools", []));
    const sel: ShareSelection = selection ?? last?.selection ?? { skills: all.filter((x) => owners[x.id] === botId).map((x) => x.id), tools: tools.filter((t) => cameWith.has(t.catalogId)).map((t) => t.catalogId) };
    const chosenSkills = all.filter((x) => sel.skills.includes(x.id)).slice(0, L.skills);
    const payload = {
      v: 1, name: redact(p.name).slice(0, L.name), title: redact(p.title ?? "").slice(0, L.title), instructions: redact(p.description ?? "").slice(0, L.instructions),
      shape: normalizeAvatarShape(p.avatarShape) ?? "pebble", color: p.avatarColor, ...(p.model ? { model: p.model } : {}),
      tools: tools.filter((t) => sel.tools.includes(t.catalogId)).map((t) => ({ catalogId: t.catalogId, name: t.name.slice(0, L.name) })),
      skills: chosenSkills.map((x) => ({ id: x.id, name: redact(x.name), description: redact(x.description), files: Object.fromEntries(Object.entries(x.files).map(([f, b]) => [f, redact(b)])) })),
    };
    const raw = await encodeShareRaw(payload);
    const fragment = raw.length <= L.linkMaxChars ? raw : null;
    if (remember && fragment) store.setKv("lastShare", { selection: sel, fragment });
    return {
      name: payload.name, title: payload.title, instructions: payload.instructions, face: { shape: payload.shape, color: payload.color },
      skills: all.map((x) => ({ id: x.id, name: x.name, description: x.description, runsCode: runsCode(x.files), included: chosenSkills.some((c) => c.id === x.id) })),
      tools: tools.map((t) => ({ catalogId: t.catalogId, name: t.name, included: sel.tools.includes(t.catalogId) })),
      fragment, length: raw.length, hidden: describeHidden(found), sameAsLastShare: !!last && !!fragment && last.fragment === fragment, selection: sel,
    };
  }

  /**
   * New-user walk, finding 10: a .botpack is third-party by ORIGIN (I9), and a file this host wrote is not. Proven by
   * the bytes' hash against the ones this host exported (the last 200), never by the author name the file claims.
   */
  private get exportedFile(): string { return path.join(this.templatesDir, "exported.json"); }
  private noteExported(bytes: Uint8Array): void {
    const hashes = readJson<string[]>(this.exportedFile, []);
    writeJsonAtomic(this.exportedFile, [...hashes.filter((h) => h !== sha(bytes)), sha(bytes)].slice(-200), 0o640);
  }
  exportedHere(bytes: Uint8Array): boolean {
    return readJson<string[]>(this.exportedFile, []).includes(sha(bytes));
  }

  get(botId: string): TemplateRecord | null {
    const id = this.d.bots.require(botId).store.getKv<string | null>("templateId", null);
    return id ? readJson<TemplateRecord | null>(path.join(this.templatesDir, id, "template.json"), null) : null;
  }

  list(): TemplateRecord[] {
    if (!fs.existsSync(this.templatesDir)) return [];
    // Only folders are templates: exported.json (the hashes of files this host wrote) sits beside them, and reading
    // it as a folder threw ENOTDIR, which failed every export after the first catalog refresh.
    return fs.readdirSync(this.templatesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readJson<TemplateRecord | null>(path.join(this.templatesDir, e.name, "template.json"), null)).filter((t): t is TemplateRecord => !!t);
  }

  delete(templateId: string): void {
    const t = readJson<TemplateRecord | null>(path.join(this.templatesDir, templateId, "template.json"), null);
    fs.rmSync(path.join(this.templatesDir, templateId), { recursive: true, force: true });
    if (t?.sourceBotId) try { this.d.bots.require(t.sourceBotId).store.setKv("templateId", null); } catch { /* Bot deleted */ }
    this.d.onChange?.();
  }

  private avatar(botId: string): { name: string; bytes: Uint8Array } | null {
    const dir = this.botDir(botId);
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => /^avatar\.(png|jpe?g|webp|gif|svg)$/.test(n)) : undefined;
    return f ? { name: f, bytes: new Uint8Array(fs.readFileSync(path.join(dir, f))) } : null;
  }
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A real directory, not a symlink (lstat, never followed). */
function isRealDir(p: string): boolean {
  try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}
/**
 * A skill's .md files, read only when the skills root, the skill's folder and each file are real (lstat, never
 * followed): the skills folder is writable by the Bots, so a planted symlink must never pull another file into a
 * share link or an export (security review). Null when the folder isn't a real one.
 */
export function skillMdFiles(skillsRoot: string, id: string): Record<string, string> | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !isRealDir(skillsRoot)) return null;
  const dir = path.join(skillsRoot, id);
  let seen: fs.Stats;
  try { seen = fs.lstatSync(dir); } catch { return null; }
  if (!seen.isDirectory() || seen.isSymbolicLink()) return null;
  // Re-review (TOCTOU): open the folder itself (never through a link) and check it is the one just looked at, and
  // still is after listing it; a folder swapped for a symlink in between is refused.
  let dfd: number;
  try { dfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | fs.constants.O_NOFOLLOW); } catch { return null; }
  const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
  try {
    if (!same(fs.fstatSync(dfd), seen)) return null;
    const names = fs.readdirSync(dir);
    const now = fs.lstatSync(dir);
    if (now.isSymbolicLink() || !same(now, seen)) return null;
    return readRegularMd(dir, names, () => { try { const st = fs.lstatSync(dir); return !st.isSymbolicLink() && same(st, seen); } catch { return false; } });
  } finally { fs.closeSync(dfd); }
}

function readRegularMd(dir: string, names: string[], stillSame: () => boolean): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const file = path.join(dir, f);
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { out[f] = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
    } catch { /* swapped for a link between the check and the read: skipped */ }
    if (!stillSame()) return null;
  }
  return out;
}
