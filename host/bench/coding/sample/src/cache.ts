/**
 * A least-recently-used cache. `get` and `set` mark an entry as most recently used; `has` and
 * `peek` do not. When a `set` of a NEW key would exceed the capacity, the least recently used
 * entry is evicted first. Updating an existing key never evicts.
 */
export class LruCache<K, V> {
  private map = new Map<K, V>();
  private evictions = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }

  get size(): number {
    return this.map.size;
  }

  /** How many entries have been evicted since construction (not counting delete/clear). */
  get evicted(): number {
    return this.evictions;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
      this.evictions++;
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return [...this.map.keys()];
  }
}
