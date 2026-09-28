import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, STR5, type AvatarShape, type CatalogCategory, type StarterView, type TemplatePreview } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { TemplateCatalogItem, TemplateSource } from "../phase5/types";
import { slugify, withSourceMetadata } from "../util/text";
import { log } from "../util/log";
import { writeJsonAtomic } from "../util/atomic-json";
import { writeSkillFileNoClobber, writeSkillHelperFileNoClobber } from "../skills/skill-box-ops";
import { readBotpack, type BotpackContents } from "./botpack";
import type { TemplatePackager } from "./packager";

export interface StarterTemplate extends StarterView { description: string; category: CatalogCategory | null; routines?: { name: string; prompt: string; schedule: string | null }[] }

export function loadStarters(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "starters.json")): StarterTemplate[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as StarterTemplate[];
}

const PREVIEW_TTL_MS = 30 * 60_000;
const TEAM = { name: `${APP_NAME} Team` };

export class TemplateImporter implements TemplateSource {
  private previews = new Map<string, { pack: BotpackContents; sourceTemplateId: string; at: number }>();

  /** remember: MemoryStore.add for the new Bot (I10); redact: the secret scanner, applied to every imported fact first. */
  constructor(private d: { cfg: HostConfig; bots: BotService; packager: TemplatePackager; starters: StarterTemplate[]; installedCatalogIds(): Set<string>; kickstart(botId: string): void; selfName(): string | null; now(): number;
    /** Bug 44(b): @returns whether the fact is now in the Bot's memory. A false is acted on, not warned about. */
    remember?(botId: string, fact: string): boolean;
    /** A notification in the new Bot's chat (TrayService): the last resort when a promised fact could not be saved at all. */
    notify?(t: { botId: string; title: string; detail: string }): void;
    redact?(botId: string, text: string): string }) {}

  starterViews(): StarterView[] {
    return this.d.starters.map(({ id, name, title, blurb, avatarShape, avatarColor, tools }) => ({ id: `starter:${id}`, name, title, blurb, avatarShape, avatarColor, tools }));
  }

  list(): TemplateCatalogItem[] {
    const used = new Set(this.d.bots.ids().map((id) => this.d.bots.require(id).store.getKv<string | null>("sourceTemplateId", null)).filter(Boolean));
    return [
      ...this.d.starters.map((s) => ({ id: `starter:${s.id}`, source: "starter" as const, name: s.name, description: s.blurb, author: TEAM, category: s.category, featured: false, added: used.has(`starter:${s.id}`) })),
      ...this.d.packager.list().map((t) => ({ id: `tpl:${t.id}`, source: "local-template" as const, name: t.name, description: t.manifest.profile.description.split(/(?<=\.)\s/)[0] ?? "", author: t.author, category: null, featured: !!t.author, added: used.has(`tpl:${t.id}`) })),
    ];
  }

  preview(a: { bytesBase64?: string; starterId?: string; templateId?: string }): TemplatePreview {
    let pack: BotpackContents;
    let sourceTemplateId: string;
    let thirdParty = false;
    if (a.starterId) {
      const s = this.d.starters.find((x) => `starter:${x.id}` === a.starterId);
      if (!s) throw new GatewayError("NOT_FOUND", "No such starter template.", 404);
      pack = { template: { id: s.id, name: s.name, author: TEAM, sourceBotId: null, visibility: "local", createdAt: 0, updatedAt: 0, manifest: { profile: { name: s.name, title: s.title, description: s.description, avatarShape: s.avatarShape, avatarColor: s.avatarColor }, skills: [], memories: [], routines: s.routines ?? [], plugins: [] } }, skills: {}, memoriesMd: "", avatar: null };
      sourceTemplateId = a.starterId;
    } else if (a.templateId) {
      const t = this.d.packager.list().find((x) => `tpl:${x.id}` === a.templateId);
      if (!t) throw new GatewayError("NOT_FOUND", "No such template.", 404);
      pack = { template: t, skills: {}, memoriesMd: t.manifest.memories.map((m) => `- ${m}`).join("\n"), avatar: null };
      sourceTemplateId = a.templateId;
    } else {
      // I9: a file is third-party by ORIGIN (a claimed author name proves nothing), and nothing is saved on preview.
      pack = readBotpack(new Uint8Array(Buffer.from(a.bytesBase64 ?? "", "base64")));
      sourceTemplateId = `tpl:${pack.template.id}`;
      thirdParty = true;
    }
    const token = randomBytes(16).toString("hex");
    for (const [k, v] of this.previews) if (this.d.now() - v.at > PREVIEW_TTL_MS) this.previews.delete(k);
    this.previews.set(token, { pack, sourceTemplateId, at: this.d.now() });
    const m = pack.template.manifest;
    const installed = this.d.installedCatalogIds();
    return {
      token, name: m.profile.name, description: m.profile.description, ...(pack.template.author ? { author: pack.template.author } : {}),
      facts: m.memories, playbooks: m.skills.map((s) => s.name), jobs: m.routines.map((r) => r.name),
      apps: m.plugins.map((p) => ({ name: p.name, needsConnecting: !installed.has(p.catalogId) })), thirdParty,
      playbooksShared: m.skills.length > 0,
    };
  }

  import(token: string): { id: string } {
    const p = this.previews.get(token);
    if (!p || this.d.now() - p.at > PREVIEW_TTL_MS) throw new GatewayError("PREVIEW_EXPIRED", "This preview expired. Open the template again.", 410);
    this.previews.delete(token);
    const m = p.pack.template.manifest;
    const id = this.d.bots.create({ name: m.profile.name, title: m.profile.title, description: m.profile.description, avatarShape: m.profile.avatarShape as AvatarShape, avatarColor: m.profile.avatarColor, model: m.profile.model as never, origin: "user", kickstart: true });
    this.d.bots.require(id).store.setKv("sourceTemplateId", p.sourceTemplateId);
    const botDir = path.join(this.d.cfg.dataRoot, "agents", id);
    // I10: facts go through the memory store, after the secret scanner's redaction.
    //
    // Bug 44(b): the preview listed these facts to the user by name, so a Bot that starts without
    // them is a broken promise. `remember` now reports whether the fact landed; a refusal is
    // retried straight into the profile file the memory store itself reads, and a fact that fails
    // even that is the one thing the user has to be told about.
    const lost: string[] = [];
    for (const f of m.memories) {
      const fact = this.d.redact ? this.d.redact(id, f) : f;
      if (this.d.remember?.(id, fact)) continue;
      try {
        const file = path.join(botDir, "memory", "profile.md");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const head = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\n?$/, "\n") : "# Profile\n";
        fs.writeFileSync(file, `${head}- (${new Date(this.d.now()).toISOString().slice(0, 10)}) ${fact}\n`);
      } catch (e) {
        lost.push(fact);
        log.warn("template fact not saved", { botId: id, error: String(e) });
      }
    }
    if (lost.length) this.d.notify?.({ botId: id, title: STR5.templateFactsLost(m.profile.name), detail: STR5.templateFactsLostDetail(lost.length) });
    for (const r of m.routines) {
      writeJsonAtomic(path.join(botDir, "automations", randomUUID(), "automation.json"), { name: r.name, prompt: r.prompt, ...(r.schedule ? { schedule: r.schedule } : {}), enabled: false, createdAt: this.d.now() }, 0o640);
    }
    // I10: only the skills the preview listed (the manifest), each into a fresh folder — never over an existing one.
    //
    // Controller ruling: ~/.claude/skills is box:bots 2775 -- box-writable by a Bot too -- so this
    // must not write it with the host's own fs calls, the same as SkillLibrary.write()/writeHelper().
    // In production (cfg.brain === "claude") it routes through writeSkillFileNoClobber/
    // writeSkillHelperFileNoClobber (skills/skill-box-ops.ts): the "never over an existing one"
    // guarantee the old `fs.writeFileSync(..., { flag: "wx" })` gave is preserved by the box
    // helpers' own --no-clobber mode (publish with `ln`, which fails if the target already exists),
    // not just by the (still fs.existsSync, read-only, fine to keep) dest-name collision loop below.
    // The "fake" brain local/dev fallback (no box, no adversarial Bot) keeps the old plain-fs path.
    const prefix = slugify(m.profile.name);
    const listed = new Set(m.skills.map((s) => s.id));
    const skillsRoot = path.join(this.d.cfg.claudeConfigDir, "skills");
    const boxRouted = this.d.cfg.brain === "claude";
    for (const [skillId, files] of Object.entries(p.pack.skills)) {
      if (!listed.has(skillId)) continue;
      const base = `${prefix}--${slugify(skillId)}`;
      let dest = path.join(skillsRoot, base);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(skillsRoot, `${base}-${n}`);
      const destId = path.basename(dest);
      if (!boxRouted) fs.mkdirSync(dest, { recursive: true });
      for (const [rel, bytes] of Object.entries(files)) {
        const text = Buffer.from(bytes).toString("utf8");
        const isSkillMd = rel === "SKILL.md";
        const content = isSkillMd ? withSourceMetadata(text, `template:${m.profile.name}`) : text;
        if (boxRouted) {
          if (isSkillMd) writeSkillFileNoClobber(destId, content);
          else writeSkillHelperFileNoClobber(destId, path.basename(rel), content);
        } else {
          fs.writeFileSync(path.join(dest, path.basename(rel)), content, { flag: "wx" });
        }
      }
    }
    // I9: a file import is saved as a local template only once the user adds it.
    if (p.sourceTemplateId.startsWith("tpl:") && !this.d.packager.list().some((t) => `tpl:${t.id}` === p.sourceTemplateId)) {
      const dest = path.join(this.d.packager.templatesDir, p.pack.template.id, "template.json");
      if (!fs.existsSync(dest)) writeJsonAtomic(dest, p.pack.template, 0o640);
    }
    this.d.kickstart(id);
    return { id };
  }
}

export function importHandlers(importer: TemplateImporter): Partial<CommandHandlers> {
  return {
    previewTemplateImport: (a) => importer.preview(a),
    importTemplate: (a) => importer.import(a.token),
    listStarterTemplates: () => ({ starters: importer.starterViews() }),
  };
}
