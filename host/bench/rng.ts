/** Seeded, platform-independent PRNG (mulberry32). The benchmark never touches Math.random or the clock. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  weighted<T extends string>(w: Record<T, number>): T {
    const entries = Object.entries(w) as [T, number][];
    let r = this.next() * entries.reduce((a, [, v]) => a + v, 0);
    for (const [k, v] of entries) if ((r -= v) < 0) return k;
    return entries.at(-1)![0];
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
  /** A child stream, so adding draws in one part of the generator does not reshuffle another. */
  fork(tag: string): Rng {
    let h = this.s ^ 0x9e3779b9;
    for (const c of tag) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
    return new Rng(h);
  }
}
