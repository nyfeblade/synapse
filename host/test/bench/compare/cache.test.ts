import { describe, expect, it } from "vitest";
import { PromptCache, weighted } from "../../../bench/compare/cache";
import { TTL_1H, TTL_5M } from "../../../bench/compare/params";

const seg = (id: string, tokens: number) => ({ id, tokens });
const MIN = 60_000;

describe("prompt cache model", () => {
  it("explicit mode writes every uncached token; automatic mode bills it as fresh", () => {
    const p = [seg("tools", 1000), seg("sys", 500), seg("m1", 100)];
    expect(new PromptCache("explicit", TTL_5M).call(p, 0)).toEqual({ fresh: 0, write: 1600, read: 0 });
    expect(new PromptCache("automatic", TTL_5M).call(p, 0)).toEqual({ fresh: 1600, write: 0, read: 0 });
  });

  it("reads the previous prompt as a prefix and writes only the appended part", () => {
    const c = new PromptCache("explicit", TTL_5M);
    c.call([seg("tools", 1000), seg("m1", 100)], 0);
    expect(c.call([seg("tools", 1000), seg("m1", 100), seg("m2", 50)], MIN)).toEqual({ fresh: 0, write: 50, read: 1100 });
  });

  it("expires after the TTL, and a read refreshes it", () => {
    const c = new PromptCache("explicit", TTL_5M);
    const p = [seg("tools", 1000)];
    c.call(p, 0);
    for (let t = 4; t <= 20; t += 4) expect(c.call(p, t * MIN).read, `warm at ${t} min`).toBe(1000);
    expect(c.call(p, 26 * MIN)).toEqual({ fresh: 0, write: 1000, read: 0 });
  });

  it("a 1-hour TTL survives a 30-minute gap that a 5-minute one does not", () => {
    const p = [seg("tools", 1000)];
    const five = new PromptCache("explicit", TTL_5M), hour = new PromptCache("explicit", TTL_1H);
    five.call(p, 0); hour.call(p, 0);
    expect(five.call(p, 30 * MIN).read).toBe(0);
    expect(hour.call(p, 30 * MIN).read).toBe(1000);
  });

  it("a changed segment invalidates everything after it (memory refresh, compaction)", () => {
    const c = new PromptCache("explicit", TTL_5M);
    c.call([seg("tools", 1000), seg("mem@0", 300), seg("m1", 100)], 0);
    expect(c.call([seg("tools", 1000), seg("mem@1", 320), seg("sum@1", 200)], MIN)).toEqual({ fresh: 0, write: 520, read: 1000 });
  });

  it("weights fresh 1.0, a 5-minute write 1.25, a 1-hour write 2.0 and a read 0.1", () => {
    expect(weighted({ fresh: 100, write: 100, read: 1000 }, TTL_5M)).toBeCloseTo(100 + 125 + 100);
    expect(weighted({ fresh: 0, write: 100, read: 0 }, TTL_1H)).toBeCloseTo(200);
  });
});
