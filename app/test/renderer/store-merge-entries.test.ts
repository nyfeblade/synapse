import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolCallEntry, TranscriptEntry } from "@synapse/shared";
import { timeOf } from "../../src/renderer/transcript-items";

const storeSrcPath = fileURLToPath(new URL("../../src/renderer/store.ts", import.meta.url));
const storeSrc = () => readFileSync(storeSrcPath, "utf8");

const tc = (id: string, startedAt: number): ToolCallEntry => ({
  kind: "tool-call", id, requestId: "r1", segmentId: "r1:0", hidden: false, name: "x", step: "step", icon: "mail",
  metric: null, status: "done", startedAt, endedAt: startedAt + 10,
});
const msg = (id: string, createdAt: number): TranscriptEntry => ({ kind: "message", id, role: "user", content: "hi", createdAt });

describe("store.ts / transcript-items.ts effective-time logic (fix round 1, finding 1)", () => {
  it("does not redefine its own copy of the tool-call-vs-createdAt ternary — it imports transcript-items.ts's timeOf instead", () => {
    const src = storeSrc();
    expect(src).toMatch(/import\s*\{[^}]*\btimeOf\b[^}]*\}\s*from\s*["']\.\/transcript-items["']/);
    expect(src).not.toMatch(/entryTimeOf\s*=\s*\(/);
    expect(src).not.toMatch(/e\.kind\s*===\s*"tool-call"\s*\?\s*e\.startedAt\s*:\s*e\.createdAt/);
  });

  it("timeOf (the shared helper) picks startedAt for tool-call entries and createdAt for everything else", () => {
    expect(timeOf(tc("a1", 500))).toBe(500);
    expect(timeOf(msg("m1", 900))).toBe(900);
  });
});
