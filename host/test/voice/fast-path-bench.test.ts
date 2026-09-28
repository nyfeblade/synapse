import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostApp } from "../../app";
import { report, runScriptedCall, writeReport } from "../../bench/voice/run";
import { tmpConfig } from "../helpers";

/**
 * Bug 142: the same scripted call down both paths (fake model: the structure is what is measured; tokens are that
 * structure times the unit costs measured on the real model). The ship rule — cost per call-minute flat or lower —
 * is the assertion. BENCH_VOICE=1 also writes the report under test-reports/voice-fast-path/.
 */
describe("voice fast path vs a full turn per utterance (scripted call)", () => {
  it("makes far fewer full-session turns and costs less per call-minute, and still says something every turn", async () => {
    const mk = (env: Record<string, string>) => createHostApp(tmpConfig(env));
    const before = await runScriptedCall(false, mk);
    const after = await runScriptedCall(true, mk);
    if (process.env.BENCH_VOICE === "1") {
      const file = writeReport(path.resolve(__dirname, "../../../test-reports/voice-fast-path", new Date().toISOString().replace(/[:.]/g, "-")), report(before, after));
      console.warn(`voice bench report: ${file}`);
    }
    // Structure: every utterance was answered on both paths; only the work went to the full session.
    expect(before.fullTurns).toBe(12);
    expect(after.fullTurns).toBeLessThanOrEqual(5);
    expect(after.frontTurns).toBeGreaterThanOrEqual(12);
    expect(after.spokenLines).toBeGreaterThanOrEqual(12);
    // The ship rule.
    expect(after.tokensPerCallMinute).toBeLessThanOrEqual(before.tokensPerCallMinute);
  }, 180_000);
});
