import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CatalogAuthor, TemplateManifest, TemplateRecord } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { HostConfig } from "../config";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { slugify } from "../util/text";
import { writeBotpack } from "./botpack";
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
    const skillsRoot = path.join(this.d.cfg.claudeConfigDir, "skills");
    const skills = (fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : []).sort().flatMap((id) => {
      const md = path.join(skillsRoot, id, "SKILL.md");
      if (disabled.has(id) || !fs.existsSync(md)) return [];
      const fm = frontMatter(fs.readFileSync(md, "utf8"));
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
      const dir = path.join(skillsRoot, s.id);
      if (!fs.existsSync(dir)) continue;
      skills[s.id] = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f, new Uint8Array(fs.readFileSync(path.join(dir, f)))]));
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const bytes = writeBotpack({ template, skills, memoriesMd: manifest.memories.map((m) => `- (${today}) ${m}`).join("\n") + (manifest.memories.length ? "\n" : ""), avatar: this.avatar(botId) });
    this.d.onChange?.(); // the Marketplace search index lists local templates (Task 34 fuzz)
    return { template, fileName: `${slugify(template.name)}.botpack`, bytes };
  }

  get(botId: string): TemplateRecord | null {
    const id = this.d.bots.require(botId).store.getKv<string | null>("templateId", null);
    return id ? readJson<TemplateRecord | null>(path.join(this.templatesDir, id, "template.json"), null) : null;
  }

  list(): TemplateRecord[] {
    if (!fs.existsSync(this.templatesDir)) return [];
    return fs.readdirSync(this.templatesDir).map((id) => readJson<TemplateRecord | null>(path.join(this.templatesDir, id, "template.json"), null)).filter((t): t is TemplateRecord => !!t);
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
