// Entry for `npm run bench:coding`. The host is extensionless TypeScript, so bundle main.ts with
// esbuild (already a host devDependency) into a temp file and run it. Nothing here calls a model.
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-coding-main-")), "main.mjs");
await build({ entryPoints: [path.join(here, "main.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "error" });
process.env.BENCH_CODING_DIR = here;
try {
  const { main } = await import(pathToFileURL(outfile).href);
  process.exitCode = await main(process.argv.slice(2));
} finally {
  fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
}
