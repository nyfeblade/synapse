import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findKokoro, KokoroSidecar } from "../../src/main/native/kokoro";
import { runVoiceSelfTest, writeReport } from "../../src/main/native/voice-selftest";

/**
 * 5.8: the nightly voice self-test, run by hand (`npm run selftest:voice`): the real helper hears the fixture clip,
 * the real natural voice renders the reply's first line, the helper plays it, and every stage is timed from the end
 * of speech in the clip. The report goes to test-reports/voice-selftest/<date>.json; the test fails over budget.
 *
 * Needs the built helper (app/native/dictation/build.sh) and Speech Recognition access for the process running it.
 * The natural voice comes from SYNAPSE_KOKORO_DIR (a staged or cached runtime: python/ and model/); without one the
 * helper's Apple voice says the line and the report says so. VOICE_SELFTEST=1 opts in. It never downloads anything.
 */
const run = process.env.VOICE_SELFTEST === "1";
const root = path.resolve(__dirname, "../../..");
const helper = process.env.DICTATION_BIN ?? path.join(root, "app/dist/native/bots-dictation");
const clip = path.join(root, "app/native/dictation/selftest-clip.wav");

describe.skipIf(!run)("5.8: the nightly voice self-test through the real pipeline", () => {
  it("first audio within the budget after the end of speech", async () => {
    const dir = process.env.SYNAPSE_KOKORO_DIR;
    const engine = dir ? findKokoro({ bundled: dir, userData: os.tmpdir(), exists: (p) => fs.existsSync(p) }) : null;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-selftest-"));
    const side = engine ? new KokoroSidecar({ engine, script: path.join(root, "app/native/kokoro/kokoro_server.py"), log: (l) => console.log(l), cacheDir, idleMs: 60_000, stallMs: 30_000 }) : null;
    try {
      if (side && !(await side.whenWarm(120_000))) throw new Error("the natural voice never warmed up");
      const r = await runVoiceSelfTest({ helper, clip, tts: side, log: (l) => console.log(l) });
      const file = writeReport(path.join(root, "test-reports/voice-selftest"), r);
      console.log(`report: ${path.relative(root, file)}\n${JSON.stringify(r, null, 2)}`);
      expect(r.error ?? null).toBeNull();
      expect(r.ok).toBe(true);
    } finally {
      side?.dispose();
      await new Promise((r) => setTimeout(r, 1_500)); // the sidecar exits before its cache folder goes
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 240_000);
});
