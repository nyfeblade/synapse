import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoFile = (rel: string): string => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

// Finding 1 (fix round 1): host/test/phase4-journey.integration.test.ts:41,65 defined the
// `tail` helper (`(await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail",
// { id, limit: 200 })).entries`) verbatim, identically, inside both journey 1's and journey 2's
// `it` blocks — verbatim duplication per the DRY rule. The duplication originates in task-49-brief.md's
// own Step 1 code sample (mirrored in this repo's plan doc), so the fix is routed through the plan doc
// as well as the test file, not an isolated test edit: `tail` is hoisted to describe-level scope so
// both tests share one definition.
describe("Task 49 fix round 1", () => {
  describe("finding 1: the getAgentTranscriptTail `tail` helper is defined once, at describe level", () => {
    it("host/test/phase4-journey.integration.test.ts declares `tail` exactly once, above the it() blocks", () => {
      const s = repoFile("host/test/phase4-journey.integration.test.ts");
      const matches = s.match(/const tail = async \([^)]*id: string\) =>/g) ?? [];
      expect(matches.length).toBe(1);

      const describeIdx = s.indexOf('describe.skipIf(live)("Phase 4 journeys against the box (real Claude)"');
      const tailIdx = s.indexOf("const tail = async (");
      const firstItIdx = s.indexOf('it("control plane from chat');
      expect(describeIdx).toBeGreaterThan(-1);
      expect(firstItIdx).toBeGreaterThan(-1);
      // Hoisted to describe-level scope: defined after the describe() opens but before the first it().
      expect(tailIdx).toBeGreaterThan(describeIdx);
      expect(tailIdx).toBeLessThan(firstItIdx);
    });

    // The plan docs stay in the private working repo (docs/public-repo-exclude.md), so a public checkout skips this.
    it.skipIf(!fs.existsSync(path.join(__dirname, "../..", "docs/superpowers")))("the plan doc's Task 49 Step 1 sample hoists `tail` to describe scope instead of repeating it per test", () => {
      const s = repoFile("docs/superpowers/plans/2026-09-19-phase-4-routines-bot-to-bot.md");
      const taskIdx = s.indexOf("### Task 49: Phase 4 acceptance in the box");
      expect(taskIdx).toBeGreaterThan(-1);
      const nextTaskIdx = s.indexOf("### Task 50", taskIdx);
      expect(nextTaskIdx).toBeGreaterThan(taskIdx);
      const section = s.slice(taskIdx, nextTaskIdx);
      const matches = section.match(/const tail = async \([^)]*id: string\) =>/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });
});
