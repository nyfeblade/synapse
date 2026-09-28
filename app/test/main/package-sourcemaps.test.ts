import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(path.join(appRoot, rel), "utf8");

/**
 * Bug 28: a shipped `main.cjs.map` is the entire TypeScript source of the Mac side. verify-bundle
 * is the backstop (it refuses `.map` in the asar). The producer has to stop emitting them on a
 * package build, or every rebuild still writes the maps next to the bundle inputs.
 */
describe("package builds do not emit source maps (bug 28)", () => {
  it("build.mjs turns sourcemaps off when PACKAGE_BUILD=1, and never hard-codes them on", () => {
    const src = read("build.mjs");
    expect(src, "sourcemap: true ships maps on every `npm run package`").not.toMatch(/sourcemap:\s*true\b/);
    expect(src).toMatch(/PACKAGE_BUILD/);
  });

  it("the package script sets PACKAGE_BUILD so the ignore rule is not the only defence", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: { package: string } };
    expect(pkg.scripts.package).toMatch(/PACKAGE_BUILD=1/);
  });
});
