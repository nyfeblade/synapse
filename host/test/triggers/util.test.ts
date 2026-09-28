import { describe, expect, it } from "vitest";
import { obj, str } from "../../triggers/util";

describe("triggers/util (shared by github.ts, slack.ts, adapters.ts)", () => {
  it("obj() narrows to a plain object, else {}", () => {
    expect(obj({ a: 1 })).toEqual({ a: 1 });
    expect(obj(null)).toEqual({});
    expect(obj("x")).toEqual({});
    expect(obj(undefined)).toEqual({});
  });

  it("str() coerces strings and numbers, else ''", () => {
    expect(str("x")).toBe("x");
    expect(str(42)).toBe("42");
    expect(str(null)).toBe("");
    expect(str(undefined)).toBe("");
    expect(str({})).toBe("");
  });
});
