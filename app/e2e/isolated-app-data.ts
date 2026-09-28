import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bug 289: Playwright globalSetup for the e2e and packaged runs. Every app a test launches spreads process.env, so
 * SYNAPSE_APP_DATA set here points its data folder at a fresh temp folder: a test never opens, creates or changes
 * anything under the real ~/Library/Application Support. The folder is removed when the run ends.
 */
export default function isolatedAppData(): () => void {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-e2e-appdata-")));
  process.env.SYNAPSE_APP_DATA = dir;
  return () => { fs.rmSync(dir, { recursive: true, force: true }); };
}
