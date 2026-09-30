import path from "node:path";
import type { HostConfig } from "../config";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

/**
 * Bot sharing (security review, HIGH): the skills folder is shared by every Bot, so a skill that arrived with a
 * third-party Bot (a share link, the website, someone else's .botpack) belongs to that Bot only. The record is the
 * host's own file in the data root, never the skill's metadata, which a Bot can edit. SkillLibrary.disabledFor()
 * reads it, so the catalog, the Skill tool's opt-out and every Bot made later leave these skills alone.
 */
const file = (cfg: Pick<HostConfig, "dataRoot">) => path.join(cfg.dataRoot, "third-party-skills.json");

/** skill id → the one Bot it belongs to. */
export function thirdPartySkillOwners(cfg: Pick<HostConfig, "dataRoot">): Record<string, string> {
  const v = readJson<Record<string, unknown>>(file(cfg), {});
  return Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function recordThirdPartySkills(cfg: Pick<HostConfig, "dataRoot">, skillIds: string[], botId: string): void {
  if (!skillIds.length) return;
  const cur = thirdPartySkillOwners(cfg);
  for (const id of skillIds) cur[id] = botId;
  writeJsonAtomic(file(cfg), cur, 0o640);
}

/** The third-party skills that belong to some other Bot than `botId`. */
export function othersThirdPartySkills(cfg: Pick<HostConfig, "dataRoot">, botId: string): string[] {
  return Object.entries(thirdPartySkillOwners(cfg)).filter(([, owner]) => owner !== botId).map(([id]) => id);
}
