import { createHash } from "node:crypto";
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const EXTERNAL = ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod", "playwright-core", "ws", "libsodium-wrappers"];

fs.rmSync(dist, { recursive: true, force: true });
// Portable install: a package build (PACKAGE_BUILD=1, set by app/scripts/package.mjs) ships no source maps
// (a *.map is the TypeScript source) and none of the dev-only eval entry points.
const PACKAGE = process.env.PACKAGE_BUILD === "1";
const common = {
  bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: !PACKAGE, external: EXTERNAL,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...common, entryPoints: [path.join(here, "main.ts")], outfile: path.join(dist, "host.mjs") });
fs.copyFileSync(path.join(here, "templates", "starters.json"), path.join(dist, "starters.json"));
if (!PACKAGE) {
await build({ ...common, entryPoints: [path.join(here, "evals", "reviewer", "run.ts")], outfile: path.join(dist, "eval-reviewer.mjs") });
fs.mkdirSync(path.join(dist, "evals", "reviewer"), { recursive: true });
fs.copyFileSync(path.join(here, "evals", "reviewer", "cases.jsonl"), path.join(dist, "evals", "reviewer", "cases.jsonl"));
await build({ ...common, entryPoints: [path.join(here, "evals", "memory", "run.ts")], outfile: path.join(dist, "eval-memory.mjs") });
fs.mkdirSync(path.join(dist, "evals", "memory"), { recursive: true });
for (const f of ["extraction.jsonl", "episodes.jsonl"]) fs.copyFileSync(path.join(here, "evals", "memory", f), path.join(dist, "evals", "memory", f));
await build({ ...common, entryPoints: [path.join(here, "evals", "b2b-gate", "run.ts")], outfile: path.join(dist, "eval-b2b-gate.mjs") });
fs.mkdirSync(path.join(dist, "evals", "b2b-gate"), { recursive: true });
fs.copyFileSync(path.join(here, "evals", "b2b-gate", "cases.jsonl"), path.join(dist, "evals", "b2b-gate", "cases.jsonl"));
await build({ ...common, entryPoints: [path.join(here, "evals", "dreaming", "run.ts")], outfile: path.join(dist, "eval-dreaming.mjs") });
fs.mkdirSync(path.join(dist, "evals", "dreaming"), { recursive: true });
for (const f of ["cases.jsonl", "corrupt.jsonl"]) fs.copyFileSync(path.join(here, "evals", "dreaming", f), path.join(dist, "evals", "dreaming", f));
await build({ ...common, entryPoints: [path.join(here, "marketplace", "check-curated.ts")], outfile: path.join(dist, "check-curated.mjs") });
}
fs.copyFileSync(path.join(here, "marketplace", "curated.json"), path.join(dist, "curated.json"));

// Prompts and data files keep their relative paths (loadPrompt("orig/reviewer.md") → dist/orig/reviewer.md).
function copyTree(src, dst, keep) {
  if (!fs.existsSync(src)) return;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d, keep);
    else if (keep(ent.name)) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); }
  }
}
copyTree(path.join(here, "prompts"), dist, (n) => n.endsWith(".md"));
copyTree(path.join(here, "review"), dist, (n) => n.endsWith(".txt"));
copyTree(path.join(here, "ui"), dist, (n) => n.endsWith(".json"));

const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const deps = Object.fromEntries(EXTERNAL.map((k) => [k, pkg.dependencies[k]]));
fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({ name: "synapse-host-runtime", private: true, type: "module", dependencies: deps }, null, 2));
// Updates: the app compares this with the host it ships (Resources/host/dist/build-id.txt) and
// redeploys the box's host only when they differ. /health reports it as hostBuild.
fs.writeFileSync(path.join(dist, "build-id.txt"), `${createHash("sha256").update(fs.readFileSync(path.join(dist, "host.mjs"))).digest("hex").slice(0, 16)}\n`);
console.log("host: built dist/host.mjs");
