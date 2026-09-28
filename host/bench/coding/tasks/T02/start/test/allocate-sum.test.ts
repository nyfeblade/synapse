import { expect, it } from "vitest";
import { allocate, sumCents } from "../src/money";

it("allocated shares always add up to the total", () => {
  expect(sumCents(allocate(100, [1, 1, 1]))).toBe(100);
  expect(sumCents(allocate(1000, [1, 2, 4]))).toBe(1000);
});
