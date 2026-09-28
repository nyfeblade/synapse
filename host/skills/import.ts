import { LIMITS } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { parseSkill } from "./skill-file";

export function markdownToSkill(md: string, fallbackName = "Imported skill"): { name: string; description: string; body: string } {
  const s = parseSkill(md);
  if (s.name && s.description) return { name: s.name, description: s.description.trim(), body: s.body };
  const heading = /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
  const para = md.split(/\n{2,}/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("---")) ?? "";
  return { name: (s.name || heading || fallbackName).slice(0, LIMITS.skillNameMax), description: (s.description || para.replace(/\s+/g, " ")).slice(0, LIMITS.skillDescriptionMax) || `Use this when the user asks for ${heading ?? fallbackName}.`, body: s.name ? s.body : md };
}

export async function fetchSkillText(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new GatewayError("BAD_URL", "Skills can be imported only from http or https URLs.");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetchFn(url, { signal: ac.signal, redirect: "follow" });
    if (!r.ok) throw new GatewayError("FETCH_FAILED", `Couldn't fetch the skill (HTTP ${r.status}).`);
    const text = await r.text();
    if (text.length > LIMITS.skillImportMaxBytes) throw new GatewayError("TOO_LARGE", "That file is too large for a skill.");
    return text;
  } finally {
    clearTimeout(t);
  }
}
