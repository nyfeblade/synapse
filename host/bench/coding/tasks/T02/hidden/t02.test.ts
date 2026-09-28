import { expect, it } from "vitest";
import { allocate, sumCents } from "../src/money";

it("hands leftover cents to the FIRST shares, one each (the documented contract)", () => {
  expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  expect(allocate(101, [1, 1, 1])).toEqual([34, 34, 33]);
  expect(allocate(5, [1, 1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 0, 0]);
  // floors 142, 285, 571 = 998; 2 left over go to shares 0 and 1.
  expect(allocate(1000, [1, 2, 4])).toEqual([143, 286, 571]);
});

it("mirrors negative totals exactly", () => {
  expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  expect(allocate(-1000, [1, 2, 4])).toEqual([-143, -286, -571]);
});

it("leaves exact splits alone and always sums to the total", () => {
  expect(allocate(90, [1, 2])).toEqual([30, 60]);
  expect(allocate(0, [1, 1])).toEqual([0, 0]);
  for (const total of [1, 7, 99, 12345, -12345]) {
    for (const ratios of [[1], [1, 1], [3, 7], [1, 1, 1, 1], [5, 3, 2, 9]]) {
      expect(sumCents(allocate(total, ratios))).toBe(total);
    }
  }
});
