import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Bug 39: `npm run e2e` could not collect at all. `playwright.config.ts` had `testMatch: "*.e2e.ts"`
 * and `testDir: "."`, and Playwright matches that glob against the whole path — so it also picked up
 * `e2e/packaged/packaged-smoke.e2e.ts`, whose `findPackagedApp()` throws AT IMPORT TIME when there is
 * no `dist-release`. One import throw aborts collection for the entire run, so the dev suite reported
 * "Total: 0 tests in 0 files" and every run for weeks used a hand-written path filter instead.
 *
 * A suite with no working single command is a suite nobody runs whole, so this asserts the command
 * itself rather than the config object: a config assertion would only restate the source, and the
 * defect was in what Playwright DID with the source. `--list` does the real collection — it imports
 * every spec, which is exactly the step that used to throw — without launching a single Electron app,
 * so this stays a unit-suite-priced check on an e2e-suite-sized claim.
 *
 * The second half is the other direction of the same bug: an ignore wide enough to keep the packaged
 * smoke test out of the dev run must not also cut it out of its own run.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function list(config: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["playwright", "test", "-c", config, "--list"], { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

describe("the dev e2e suite has a working single command (bug 39)", () => {
  it("`e2e/playwright.config.ts` collects the dev journeys and leaves the packaged smoke test alone", () => {
    const { code, out } = list("e2e/playwright.config.ts");
    expect(out).not.toMatch(/packaged-smoke/);
    expect(code).toBe(0);
    const total = /Total: (\d+) tests? in (\d+) files?/.exec(out);
    expect(total, `no "Total:" line in:\n${out}`).not.toBeNull();
    expect(Number(total![1])).toBeGreaterThan(0);
    // The journeys this bug's row lists live in four different files; one file collecting is not the claim.
    expect(Number(total![2])).toBeGreaterThan(1);
  });

  it("`e2e/packaged.config.ts` still reaches the packaged smoke test", () => {
    // With no dist-release it throws at import instead of listing — either way the run REACHED the
    // spec, which is the thing the dev-run ignore must not have taken away.
    expect(list("e2e/packaged.config.ts").out).toMatch(/packaged-smoke/);
  });
});
