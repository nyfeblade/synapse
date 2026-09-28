import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "../config";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export interface HostRun { bootId: string; startedAt: number; clean: boolean }

/**
 * Crash reporting (Settings → Diagnostics): host-run.json says whether the previous host process
 * stopped through close() or died. The Mac reads `previousRun` from /health and records an unclean
 * one as a host crash. Returns the previous run (null on a first boot).
 */
export function recordRunStart(cfg: HostConfig, bootId: string, now: () => number): HostRun | null {
  const file = path.join(cfg.hostPrivate, "host-run.json");
  const prev = readJson<HostRun | null>(file, null);
  writeJsonAtomic(file, { bootId, startedAt: now(), clean: false } satisfies HostRun, 0o600);
  return prev && typeof prev.bootId === "string" ? prev : null;
}

export function recordRunEnd(cfg: HostConfig, bootId: string): void {
  const file = path.join(cfg.hostPrivate, "host-run.json");
  const cur = readJson<HostRun | null>(file, null);
  if (cur?.bootId === bootId) writeJsonAtomic(file, { ...cur, clean: true }, 0o600);
}

/** host/build.mjs writes dist/build-id.txt (a hash of host.mjs); the app compares it with the host it ships. */
export function hostBuildId(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const id = fs.readFileSync(path.join(here, "build-id.txt"), "utf8").trim();
    return /^[0-9a-f]{16}$/.test(id) ? id : null;
  } catch { return null; }
}
