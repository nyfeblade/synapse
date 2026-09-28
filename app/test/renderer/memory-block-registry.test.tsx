// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { generalExtraBlocks } from "../../src/renderer/components/settings/sections";
import { MemoryBlock } from "../../src/renderer/components/settings/MemoryBlock";

describe("Memory dropdown in Settings → General (MEM-07, wired at Task 32)", () => {
  it("registers MemoryBlock as a General block", () => {
    expect(generalExtraBlocks().find((b) => b.id === "memory")?.Component).toBe(MemoryBlock);
  });
});
