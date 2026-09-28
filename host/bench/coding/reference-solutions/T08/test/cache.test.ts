import { describe, expect, it } from "vitest";
import { LruCache } from "../src/cache";

const filled = () => new LruCache<string, number>(2).set("a", 1).set("b", 2);

describe("LruCache", () => {
  it("stores and returns values", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.get("zz")).toBeUndefined();
    expect(c.size).toBe(1);
  });
  it("rejects a bad capacity", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
  it("lists keys from least to most recently used", () => {
    const c = new LruCache<string, number>(3).set("a", 1).set("b", 2).set("c", 3);
    expect(c.keys()).toEqual(["a", "b", "c"]);
  });
  it("evicts the least recently used entry and counts it", () => {
    const c = filled().set("c", 3);
    expect(c.keys()).toEqual(["b", "c"]);
    expect(c.has("a")).toBe(false);
    expect(c.evicted).toBe(1);
    c.set("d", 4);
    expect(c.evicted).toBe(2);
  });
  it("get marks an entry most recently used", () => {
    const c = filled();
    c.get("a");
    c.set("c", 3);
    expect(c.keys()).toEqual(["a", "c"]);
  });
  it("has and peek do not change recency", () => {
    const c = filled();
    expect(c.has("a")).toBe(true);
    expect(c.peek("a")).toBe(1);
    expect(c.keys()).toEqual(["a", "b"]);
    c.set("c", 3);
    expect(c.keys()).toEqual(["b", "c"]);
  });
  it("updating an existing key replaces the value, marks it recent and never evicts", () => {
    const c = filled();
    c.set("a", 10);
    expect(c.size).toBe(2);
    expect(c.evicted).toBe(0);
    expect(c.keys()).toEqual(["b", "a"]);
    expect(c.peek("a")).toBe(10);
  });
  it("delete reports whether it removed something and is not an eviction", () => {
    const c = filled();
    expect(c.delete("zz")).toBe(false);
    expect(c.delete("a")).toBe(true);
    expect(c.size).toBe(1);
    expect(c.evicted).toBe(0);
  });
  it("clear empties the cache without counting evictions", () => {
    const c = filled();
    c.clear();
    expect(c.size).toBe(0);
    expect(c.keys()).toEqual([]);
    expect(c.evicted).toBe(0);
  });
});
