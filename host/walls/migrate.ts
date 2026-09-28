import fs from "node:fs";
import path from "node:path";
import type { AttachmentRef } from "@synapse/shared";
import type { HostConfig } from "../config";
import { uploadsDirOf } from "../files/attachments";
import { agentsDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { hostOutDir } from "../util/host-out";
import { removeHostOwnedPath, writeHostOwnedFile } from "../util/host-owned-file";
import { log } from "../util/log";

/**
 * Bug #61 (Bot walls), run on every host start: move pre-wall flat staging into the per-Bot layout, in place and
 * idempotently. Nothing is lost:
 *  - a flat /workspace/.host-out/uploads/<name> that a Bot's attachment index points at is copied into that Bot's
 *    uploads/<botId>/ (every Bot that points at it gets its own copy) and the index's boxPath updated; then removed.
 *  - a flat upload no index points at, and every flat MCP spill (never bot-attributable), moves to host-private
 *    <hostPrivate>/walled/<kind>/ where no Bot can read it.
 * The originals under agents/<id>/attachments are never touched. A second run finds no flat files and does nothing.
 */
export function migrateLegacyStaging(cfg: HostConfig): { moved: number; parked: number } {
  let moved = 0, parked = 0;
  const flat = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name)); } catch { return []; } };
  const uploads = hostOutDir(cfg.workspace, "uploads");
  const legacy = new Set(flat(uploads));
  const claimed = new Set<string>();
  const keep = new Set<string>();
  if (legacy.size) {
    let ids: string[] = [];
    try { ids = fs.readdirSync(agentsDir(cfg), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no Bots */ }
    for (const id of ids) {
      const indexFile = path.join(agentsDir(cfg), id, "attachments", "index.json");
      const index = readJson<Record<string, AttachmentRef>>(indexFile, {});
      let changed = false;
      for (const ref of Object.values(index)) {
        if (!ref.boxPath || !legacy.has(ref.boxPath)) continue;
        const dest = path.join(uploadsDirOf(cfg, id), path.basename(ref.boxPath));
        const ok = fs.existsSync(dest) ? dest : writeHostOwnedFile(cfg.workspace, path.dirname(dest), path.basename(dest), fs.readFileSync(ref.boxPath), 0o640);
        if (!ok) { keep.add(ref.boxPath); log.warn("walls: could not re-stage a legacy upload; leaving it in place", { botId: id, file: ref.boxPath }); continue; }
        claimed.add(ref.boxPath);
        ref.boxPath = ok;
        changed = true;
        moved++;
      }
      if (changed) writeJsonAtomic(indexFile, index, 0o640);
    }
  }
  const park = (file: string, kind: string) => {
    const dir = path.join(cfg.hostPrivate, "walled", kind);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let dest = path.join(dir, path.basename(file));
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${n}-${path.basename(file)}`);
    fs.copyFileSync(file, dest);
    fs.chmodSync(dest, 0o600);
    parked++;
  };
  for (const f of legacy) {
    if (keep.has(f)) continue;
    if (!claimed.has(f)) park(f, "uploads");
    if (!removeHostOwnedPath(cfg.workspace, f)) log.warn("walls: could not remove a legacy flat upload", { file: f });
  }
  for (const f of flat(hostOutDir(cfg.workspace, "mcp-output"))) {
    park(f, "mcp-output");
    if (!removeHostOwnedPath(cfg.workspace, f)) log.warn("walls: could not remove a legacy flat MCP spill", { file: f });
  }
  if (moved || parked) log.info("walls: legacy staging migrated", { moved, parked });
  return { moved, parked };
}
