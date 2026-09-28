import { afterEach, describe, expect, it, vi } from "vitest";
import { treeRss } from "../../supervisor/rss";
import { log } from "../../util/log";

describe("treeRss without /proc (review fix round 1)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reads 0 instead of throwing, and says so once, not every tick", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(treeRss(1, "/definitely/not/proc")).toBe(0);
    expect(treeRss(1, "/definitely/not/proc")).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
