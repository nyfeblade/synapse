#!/usr/bin/env node
// Checks every package in box/files/acp-pins/<vendor>/package-lock.json against the npm registry's own published
// `dist.integrity` (https://registry.npmjs.org/<name>/<version>), and that each is resolved from registry.npmjs.org.
// Run it when a pin is bumped: node scripts/acp-pins-verify.mjs. Prints one line per package; exits 1 on any mismatch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "box", "files", "acp-pins");
let bad = 0;
for (const vendor of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort()) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, vendor, "package-lock.json"), "utf8"));
  for (const [key, p] of Object.entries(lock.packages)) {
    if (!key) continue;
    const name = p.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const src = `https://registry.npmjs.org/${name.replace("/", "%2F")}/${p.version}`;
    const r = await fetch(src);
    const published = r.ok ? (await r.json()).dist?.integrity : null;
    const ok = published === p.integrity && typeof p.resolved === "string" && p.resolved.startsWith("https://registry.npmjs.org/");
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${vendor}  ${name}@${p.version}  ${p.integrity}  ${src}`);
  }
}
if (bad) { console.error(`${bad} pin(s) don't match the registry`); process.exit(1); }
