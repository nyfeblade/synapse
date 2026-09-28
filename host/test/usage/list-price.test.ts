import { describe, expect, it } from "vitest";
import { listCostUsd, listPrice } from "../../usage/list-price";

/** Review fix D: list prices per MTok (input / output) for what the Mac key proxy can meter. */
const M = 1_000_000;
const cost = (model: string, input: number, output: number) => listCostUsd(model, { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe("list prices", () => {
  it("Opus 4 and 4.1 are $15 / $75, not the Opus prefix price; later Opus is $5 / $25", () => {
    for (const m of ["claude-opus-4", "claude-opus-4-0", "claude-opus-4-20250514", "claude-opus-4-1", "claude-opus-4-1-20250805"]) expect(listPrice(m), m).toEqual({ input: 15, output: 75 });
    expect(listPrice("claude-opus-4-5")).toEqual({ input: 5, output: 25 });
    expect(cost("claude-opus-4-1", M, M)).toBe(90);
  });

  it("Claude 3 models have their real list prices", () => {
    expect(listPrice("claude-3-opus-20240229")).toEqual({ input: 15, output: 75 });
    expect(listPrice("claude-3-5-sonnet-20241022")).toEqual({ input: 3, output: 15 });
    expect(listPrice("claude-3-7-sonnet-20250219")).toEqual({ input: 3, output: 15 });
    expect(listPrice("claude-3-sonnet-20240229")).toEqual({ input: 3, output: 15 });
    expect(listPrice("claude-3-5-haiku-20241022")).toEqual({ input: 0.8, output: 4 });
    expect(listPrice("claude-3-haiku-20240307")).toEqual({ input: 0.25, output: 1.25 });
  });

  it("Sonnet 4 / 4.5 are $3 / $15; Haiku 4.5 is $1 / $5", () => {
    expect(listPrice("claude-sonnet-4-5")).toEqual({ input: 3, output: 15 });
    expect(listPrice("claude-sonnet-4-20250514")).toEqual({ input: 3, output: 15 });
    expect(listPrice("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
  });

  it("an unknown model is priced at the highest known rate (never under-counted)", () => {
    expect(listPrice("unknown")).toEqual({ input: 15, output: 75 });
    expect(listPrice("gpt-something")).toEqual({ input: 15, output: 75 });
  });

  it("cache reads at 0.1x and 5-minute cache writes at 1.25x the input price", () => {
    expect(listCostUsd("claude-3-opus-20240229", { inputTokens: 0, outputTokens: 0, cacheReadTokens: M, cacheWriteTokens: M })).toBe(1.5 + 18.75);
  });
});
