// The GPL-3.0 parts of the bundled Kokoro voice (espeak-ng and phonemizer-fork) ship with their exact source: every
// GitHub release carries the source archives as assets (owner decision 2026-09-26). native/kokoro/gpl-sources.json pins
// each archive's canonical URL and SHA-256; publish-release.mjs fetches them at release time through the same
// hash-checked download the voice runtime uses. Nothing is vendored into git; downloads are cached under .build-cache.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRoot, fetchVerified } from "./kokoro-runtime.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GPL_SOURCES_FILE = path.join(here, "native", "kokoro", "gpl-sources.json");

/** The pinned archives, in release order. */
export function gplSources(file = GPL_SOURCES_FILE) {
  const sources = JSON.parse(fs.readFileSync(file, "utf8")).sources;
  for (const s of sources) {
    if (!/^[0-9a-f]{64}$/.test(s.sha256) || !/^https:\/\//.test(s.url) || s.asset !== path.basename(s.asset)) {
      throw new Error(`gpl-sources: ${s.name} has a bad pin in ${path.basename(file)}`);
    }
  }
  return sources;
}

/** Where release-time downloads are kept: <repo>/.build-cache/gpl-sources (or SYNAPSE_BUILD_CACHE). */
export function gplSourcesDir(repoRoot = path.resolve(here, ".."), env = process.env) {
  return path.join(cacheRoot(repoRoot, env), "gpl-sources");
}

/** Downloads (or reuses) every pinned archive into `dir`, each checked against its SHA-256; returns their paths. */
export function fetchGplSources(dir, { fetch = fetchVerified, log = console.log } = {}) {
  return gplSources().map((s) => fetch(s.url, path.join(dir, s.asset), s.sha256, log));
}
