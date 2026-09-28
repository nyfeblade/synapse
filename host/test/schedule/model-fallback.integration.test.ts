import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SdkOneShot } from "../../helper-model/one-shot";
import { normalizeSchedule } from "../../schedule/normalize";
import { nextRuns, parseSchedule } from "../../schedule/schedule";

const NY = "America/New_York";
const NOW = Date.UTC(2026, 8, 19, 16, 0);
const cases = fs
  .readFileSync(path.join(import.meta.dirname, "../../evals/schedule/cases.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { text: string; expected: string });

// ORIG-03 §03.7: the 40 model-fallback phrases of the golden corpus. Real Haiku calls; spends a little quota.
describe.skipIf(!process.env.RUN_CLAUDE)("schedule parser model fallback (40 cases)", () => {
  it("every case produces the same next 10 runs as its expected schedule", async () => {
    const model = new SdkOneShot({ env: { HOME: process.env.HOME as string, PATH: process.env.PATH as string }, cwd: fs.mkdtempSync(path.join(os.tmpdir(), "sched-eval-")) });
    const failures: string[] = [];
    for (const c of cases) {
      try {
        const n = await normalizeSchedule(c.text, { tz: NY, nowMs: NOW, model });
        const want = nextRuns(parseSchedule(c.expected, { tz: NY, nowMs: NOW }), NOW, NY, 10);
        if (JSON.stringify(nextRuns(n.parsed, NOW, NY, 10)) !== JSON.stringify(want)) failures.push(`${c.text}: got ${n.schedule}, want ${c.expected}`);
      } catch (e) {
        failures.push(`${c.text}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
