import { describe, expect, it } from "vitest";
import { addMoney, allocate, formatMoney, MoneyError, multiply, parseMoney, percentOf, roundHalfAwayFromZero } from "../src/money";

describe("parseMoney", () => {
  it("parses plain, grouped, signed and symbol forms", () => {
    expect(parseMoney("12")).toBe(1200);
    expect(parseMoney("$12")).toBe(1200);
    expect(parseMoney("1,234.50")).toBe(123450);
    expect(parseMoney("-4.35")).toBe(-435);
    expect(parseMoney("0.5")).toBe(50);
  });
  it("never goes through a float", () => {
    expect(parseMoney("19.99")).toBe(1999);
    expect(parseMoney("0.29")).toBe(29);
  });
  it("rejects junk", () => {
    expect(() => parseMoney("12.345")).toThrow(MoneyError);
    expect(() => parseMoney("1,23")).toThrow(MoneyError);
    expect(() => parseMoney("abc")).toThrow(MoneyError);
  });
});

describe("formatMoney", () => {
  it("groups thousands and signs negatives before the symbol", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-435)).toBe("-$4.35");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(100_000_000)).toBe("$1,000,000.00");
  });
  it("supports another symbol and a dash for zero", () => {
    expect(formatMoney(250, { symbol: "€" })).toBe("€2.50");
    expect(formatMoney(0, { showZero: false })).toBe("-");
    expect(formatMoney(0)).toBe("$0.00");
  });
});

describe("arithmetic", () => {
  it("rounds half away from zero", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
  });
  it("multiplies and takes percentages", () => {
    expect(multiply(4999, 2)).toBe(9998);
    expect(percentOf(9998, 7.25)).toBe(725);
    expect(percentOf(-9998, 7.25)).toBe(-725);
  });
  it("adds whole cents only", () => {
    expect(addMoney(1, 2, 3)).toBe(6);
    expect(() => addMoney(1.5)).toThrow(MoneyError);
  });
});

describe("allocate", () => {
  it("splits evenly divisible amounts by ratio", () => {
    expect(allocate(90, [1, 2])).toEqual([30, 60]);
    expect(allocate(100, [1, 1])).toEqual([50, 50]);
    expect(allocate(-90, [1, 2])).toEqual([-30, -60]);
  });
  it("rejects bad ratios", () => {
    expect(() => allocate(100, [])).toThrow(MoneyError);
    expect(() => allocate(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(100, [-1, 2])).toThrow(MoneyError);
  });
});
