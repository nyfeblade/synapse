/**
 * Portable install, fix round 1: the ONE lock every operation on the Bots' computer takes — the background
 * re-provision, setup (first run or reopened from Settings), and Settings → Update / Recover / Reset. They are
 * mutually exclusive: a second is refused with the name of the one running, never run alongside it (two
 * provisions would kill each other's apt; an Update mid-provision would delete the machine under it).
 */
export class BoxOpsLock {
  private current: { name: string; token: symbol } | null = null;

  /** The operation holding the lock, or null. */
  holder(): string | null {
    return this.current?.name ?? null;
  }

  /** Take the lock; null when another operation has it. The returned release frees only this holder's lock. */
  tryAcquire(name: string): (() => void) | null {
    if (this.current) return null;
    const token = Symbol(name);
    this.current = { name, token };
    return () => { if (this.current?.token === token) this.current = null; };
  }
}

/** What a refused operation tells the user. */
export const BOX_BUSY_NAMES: Record<string, string> = {
  "re-provision": "The Bots' computer is being updated.",
  setup: "The Bots' computer is being set up.",
  update: "The Bots' computer is being rebuilt.",
  recover: "The Bots' computer is restarting.",
  reset: "The Bots' computer is being reset.",
};
export function boxBusyMessage(holder: string | null): string {
  return (holder && BOX_BUSY_NAMES[holder]) || "Another operation on the Bots' computer is running.";
}
