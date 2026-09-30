import fs from "node:fs";
import { writeFileAtomic } from "../atomic-file";

/**
 * 👍/👎 on a Bot's replies and finished tasks. Kept in one small file in the app's data folder and
 * shown as a count in each Bot's settings. Never sent anywhere.
 */
export type Rating = 1 | -1;
export type RatingKind = "reply" | "task";
interface Row { r: Rating; k: RatingKind; at: number }
interface File { v: 1; bots: Record<string, Record<string, Row>> }

const KEEP_PER_BOT = 2000;
const ID = /^[\w.:-]{1,200}$/;

export class RatingsStore {
  constructor(private file: string, private now: () => number = Date.now) {}

  private read(): File {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as File;
      if (j && j.v === 1 && j.bots && typeof j.bots === "object") return j;
    } catch { /* none yet, or unreadable: start over */ }
    return { v: 1, bots: {} };
  }

  /** One Bot's ratings by entry id, plus the counts. */
  get(botId: string): { ratings: Record<string, Rating>; up: number; down: number } {
    const rows = this.read().bots[botId] ?? {};
    const ratings: Record<string, Rating> = {};
    let up = 0, down = 0;
    for (const [id, row] of Object.entries(rows)) {
      ratings[id] = row.r;
      if (row.r === 1) up++; else down++;
    }
    return { ratings, up, down };
  }

  /** 0 clears the rating. */
  set(botId: string, entryId: string, kind: RatingKind, value: Rating | 0): { ratings: Record<string, Rating>; up: number; down: number } {
    if (!ID.test(botId) || !ID.test(entryId)) throw new Error("That can't be rated.");
    if (value !== 1 && value !== -1 && value !== 0) throw new Error("That can't be rated.");
    const f = this.read();
    const rows = { ...(f.bots[botId] ?? {}) };
    if (value === 0) delete rows[entryId];
    else rows[entryId] = { r: value, k: kind === "task" ? "task" : "reply", at: this.now() };
    const sorted = Object.entries(rows).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_PER_BOT);
    f.bots[botId] = Object.fromEntries(sorted);
    writeFileAtomic(this.file, JSON.stringify(f), 0o600);
    return this.get(botId);
  }
}
