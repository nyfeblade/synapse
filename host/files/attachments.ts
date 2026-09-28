import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITS, STR, type AttachmentRef, type GatewayCommands } from "@synapse/shared";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { AttachmentInput } from "../runner/turn-runner";
import { botDir } from "../store/layout";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { hostOutDir } from "../util/host-out";
import { writeHostOwnedFile } from "../util/host-owned-file";
import { isAllowedAttachment, isVideo, mimeOf } from "./mime";

const SAFE_NAME = /^[^/\\\0]{1,200}$/;

/** Bug #61: a Bot's own staging folder, /workspace/.host-out/uploads/<botId>. */
export const uploadsDirOf = (cfg: HostConfig, botId: string) => path.join(hostOutDir(cfg.workspace, "uploads"), path.basename(botDir(cfg, botId)));

export class AttachmentStore {
  private now: () => number;
  constructor(private d: { cfg: HostConfig; now?: () => number }) {
    this.now = d.now ?? Date.now;
  }

  private dir(botId: string) { return path.join(botDir(this.d.cfg, botId), "attachments"); }
  private indexFile(botId: string) { return path.join(this.dir(botId), "index.json"); }
  private partFile(botId: string, uploadId: string) {
    if (!/^[\w.-]{1,80}$/.test(uploadId)) throw new GatewayError("BAD_UPLOAD", "Invalid upload id.");
    return path.join(this.d.cfg.hostPrivate, "uploads", `${botId}-${uploadId}.part`);
  }

  receive(botId: string, a: GatewayCommands["uploadAttachment"]["args"]): { received: number; attachment: AttachmentRef | null } {
    const name = path.basename(String(a.name ?? "").trim());
    if (!SAFE_NAME.test(name) || name === "." || name === "..") throw new GatewayError("BAD_NAME", "Invalid file name.");
    if (!isAllowedAttachment(name)) throw new GatewayError("BAD_TYPE", "That file type isn't supported.");
    const mime = mimeOf(name);
    const max = isVideo(mime) ? LIMITS.attachmentVideoMaxBytes : LIMITS.attachmentDocMaxBytes;
    if (a.size > max) throw new GatewayError("TOO_LARGE", STR.fileTooLarge(name, max / 1024 / 1024));
    const part = this.partFile(botId, a.uploadId);
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (a.offset !== have) throw new GatewayError("BAD_OFFSET", `Expected offset ${have}, got ${a.offset}.`);
    const chunk = Buffer.from(a.chunkBase64, "base64");
    if (chunk.length > LIMITS.uploadChunkBytes) throw new GatewayError("CHUNK_TOO_LARGE", "Upload chunks can be at most 512 KiB.");
    if (have + chunk.length > a.size) throw new GatewayError("BAD_SIZE", "The upload is larger than announced.");
    fs.mkdirSync(path.dirname(part), { recursive: true, mode: 0o700 });
    fs.appendFileSync(part, chunk, { mode: 0o600 });
    const received = have + chunk.length;
    if (!a.final) return { received, attachment: null };
    if (received !== a.size) throw new GatewayError("BAD_SIZE", `Received ${received} of ${a.size} bytes.`);
    return { received, attachment: this.commit(botId, part, name, mime, received) };
  }

  private commit(botId: string, part: string, name: string, mime: string, size: number): AttachmentRef {
    const sha = createHash("sha256").update(fs.readFileSync(part)).digest("hex");
    const ext = path.extname(name).toLowerCase();
    const index = readJson<Record<string, AttachmentRef>>(this.indexFile(botId), {});
    // Content-addressed; a same-bytes file under a different name gets its own id so both names survive.
    let attachmentId = `${sha}${ext}`;
    if (index[attachmentId] && index[attachmentId]!.name !== name) attachmentId = `${sha}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}${ext}`;
    const storePath = path.join(this.dir(botId), `${sha}${ext}`);
    fs.mkdirSync(this.dir(botId), { recursive: true });
    if (!fs.existsSync(storePath)) { fs.copyFileSync(part, storePath); fs.chmodSync(storePath, 0o640); }
    // Bug #61: the original sits in the host-private Bot folder, which no Bot can read, so every attachment is staged
    // (videos too) into the Bot's own uploads/<botId>/, the only copy the Bot can open.
    const boxPath = this.stage(botId, storePath, name, sha);
    fs.rmSync(part, { force: true });
    const ref: AttachmentRef = { attachmentId, name, size, mime, storePath, boxPath };
    writeJsonAtomic(this.indexFile(botId), { ...index, [attachmentId]: ref }, 0o640);
    return ref;
  }

  /**
   * /workspace/.host-out/uploads/<basename>; a different file with the same name gets " (2)", " (3)", …
   *
   * Final secfix round 3 (ruling 4): staging moved out of the box-writable /workspace/uploads into the host-owned
   * /workspace/.host-out/uploads (bothost 2750 all the way down; box reads via the bots group, can't write or
   * rename). Written through writeHostOwnedFile (every component host-owned, O_EXCL|O_NOFOLLOW, the created file
   * verified before a byte is written), mode 0640, matching the path the model is told. Returns null (not staged) if
   * the write is refused -- a swapped directory, or a lost create race on every candidate name -- the attachment is
   * still stored content-addressed under dataRoot either way (AttachmentRef.boxPath is nullable, like videos).
   */
  private stage(botId: string, storePath: string, name: string, sha: string): string | null {
    const dir = uploadsDirOf(this.d.cfg, botId);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const bytes = fs.readFileSync(storePath);
    for (let n = 1; n < 1000; n++) {
      const filename = n === 1 ? name : `${stem} (${n})${ext}`;
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        if (createHash("sha256").update(fs.readFileSync(candidate)).digest("hex") === sha) return candidate;
        continue;
      }
      const written = writeHostOwnedFile(this.d.cfg.workspace, dir, filename, bytes, 0o640);
      if (written) return written;
      if (!fs.existsSync(candidate)) return null; // the directory itself is unsafe (symlink); give up quietly
      // else: lost a create race for this name (e.g. a concurrent upload) -- try the next one
    }
    throw new GatewayError("STAGE_FAILED", "Too many files with that name. Rename the file and try again.");
  }

  lookup(botId: string, attachmentId: string): AttachmentRef | null {
    return readJson<Record<string, AttachmentRef>>(this.indexFile(botId), {})[attachmentId] ?? null;
  }

  resolve(botId: string, ids: string[]): AttachmentInput[] {
    if (ids.length > LIMITS.attachmentsPerMessage) throw new GatewayError("TOO_MANY", STR.tooManyAttachments);
    return ids.map((id) => {
      const r = this.lookup(botId, id);
      if (!r) throw new GatewayError("NO_ATTACHMENT", "That attachment wasn't uploaded.", 404);
      return { attachmentId: r.attachmentId, name: r.name, size: r.size, mime: r.mime, storePath: r.storePath, boxPath: r.boxPath };
    });
  }

  readChunk(botId: string, attachmentId: string, offset: number, length: number): { chunkBase64: string; size: number; eof: boolean } {
    const r = this.lookup(botId, attachmentId);
    if (!r) throw new GatewayError("NO_ATTACHMENT", "No such attachment.", 404);
    const len = Math.max(0, Math.min(length, LIMITS.fileReadChunkBytes));
    const fd = fs.openSync(r.storePath, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, r.size - offset)));
      fs.readSync(fd, buf, 0, buf.length, offset);
      return { chunkBase64: buf.toString("base64"), size: r.size, eof: offset + buf.length >= r.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  sweepParts(maxAgeMs = 3600_000): void {
    const dir = path.join(this.d.cfg.hostPrivate, "uploads");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (this.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
    }
  }
}

export function createAttachmentCommands(d: { store: AttachmentStore }): CommandHandlers {
  return {
    uploadAttachment: (a) => d.store.receive(a.id, a),
    readAttachmentChunk: (a) => d.store.readChunk(a.id, a.attachmentId, a.offset, a.length),
  };
}
