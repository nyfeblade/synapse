import { describe, expect, it } from "vitest";
import { LruCache } from "../src/cache";

describe("LruCache", () => {
  it("stores and returns values", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.get("zz")).toBeUndefined();
    expect(c.size).toBe(1);
  });
  it("evicts when full", () => {
    const c = new LruCache<string, number>(2);
    c.set("a", 1).set("b", 2).set("c", 3);
    expect(c.size).toBe(2);
    expect(c.has("c")).toBe(true);
  });
  it("rejects a bad capacity", () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});
