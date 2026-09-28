import { LIMITS, type Chain, type ChainRootKind, type LoopDetector } from "@synapse/shared";
import type { TurnUsage } from "../brain/types";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { newChainId } from "./ids";

interface File { version: 1; chains: Chain[] }

/** ORIG-09 L6: uncached input + 0.1 × cache read + 1.25 × cache write + 5 × output. */
export function weightedTokens(u: TurnUsage): number {
  return u.inputTokens + 0.1 * u.cacheReadTokens + 1.25 * u.cacheWriteTokens + 5 * u.outputTokens;
}

/** ORIG-09 §09.5: chains for accounting and loop detection; `chains.json`, LRU 500, expiry 24 h after the last activity. */
export class ChainStore {
  private chains = new Map<string, Chain>();

  constructor(private file: string, private now: () => number = Date.now) {
    for (const c of readJson<File>(file, { version: 1, chains: [] }).chains) this.chains.set(c.chainId, c);
    this.prune();
  }

  start(rootKind: ChainRootKind, rootBotId: string, extra: { groupId?: string } = {}): Chain {
    const t = this.now();
    const c: Chain = { chainId: newChainId(), rootKind, rootBotId, rootAt: t, hops: 0, peerTurns: 0, weightedTokens: 0, costUsd: 0, lastActivityAt: t, ...(extra.groupId ? { groupId: extra.groupId } : {}) };
    this.chains.set(c.chainId, c);
    this.prune();
    this.save();
    return c;
  }

  get(chainId: string): Chain | null {
    const c = this.chains.get(chainId);
    if (!c) return null;
    if (this.now() - c.lastActivityAt > LIMITS.chainExpiryMs) {
      this.chains.delete(chainId);
      this.save();
      return null;
    }
    return c;
  }

  hop(chainId: string): Chain {
    return this.touch(chainId, (c) => { c.hops += 1; });
  }

  addPeerTurn(chainId: string, u: TurnUsage): Chain {
    return this.touch(chainId, (c) => {
      c.peerTurns += 1;
      c.weightedTokens += weightedTokens(u);
      c.costUsd += u.costUsd ?? 0;
    });
  }

  end(chainId: string, detector: LoopDetector): void {
    if (!this.chains.has(chainId)) return;
    this.touch(chainId, (c) => { c.ended = { detector, at: this.now() }; });
  }

  prune(): void {
    const t = this.now();
    for (const [id, c] of this.chains) if (t - c.lastActivityAt > LIMITS.chainExpiryMs) this.chains.delete(id);
    const byRecent = [...this.chains.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const c of byRecent.slice(LIMITS.chainsLru)) this.chains.delete(c.chainId);
  }

  private touch(chainId: string, f: (c: Chain) => void): Chain {
    const c = this.chains.get(chainId);
    if (!c) throw new Error(`unknown chain ${chainId}`);
    f(c);
    c.lastActivityAt = this.now();
    this.save();
    return c;
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, chains: [...this.chains.values()] } satisfies File, 0o600);
  }
}
