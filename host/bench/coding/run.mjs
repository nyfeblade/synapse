// Entry for `npm run bench:coding`. The host is extensionless TypeScript, so bundle main.ts with
// esbuild (already a host devDependency) into a temp file and run it. Nothing here calls a model.
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bench-coding-main-")), "main.mjs");
// A CommonJS dependency of the provider-loop runner's engine calls require(): give the ESM bundle one.
await build({ entryPoints: [path.join(here, "main.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "error",
  banner: { js: "import { createRequire as __benchRequire } from 'node:module'; const require = __benchRequire(import.meta.url);" } });
process.env.BENCH_CODING_DIR = here;
// The bundle lives in a temp folder: the host's prompts (the provider-loop runner's coding prompt) are read from source.
process.env.PROMPTS_DIR ??= path.resolve(here, "../../prompts");
try {
  const { main } = await import(pathToFileURL(outfile).href);
  process.exitCode = await main(process.argv.slice(2));
} finally {
  fs.rmSync(path.dirname(outfile), { recursive: true, force: true });
}
