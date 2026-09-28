import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedRuntimeIntact, sealCachedRuntime, treeHash } from "../../scripts/kokoro-runtime.mjs";

// Portable install, fix round 1: a cached runtime in .build-cache is reused only when every file in it is still
// exactly what was built. Its tree hash (every path, size and sha256) is sealed in .complete when it is built and
// checked before each reuse; anything changed or added since means rebuild, never ship.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function runtime() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kokoro-cache-"));
  dirs.push(d);
  fs.mkdirSync(path.join(d, "python", "bin"), { recursive: true });
  fs.writeFileSync(path.join(d, "python", "bin", "python3.12"), "interpreter");
  fs.mkdirSync(path.join(d, "model"), { recursive: true });
  fs.writeFileSync(path.join(d, "model", "config.json"), "{}");
  return d;
}

describe("the cached Kokoro runtime", () => {
  it("is reused when nothing changed", () => {
    const d = runtime();
    sealCachedRuntime(d);
    expect(cachedRuntimeIntact(d)).toBe(true);
  });

  it("is refused when a file changed, was added or was removed", () => {
    const changed = runtime();
    sealCachedRuntime(changed);
    fs.writeFileSync(path.join(changed, "model", "config.json"), '{"tampered":1}');
    expect(cachedRuntimeIntact(changed)).toBe(false);

    const added = runtime();
    sealCachedRuntime(added);
    fs.writeFileSync(path.join(added, "python", "sitecustomize.py"), "import os");
    expect(cachedRuntimeIntact(added)).toBe(false);

    const removed = runtime();
    sealCachedRuntime(removed);
    fs.rmSync(path.join(removed, "model", "config.json"));
    expect(cachedRuntimeIntact(removed)).toBe(false);
  });

  it("an unsealed (half-built, or older-recipe) cache is never reused", () => {
    const d = runtime();
    expect(cachedRuntimeIntact(d)).toBe(false);
    fs.writeFileSync(path.join(d, ".complete"), "2026-09-24T00:00:00Z\n");
    expect(cachedRuntimeIntact(d)).toBe(false);
  });

  it("the hash covers names, not only contents", () => {
    const a = runtime();
    const b = runtime();
    fs.renameSync(path.join(b, "model", "config.json"), path.join(b, "model", "other.json"));
    expect(treeHash(a)).not.toBe(treeHash(b));
  });
});
