import { createHash } from "node:crypto";
import { LIMITS } from "@synapse/shared";

export type FactKind = "fact" | "note" | "episode";
export type Tier = "profile" | "log";
export interface Fact { id: string; date: string; kind: FactKind; content: string; tier: Tier; createdAt: number }

export const PROFILE_HEADER = "# About the user\n<!-- Enduring facts, one per line: - (YYYY-MM-DD) fact. Written by the app and the Bot; edit with care. -->\n";
export const LOG_HEADER = "# Memory log\n<!-- Dated facts, one per line: - (YYYY-MM-DD) fact. [note] lines fade fastest; [episode] lines are journal entries. -->\n";
const LINE = /^- \((\d{4}-\d{2}-\d{2})\) (?:(\[note\]|\[episode\]) )?(.+)$/;
const DAY = 86_400_000;

export function normalizeFact(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, LIMITS.memoryFactMax);
}
export function dedupeKey(content: string): string {
  return normalizeFact(content).toLowerCase();
}
export function factId(content: string): string {
  return createHash("sha1").update(dedupeKey(content)).digest("hex").slice(0, 16);
}
export function renderLine(f: { date: string; kind: FactKind; content: string }): string {
  const prefix = f.kind === "note" ? "[note] " : f.kind === "episode" ? "[episode] " : "";
  return `- (${f.date}) ${prefix}${normalizeFact(f.content)}`;
}
export function parseFacts(text: string, tier: Tier): Fact[] {
  const out: Fact[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const kind: FactKind = m[2] === "[note]" ? "note" : m[2] === "[episode]" ? "episode" : "fact";
    const content = normalizeFact(m[3]!);
    out.push({ id: factId(content), date: m[1]!, kind, content, tier, createdAt: Date.parse(`${m[1]}T00:00:00Z`) });
  }
  return out;
}
export const monthOf = (date: string): string => date.slice(0, 7);
export function isoDate(ms: number, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
export function importanceOf(kind: FactKind): number {
  return kind === "episode" ? 1.5 : kind === "note" ? 0.5 : 1;
}
/** ORIG-05 §05.4: importance · 0.5^(ageDays/30) from max(createdAt, confirmedAt); profile facts are 1 forever. */
export function strength(f: Fact, meta: { confirmedAt?: number }, now: number): number {
  if (f.tier === "profile") return 1;
  const from = Math.max(f.createdAt, meta.confirmedAt ?? 0);
  return importanceOf(f.kind) * 0.5 ** (Math.max(0, now - from) / DAY / 30);
}
