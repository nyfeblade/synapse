import { LIMITS } from "@synapse/shared";
import { parse, stringify } from "yaml";

export interface SkillFile { name: string; description: string; metadata: Record<string, unknown>; body: string; disableModelInvocation: boolean }

export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, LIMITS.skillIdMax).replace(/-+$/, "");
  return s || "skill";
}

export function parseSkill(md: string): SkillFile {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md.replace(/\r\n/g, "\n"));
  const fm = m ? ((parse(m[1]!) ?? {}) as Record<string, unknown>) : {};
  const body = m ? m[2]! : md;
  return {
    name: String(fm.name ?? "").trim(),
    description: typeof fm.description === "string" ? fm.description : "",
    metadata: (fm.metadata && typeof fm.metadata === "object" ? fm.metadata : {}) as Record<string, unknown>,
    body,
    disableModelInvocation: fm["disable-model-invocation"] === true,
  };
}

export function serializeSkill(s: SkillFile): string {
  const fm: Record<string, unknown> = { name: s.name, description: s.description };
  if (Object.keys(s.metadata).length) fm.metadata = s.metadata;
  if (s.disableModelInvocation) fm["disable-model-invocation"] = true;
  const body = s.body.endsWith("\n") ? s.body : `${s.body}\n`;
  return `---\n${stringify(fm).trimEnd()}\n---\n${body}`;
}

export function validateSkill(s: SkillFile): string | null {
  if (!s.name.trim()) return "A skill needs a name.";
  if (s.name.length > LIMITS.skillNameMax) return "A skill name can be at most 80 characters.";
  if (!s.description.trim()) return "A skill needs a description (start it with \"Use this when…\").";
  if (s.description.length > LIMITS.skillDescriptionMax) return "A skill description can be at most 1,536 characters.";
  if (s.body.length > LIMITS.skillBodyMax) return "A skill body can be at most 100,000 characters.";
  return null;
}
