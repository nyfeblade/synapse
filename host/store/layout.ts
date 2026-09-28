import fs from "node:fs";
import path from "node:path";
import { isSafeFolderId } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { writeJsonAtomic } from "../util/atomic-json";
import { DEFAULT_HOST_SETTINGS } from "./host-settings";

export const agentsDir = (cfg: HostConfig) => path.join(cfg.dataRoot, "agents");

export function botDir(cfg: HostConfig, id: string): string {
  if (!isSafeFolderId(id)) throw new GatewayError("INVALID_BOT_ID", `Invalid Bot id: ${JSON.stringify(id)}`, 400);
  return path.join(agentsDir(cfg), id);
}

/**
 * Bug #61 (Bot walls): every Bot's folder and transcript mirror are host-private. All Bots run as the one uid `box`
 * (in the `bots` group), so these two roots lose every group/other bit: box can't list or enter them by any means,
 * while user-memory/ and projects/ (shared by design) keep their group read. Idempotent; runs on every host start,
 * which is also the in-place migration of an existing box (ownership and contents are untouched).
 */
export const WALLED_DATA_ROOTS = ["agents", "agent-transcripts"] as const;

export function initLayout(cfg: HostConfig): void {
  for (const d of WALLED_DATA_ROOTS) {
    const dir = path.join(cfg.dataRoot, d);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  fs.mkdirSync(cfg.hostPrivate, { recursive: true, mode: 0o700 });
  fs.chmodSync(cfg.hostPrivate, 0o700);
  // Phase 3 (T28): the disk guard statfs()s cfg.workspace at boot; in production /workspace is
  // already mounted, but dev/CI environments that point WORKSPACE at a fresh temp dir need it
  // created up front so boot doesn't crash on ENOENT. Best-effort: on the box /workspace already
  // exists, and a sandbox without permission to create it here shouldn't fail layout init over it.
  try { fs.mkdirSync(cfg.workspace, { recursive: true }); } catch { /* pre-existing/mounted, or not creatable here */ }
  const settings = path.join(cfg.dataRoot, "settings.json");
  if (!fs.existsSync(settings)) writeJsonAtomic(settings, DEFAULT_HOST_SETTINGS, 0o640);
  const active = path.join(agentsDir(cfg), "active-agent.json");
  if (!fs.existsSync(active)) writeJsonAtomic(active, { activeAgentId: null }, 0o640);
}
