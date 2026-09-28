/**
 * Bug 258 (fix round): the "allowed app" check. An app runs quietly in Full auto only when it existed before the Bot
 * ran and the Bot can't have written it: under /System/*, or /Applications root-owned or Apple/Developer-ID-signed
 * with a verified codesign. Anything the Bot could plant (~/Applications, a user-writable bundle) is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macAllowedApp, _clearAppTrustCache } from "../../src/coordinator/local-exec/app-trust";

let home: string;
beforeEach(() => { home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "trust-"))); _clearAppTrustCache(); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("string rules (no Mac needed)", () => {
  it("a non-existent name, a ~/… path, and a non-Apple bundle id are refused", () => {
    expect(macAllowedApp("Definitely Not Installed 9x", home)).toBe(false);
    expect(macAllowedApp(`${home}/Applications/Mine.app`, home)).toBe(false);
    expect(macAllowedApp("~/Applications/Mine.app", home)).toBe(false);
    expect(macAllowedApp("com.evil.tool", home)).toBe(false);
    expect(macAllowedApp("", home)).toBe(false);
  });
  it("an Apple bundle id is trusted", () => {
    expect(macAllowedApp("com.apple.Safari", home)).toBe(true);
  });
});

describe.runIf(process.platform === "darwin")("live (this Mac)", () => {
  it("a real system app is allowed, and a bot-dropped app in ~/Applications is not", () => {
    expect(macAllowedApp("Calculator", os.homedir())).toBe(true);
    // A fake app the Bot could have written, in a user-writable place.
    const apps = path.join(home, "Applications");
    fs.mkdirSync(path.join(apps, "Evil.app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(apps, "Evil.app", "Contents", "MacOS", "Evil"), "#!/bin/sh\n", { mode: 0o755 });
    expect(macAllowedApp(path.join(apps, "Evil.app"), home)).toBe(false);
  });
});
