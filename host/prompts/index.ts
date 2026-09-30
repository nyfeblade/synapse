import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// In source, prompts live next to this file; build.mjs copies them next to dist/host.mjs.
const dir = () => process.env.PROMPTS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  const key = `${dir()}::${name}`;
  let text = cache.get(key);
  if (text === undefined) {
    text = fs.readFileSync(path.join(dir(), name), "utf8");
    cache.set(key, text);
  }
  return text;
}

/** New-user walk, finding 12: the skills the app itself ships (prompts/skills/<id>), never part of a user's template. */
export function builtInSkillIds(): string[] {
  try { return fs.readdirSync(path.join(dir(), "skills")); } catch { return []; }
}

export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`missing template var ${k}`);
    return vars[k] as string;
  });
}

export function promptVersion(name: string): string {
  return createHash("sha256").update(loadPrompt(name)).digest("hex").slice(0, 16);
}

export function clearPromptCache(): void {
  cache.clear();
}
