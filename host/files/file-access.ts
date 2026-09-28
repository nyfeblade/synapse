import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { mimeOf } from "./mime";

const NOT_ALLOWED = "That file isn't in /workspace or your attachments.";

function roots(cfg: HostConfig): { dir: string; attachmentsOnly: boolean }[] {
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  return [{ dir: real(cfg.workspace), attachmentsOnly: false }, { dir: real(path.join(cfg.dataRoot, "agents")), attachmentsOnly: true }];
}

/** FILE-03: only /workspace and agents/<id>/attachments, after resolving symlinks. */
export function resolveReadable(cfg: HostConfig, p: string): { real: string; size: number; mime: string } {
  if (!path.isAbsolute(p)) throw new GatewayError("NOT_ALLOWED", NOT_ALLOWED, 403);
  let real: string;
  try { real = fs.realpathSync(p); } catch { throw new GatewayError("NOT_FOUND", "That file doesn't exist.", 404); }
  const ok = roots(cfg).some((r) => {
    const rel = path.relative(r.dir, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return !r.attachmentsOnly || /^[^/]+\/attachments\/[^/]+$/.test(rel.split(path.sep).join("/"));
  });
  if (!ok) throw new GatewayError("NOT_ALLOWED", NOT_ALLOWED, 403);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new GatewayError("NOT_A_FILE", "That path isn't a file.");
  return { real, size: st.size, mime: mimeOf(real) };
}

export function readRange(real: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(real, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(length, LIMITS.fileReadChunkBytes, size - offset)));
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

export function pdfPages(real: string): number | null {
  if (mimeOf(real) !== "application/pdf" || fs.statSync(real).size > LIMITS.attachmentDocMaxBytes) return null;
  const n = (fs.readFileSync(real, "latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  return n || null;
}

export function createFileCommands(d: { cfg: HostConfig }): CommandHandlers {
  return {
    readWorkspaceFile: (a) => {
      const f = resolveReadable(d.cfg, a.path);
      const buf = readRange(f.real, a.offset, a.length);
      return { chunkBase64: buf.toString("base64"), size: f.size, mime: f.mime, eof: a.offset + buf.length >= f.size };
    },
  };
}
