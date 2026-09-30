import { readJson, writeJsonAtomic } from "../util/atomic-json";

export type CardRef = { botId: string; entryId: string };

/**
 * 0.1.4 first-run (code audit 2.3): which chat card shows which coding agent. It lived only in memory, so after a
 * host restart the agent was marked interrupted but its card had no id to update and said "Working" for good. Kept
 * on disk now (written only when a card is added or dropped), so the boot sweep can settle every card.
 */
export class CodingCardIds extends Map<string, CardRef> {
  private file: string | null = null;
  constructor(file: string) {
    super();
    for (const [k, v] of Object.entries(readJson<Record<string, CardRef>>(file, {}))) super.set(k, v);
    this.file = file;
  }
  override set(k: string, v: CardRef): this {
    super.set(k, v);
    this.save();
    return this;
  }
  override delete(k: string): boolean {
    const had = super.delete(k);
    if (had) this.save();
    return had;
  }
  private save(): void {
    if (!this.file) return; // still loading
    // The newest 500 cards: an old agent's card id is only needed until that agent has settled.
    writeJsonAtomic(this.file, Object.fromEntries([...this.entries()].slice(-500)), 0o600);
  }
}
