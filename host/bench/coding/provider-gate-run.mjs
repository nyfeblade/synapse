// Entry for `npm run bench:provider-gate`: bundles provider-gate.ts (extensionless TypeScript) and runs it. No model calls.
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "provider-gate-")), "gate.mjs");
await build({ entryPoints: [path.join(here, "provider-gate.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "error" });
try {
  const { main } = await import(pathToFileURL(outfile).href);
  process.exitCode = main(process.argv.slice(2));
} finally {
  fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
}
