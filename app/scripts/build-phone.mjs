// Bug 198: builds the phone client (src/phone) into <out> — app.js, worklet.js, sw.js, index.html,
// app.css — which the main process serves to the user's phone (Phone access). Safari 15+ / Chrome 100+.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src", "phone");

export async function buildPhone(out, { minify = true } = {}) {
  fs.mkdirSync(out, { recursive: true });
  await build({
    entryPoints: { app: path.join(src, "main.ts"), worklet: path.join(src, "worklet.ts"), sw: path.join(src, "sw.ts") },
    outdir: out, bundle: true, format: "iife", platform: "browser", target: ["safari15", "chrome100"],
    minify, sourcemap: false, legalComments: "none", logLevel: "warning",
  });
  for (const f of ["index.html", "app.css"]) fs.copyFileSync(path.join(src, f), path.join(out, f));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? path.resolve(here, "..", "dist", "phone");
  await buildPhone(out);
  console.log(`app: built phone client → ${out}`);
}
