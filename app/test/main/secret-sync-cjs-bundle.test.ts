import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// app/build.mjs bundles src/main/index.ts (which statically imports SecretSync/sealWith from
// secret-sync.ts) with esbuild in `format: "cjs"`. esbuild does not support `import.meta.url` in
// cjs output -- it becomes `var import_meta = {}`, so anything that does
// `createRequire(import.meta.url)` at module scope turns into `createRequire(undefined)`, which
// throws at load time. `npx vitest run` never catches this because it loads the .ts source
// directly under Node's native ESM loader, where import.meta.url is real. This test reproduces
// the actual failure mode: bundle secret-sync.ts through esbuild with the exact settings
// app/build.mjs uses, then load the resulting .cjs file the way Electron's `main` field
// (dist/main.cjs) would.
const appDir = fileURLToPath(new URL("../..", import.meta.url));
// Written inside app/, not the OS temp dir: Node's require() resolves bare specifiers (like
// "libsodium-wrappers") by walking up from the requiring file's own directory through
// node_modules, exactly as it would for the real dist/main.cjs. A tmp dir outside the repo
// wouldn't find app's node_modules and would fail for an unrelated reason (MODULE_NOT_FOUND).
const outDir = path.join(appDir, "dist-test-cjs-bundle");

describe("secret-sync.ts under app/build.mjs's esbuild cjs bundle", () => {
  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("loads without throwing once bundled to cjs, exactly as Electron's main field would load it", async () => {
    const result = await build({
      entryPoints: { "secret-sync": "src/main/secret-sync.ts" },
      absWorkingDir: appDir,
      outdir: "dist-test-cjs-bundle",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      write: false,
    });
    const out = result.outputFiles.find((f) => f.path.endsWith("secret-sync.js"));
    if (!out) throw new Error("esbuild produced no output for secret-sync.js");

    fs.mkdirSync(outDir, { recursive: true });
    const bundlePath = path.join(outDir, "secret-sync.cjs");
    fs.writeFileSync(bundlePath, out.text);

    const req = createRequire(import.meta.url);
    let mod: unknown;
    expect(() => {
      mod = req(bundlePath);
    }).not.toThrow();
    expect(typeof (mod as { sealWith?: unknown }).sealWith).toBe("function");
    expect(typeof (mod as { SecretSync?: unknown }).SecretSync).toBe("function");
  });
});
