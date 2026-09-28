import { readJson, writeJsonAtomic } from "../util/atomic-json";

interface File { version: 1; createdAt: Record<string, number[]> }

const DAY_MS = 86_400_000;

/**
 * ORIG-17: durable per-Bot creation timestamps for CreateAgent's hourly/daily runaway cap.
 * Keyed by the *creating* Bot's id, so the cap survives a Claude process respawn (the
 * in-process createBotTools closure is rebuilt on every spawn; this ledger is not).
 */
export class CreationLedger {
  private byBot = new Map<string, number[]>();

  constructor(private file: string, private now: () => number = Date.now) {
    const data = readJson<File>(file, { version: 1, createdAt: {} });
    for (const [botId, ts] of Object.entries(data.createdAt)) this.byBot.set(botId, ts);
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, createdAt: Object.fromEntries(this.byBot) } satisfies File, 0o600);
  }

  /** Count of Bots this botId has created within the trailing `windowMs`. */
  countSince(botId: string, windowMs: number): number {
    const t = this.now();
    return (this.byBot.get(botId) ?? []).filter((x) => t - x < windowMs).length;
  }

  /** Records a creation now, pruning entries older than 24h on each write. */
  record(botId: string): void {
    const t = this.now();
    const kept = (this.byBot.get(botId) ?? []).filter((x) => t - x < DAY_MS);
    kept.push(t);
    this.byBot.set(botId, kept);
    this.save();
  }
}
