import path from "node:path";
import { LIMITS } from "@synapse/shared";
import { dedupeKey, importanceOf, type Fact } from "./facts";
import type { MemoryStore } from "./memory-store";

const DAY = 86_400_000;
const rank = (f: Fact) => Math.log2(importanceOf(f.kind)) + f.createdAt / DAY / 30;
const prefix = (f: Fact) => (f.kind === "note" ? "[note] " : f.kind === "episode" ? "[episode] " : "");
const line = (f: Fact, via?: string) => `- (learned ${f.date}) ${via ? `[via ${via}] ` : ""}${prefix(f)}${f.content}`;

/** Takes lines in order until the next would pass the char budget; returns the lines and how many were left out. */
function budget(lines: string[], maxChars: number): { shown: string[]; more: number } {
  const shown: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    shown.push(l);
    used += l.length + 1;
  }
  return { shown, more: lines.length - shown.length };
}

export function renderMemorySection(d: { store: MemoryStore; botId: string; nameOf(botId: string): string; dataRoot: string }): { text: string; ids: string[] } {
  const ids: string[] = [];
  const own = d.store.all({ kind: "agent", botId: d.botId });
  const ownKeys = new Set(own.map((f) => dedupeKey(f.content)));
  const projects = d.store.projects(d.botId);
  const projectFacts = projects.slice(0, LIMITS.memProjectsMax).map((slug) => ({ slug, facts: d.store.all({ kind: "project", botId: d.botId, slug }).filter((f) => !ownKeys.has(dedupeKey(f.content))) }));
  const projectKeys = new Set(projectFacts.flatMap((p) => p.facts.map((f) => dedupeKey(f.content))));
  const sections: string[] = [];

  // user memory: every Bot's shard, ranked; own > project > user
  const userFacts = d.store.userShardOwners().flatMap((owner) => d.store.all({ kind: "user", botId: owner }).map((f) => ({ f, owner })))
    .filter(({ f }) => !ownKeys.has(dedupeKey(f.content)) && !projectKeys.has(dedupeKey(f.content)))
    .sort((a, b) => rank(b.f) - rank(a.f));
  if (userFacts.length) {
    const prof = userFacts.filter((x) => x.f.tier === "profile").slice(0, LIMITS.memUserProfileMax);
    const rec = userFacts.filter((x) => x.f.tier === "log").slice(0, LIMITS.memUserRecentMax);
    const p = budget(prof.map((x) => line(x.f, d.nameOf(x.owner))), LIMITS.memUserProfileChars);
    const r = budget(rec.map((x) => line(x.f, d.nameOf(x.owner))), LIMITS.memUserRecentChars);
    [...prof.slice(0, p.shown.length), ...rec.slice(0, r.shown.length)].forEach((x) => ids.push(x.f.id));
    const more = userFacts.length - p.shown.length - r.shown.length;
    sections.push(["## About the user (shared by all your teammates)", ...p.shown, ...r.shown, ...(more > 0 ? [`(${more} more user facts on disk — grep ${path.join(d.dataRoot, "user-memory")})`] : [])].join("\n"));
  }

  // Memory provenance: team knowledge, every Bot's team shard (one small section; the rest is found by recall and SearchHistory).
  const teamFacts = d.store.teamShardOwners().flatMap((owner) => d.store.all({ kind: "team", botId: owner }).map((f) => ({ f, owner })))
    .filter(({ f }) => !ownKeys.has(dedupeKey(f.content)))
    .sort((a, b) => (a.f.tier === b.f.tier ? rank(b.f) - rank(a.f) : a.f.tier === "profile" ? -1 : 1))
    .slice(0, LIMITS.memUserRecentMax);
  if (teamFacts.length) {
    const t = budget(teamFacts.map((x) => line(x.f, x.owner === d.botId ? undefined : d.nameOf(x.owner))), LIMITS.memUserRecentChars);
    teamFacts.slice(0, t.shown.length).forEach((x) => ids.push(x.f.id));
    const more = d.store.teamShardOwners().reduce((n, o) => n + d.store.all({ kind: "team", botId: o }).length, 0) - t.shown.length;
    sections.push(["## Team knowledge (shared by all your teammates)", ...t.shown, ...(more > 0 ? [`(${more} more team facts — SearchHistory finds them)`] : [])].join("\n"));
  }

  for (const { slug, facts } of projectFacts) {
    if (!facts.length) continue;
    const prof = facts.filter((f) => f.tier === "profile").slice(-LIMITS.memProjectProfileMax);
    const rec = facts.filter((f) => f.tier === "log").slice(-LIMITS.memProjectRecentMax).reverse();
    const p = budget(prof.map((f) => line(f)), LIMITS.memProjectProfileChars);
    const r = budget(rec.map((f) => line(f)), LIMITS.memProjectRecentChars);
    [...prof.slice(0, p.shown.length), ...rec.slice(0, r.shown.length)].forEach((f) => ids.push(f.id));
    const more = facts.length - p.shown.length - r.shown.length;
    sections.push([`## Project: ${slug}`, ...p.shown, ...r.shown, ...(more > 0 ? [`(${more} more project facts on disk — grep ${path.join(d.dataRoot, "projects", slug, "memory")})`] : [])].join("\n"));
  }
  if (projects.length > LIMITS.memProjectsMax) sections.push(`Also a member of: ${projects.slice(LIMITS.memProjectsMax).join(", ")}`);

  if (own.length) {
    const prof = own.filter((f) => f.tier === "profile").slice(-LIMITS.memAgentProfileMax);
    const logs = own.filter((f) => f.tier === "log");
    const rec = logs.slice(-LIMITS.memAgentRecentMax).reverse();
    const r = budget(rec.map((f) => line(f)), LIMITS.memAgentRecentChars);
    prof.forEach((f) => ids.push(f.id));
    rec.slice(0, r.shown.length).forEach((f) => ids.push(f.id));
    const more = own.length - prof.length - r.shown.length;
    sections.push([
      "## Your memory", ...prof.map((f) => line(f)),
      ...(r.shown.length ? ["### Recent", ...r.shown] : []),
      // Bug #61: the Bot folder is host-private; the rest of the Bot's own memory is found with SearchHistory.
      ...(more > 0 ? [`(${more} more facts — SearchHistory finds them)`] : []),
    ].join("\n"));
  }
  if (!sections.length) return { text: "# Memory\n(nothing remembered yet)", ids };
  return { text: ["# Memory", "What you've learned. Newer facts may be missing here; search them when it matters. When facts conflict: your own > project > user.", ...sections].join("\n\n"), ids };
}
