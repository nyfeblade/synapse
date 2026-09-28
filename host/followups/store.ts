import fs from "node:fs";
import path from "node:path";
import { LIMITS5 } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface Followup { id: string; what: string; dueAt: number; createdAt: number; sourceEntryId: string | null; status: "open" | "done" | "dropped"; attempts: number }

export const FOLLOWUP_EXTRACTION_RULE =
  "followup: something the assistant promised to do later, or a question to the user that is still unanswered and matters, with the local date and time it should be revisited. Only for real commitments or open threads, never for small talk.";

function offset(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}

export function localToEpoch(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return Number.NaN;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return asUtc - offset(asUtc - offset(asUtc, tz), tz);
}

export function formatLocal(ms: number, tz: string): string {
  return new Date(ms + offset(ms, tz)).toISOString().slice(0, 16).replace("T", " ");
}

export function parseFollowupLine(line: string, tz: string): { dueAt: number; what: string } | null {
  const m = /^followup:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s*\|\s*(.+)$/.exec(line.trim());
  if (!m) return null;
  const dueAt = localToEpoch(m[1]!, tz);
  return Number.isNaN(dueAt) ? null : { dueAt, what: m[2]!.trim().slice(0, LIMITS5.followupWhatMax) };
}

export class FollowupStore {
  /** optedIn: P5 review minor — a follow-up is saved only for a Bot that turned proactive follow-ups on. */
  constructor(private dataRoot: string, private now: () => number, private optedIn?: (botId: string) => boolean) {}
  private file(botId: string): string { return path.join(this.dataRoot, "agents", botId, "followups.json"); }
  list(botId: string): Followup[] { return readJson<Followup[]>(this.file(botId), []); }
  private save(botId: string, list: Followup[]): void { writeJsonAtomic(this.file(botId), list, 0o640); }
  open(botId: string): Followup[] { return this.list(botId).filter((f) => f.status === "open"); }

  add(botId: string, a: { what: string; dueAt: number; sourceEntryId?: string | null }): Followup {
    if (this.optedIn && !this.optedIn(botId)) throw new Error("Proactive follow-ups are off for this Bot; the user can turn them on in its settings.");
    const list = this.list(botId);
    const n = list.reduce((mx, f) => Math.max(mx, Number(f.id.slice(1)) || 0), 0) + 1;
    const f: Followup = { id: `f${n}`, what: a.what.slice(0, LIMITS5.followupWhatMax), dueAt: a.dueAt, createdAt: this.now(), sourceEntryId: a.sourceEntryId ?? null, status: "open", attempts: 0 };
    list.push(f);
    const open = list.filter((x) => x.status === "open");
    for (const old of open.slice(0, Math.max(0, open.length - LIMITS5.followupMaxOpen))) old.status = "dropped";
    this.save(botId, list.slice(-500));
    return f;
  }

  mark(botId: string, id: string, status: "done" | "dropped"): boolean {
    const list = this.list(botId);
    const f = list.find((x) => x.id === id && x.status === "open");
    if (!f) return false;
    f.status = status;
    this.save(botId, list);
    return true;
  }

  attempt(botId: string, ids: string[]): void {
    const list = this.list(botId);
    for (const f of list) if (ids.includes(f.id) && f.status === "open") f.attempts += 1;
    this.save(botId, list);
  }

  /** I12: a deleted Bot's follow-ups go. */
  dropBot(botId: string): void {
    fs.rmSync(this.file(botId), { force: true });
  }

  due(botId: string): Followup[] {
    return this.open(botId).filter((f) => f.dueAt <= this.now() && f.attempts < LIMITS5.followupMaxAttempts);
  }

  ingestExtractionOutput(botId: string, raw: string, tz: string, sourceEntryId: string | null): number {
    let n = 0;
    for (const line of raw.split("\n")) {
      const p = parseFollowupLine(line, tz);
      if (p) { try { this.add(botId, { ...p, sourceEntryId }); n++; } catch { return n; } }
    }
    return n;
  }
}
