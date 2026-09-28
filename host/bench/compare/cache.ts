import { WEIGHTS, writeWeight, type CacheMode } from "./params";

/** One content block of a prompt. Ids are unique per content: a re-rendered block gets a new id. */
export interface Seg { id: string; tokens: number }
export interface Input { fresh: number; write: number; read: number }

/**
 * Prefix prompt caching. A call reads the longest prefix of its prompt that matches the cached one
 * and has not expired; a read refreshes the TTL (Anthropic: "refreshed for no additional cost each
 * time the cached content is used" [documented]). The rest is written (explicit) or billed fresh
 * (automatic), and the whole prompt becomes the cache. One cache per prompt family (the chat, the
 * extractor, …). Simplifications: Anthropic's 20-block breakpoint lookback and minimum cacheable
 * length never bind at these sizes, so they are not modelled.
 */
export class PromptCache {
  private ids: string[] = [];
  private exp: number[] = [];
  constructor(private mode: CacheMode, private ttlMs: number) {}

  call(prompt: Seg[], t: number): Input {
    let read = 0, i = 0;
    while (i < prompt.length && i < this.ids.length && this.ids[i] === prompt[i]!.id && this.exp[i]! >= t) read += prompt[i++]!.tokens;
    let rest = 0;
    for (let j = i; j < prompt.length; j++) rest += prompt[j]!.tokens;
    this.ids = prompt.map((s) => s.id);
    this.exp = prompt.map(() => t + this.ttlMs);
    return this.mode === "explicit" ? { fresh: 0, write: rest, read } : { fresh: rest, write: 0, read };
  }
}

/** Cost-weighted input tokens: fresh 1.0, write 1.25 (5 min) or 2.0 (1 h), read 0.1. */
export function weighted(u: Input, ttlMs: number): number {
  return u.fresh * WEIGHTS.fresh + u.write * writeWeight(ttlMs) + u.read * WEIGHTS.read;
}
