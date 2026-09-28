import { describe, expect, it } from "vitest";
import { isExpectedPostInterruptThrow } from "../../brain/interrupt-throw";

const wrap = (diag: string) => new Error(`Claude Code returned an error result: ${diag}`);

describe("isExpectedPostInterruptThrow (H-3: both live ede_diagnostic post-interrupt shapes)", () => {
  it("accepts the stop_reason=tool_use shape (interrupt during tool use)", () => {
    expect(isExpectedPostInterruptThrow(wrap("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"))).toBe(true);
  });

  it("accepts the stop_reason=null shape (interrupt landing between stream events)", () => {
    expect(isExpectedPostInterruptThrow(wrap("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"))).toBe(true);
  });

  it("stays narrow: rejects other stop reasons, a missing diagnostic tag, or a missing SDK prefix", () => {
    expect(isExpectedPostInterruptThrow(wrap("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=end_turn"))).toBe(false);
    expect(isExpectedPostInterruptThrow(wrap("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=nullish"))).toBe(false);
    expect(isExpectedPostInterruptThrow(wrap("some other failure stop_reason=null"))).toBe(false);
    expect(isExpectedPostInterruptThrow(new Error("[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"))).toBe(false);
    expect(isExpectedPostInterruptThrow(new Error("ECONNRESET"))).toBe(false);
  });
});
