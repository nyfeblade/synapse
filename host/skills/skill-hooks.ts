import { LIMITS } from "@synapse/shared";
import type { TurnHooks } from "../runner/hooks";
import type { SkillLibrary } from "./library";

export function expansionText(library: SkillLibrary, id: string): string | null {
  const r = library.read(id);
  if (!r) return null;
  const body = r.file.body.length > LIMITS.skillInjectMax ? `${r.file.body.slice(0, LIMITS.skillInjectMax)}\n…(truncated; read the rest in SKILL.md)` : r.file.body;
  const helpers = library.helperFiles(id);
  return [
    `The user invoked the "${r.file.name}" workflow (skill ${id}). Run it now.`,
    `What it does: ${r.file.description.trim()}`,
    "Recipe to follow:",
    body.endsWith("\n") ? body : `${body}\n`,
    `This workflow's helper files are in ${r.dir}: ${helpers.length ? helpers.join(", ") : "(none)"}`,
    "Carry out the recipe now, using the user's message below as its input.",
  ].join("\n");
}

export function skillCatalog(library: SkillLibrary, botId: string): string {
  const off = new Set(library.disabledFor(botId));
  const lines = library.ids().filter((id) => !off.has(id)).slice(0, 100).map((id) => {
    const r = library.read(id)!;
    return `- ${r.file.name} — ${r.file.description.replace(/\s+/g, " ").trim().slice(0, 200)} (${r.dir}/SKILL.md)`;
  });
  if (!lines.length) return "";
  return ["# Skills", "Saved recipes shared by all Bots. When a task matches one, load it with the Skill tool, or read its SKILL.md.", ...lines].join("\n");
}

export function createSkillHooks(d: { library: SkillLibrary }): TurnHooks {
  return {
    decorateUserMessage: (_botId, entry) => ({
      before: (entry.skillIds ?? []).map((id) => expansionText(d.library, id)).filter((t): t is string => Boolean(t)).map((text) => ({ text })),
      after: [],
    }),
    promptSections: (botId) => ({ memory: "", skills: skillCatalog(d.library, botId) }),
  };
}
