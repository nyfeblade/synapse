import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { END_RECORD, encodeRecord, readRecords, type RecordMeta } from "@synapse/host/backup/records";

/**
 * A Synapse backup archive (.synbak):
 *
 *   "SYNBAK01" | u32 header length | header JSON { v, keyId, iv, createdAt, appVersion } |
 *   AES-256-GCM( gzip( record stream ) ), header bytes as AAD | 16-byte GCM tag
 *
 * The 32-byte key is sealed with the profile's key file (sealing.ts, bug 279; see service.ts);
 * the recovery code is that same key in base32, so an archive can be opened on another Mac.
 * The header says which key it needs (a domain-separated fingerprint), never anything about the
 * contents: Bot names, dates beyond the creation time and sizes are all inside the ciphertext.
 */
const MAGIC = Buffer.from("SYNBAK01");
const TAG = 16;
export interface ArchiveHeader { v: 1; keyId: string; iv: string; createdAt: number; appVersion: string }
export interface ArchiveRecord { p: string; data: Buffer; m?: number }

export const newBackupKey = (): Buffer => randomBytes(32);
export const keyId = (key: Buffer): string => createHash("sha256").update("synapse-backup/key-id/v1").update(key).digest("hex").slice(0, 16);

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The key as 52 base32 characters in groups of four: SYN-XXXX-…-XXXX. */
export function recoveryCode(key: Buffer): string {
  let bits = 0, acc = 0, out = "";
  for (const b of key) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return `SYN-${out.match(/.{1,4}/g)!.join("-")}`;
}

export function parseRecoveryCode(code: string): Buffer | null {
  const s = String(code).toUpperCase().replace(/^\s*SYN/, "").replace(/[\s-]/g, "");
  if (s.length !== 52 || /[^A-Z2-7]/.test(s)) return null;
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    acc = (acc << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
  }
  return out.length >= 32 ? Buffer.from(out.slice(0, 32)) : null;
}

function headerBytes(h: ArchiveHeader): Buffer {
  const json = Buffer.from(JSON.stringify(h));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, len, json]);
}

export function readArchiveHeader(file: string): ArchiveHeader & { headerEnd: number; size: number } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const pre = Buffer.alloc(12);
    if (fs.readSync(fd, pre, 0, 12, 0) !== 12 || !pre.subarray(0, 8).equals(MAGIC)) throw new Error("That file isn't a Synapse backup.");
    const len = pre.readUInt32BE(8);
    if (len > 4096 || 12 + len + TAG > size) throw new Error("That file isn't a Synapse backup.");
    const json = Buffer.alloc(len);
    fs.readSync(fd, json, 0, len, 12);
    const h = JSON.parse(json.toString("utf8")) as ArchiveHeader;
    if (h.v !== 1 || typeof h.keyId !== "string" || typeof h.iv !== "string") throw new Error("That backup was made by a newer Synapse.");
    return { ...h, headerEnd: 12 + len, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes `<file>.part`, then renames: a crash never leaves a half archive under the real name. */
export async function writeArchive(file: string, key: Buffer, records: AsyncIterable<ArchiveRecord>, meta: { createdAt: number; appVersion: string }): Promise<{ bytes: number }> {
  const iv = randomBytes(12);
  const head = headerBytes({ v: 1, keyId: keyId(key), iv: iv.toString("base64"), createdAt: meta.createdAt, appVersion: meta.appVersion });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const part = `${file}.part`;
  const fd = fs.openSync(part, "w", 0o600);
  try {
    fs.writeSync(fd, head);
    async function* stream() {
      for await (const r of records) yield encodeRecord(r.p, r.data, r.m);
      yield END_RECORD;
    }
    await pipeline(Readable.from(stream()), createGzip(), cipher, fs.createWriteStream("", { fd, autoClose: false }));
    fs.writeSync(fd, cipher.getAuthTag());
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(part, file);
  return { bytes: fs.statSync(file).size };
}

/**
 * Decrypts into `out` (0600) and checks the GCM tag. `out` only exists afterwards if the tag
 * verified, so nothing ever reads plaintext an attacker could have edited.
 */
export async function decryptArchive(file: string, key: Buffer, out: string): Promise<ArchiveHeader> {
  const h = readArchiveHeader(file);
  if (h.keyId !== keyId(key)) throw new Error("This backup was made with a different key. Enter its recovery code.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(h.iv, "base64"));
  const tag = Buffer.alloc(TAG);
  const aad = Buffer.alloc(h.headerEnd);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, aad, 0, h.headerEnd, 0);
  fs.readSync(fd, tag, 0, TAG, h.size - TAG);
  decipher.setAAD(aad);
  fs.closeSync(fd);
  decipher.setAuthTag(tag);
  const part = `${out}.part`;
  try {
    await pipeline(fs.createReadStream(file, { start: h.headerEnd, end: h.size - TAG - 1 }), decipher, fs.createWriteStream(part, { mode: 0o600 }));
  } catch {
    fs.rmSync(part, { force: true });
    throw new Error("This backup is damaged, so it can't be restored.");
  }
  fs.renameSync(part, out);
  return h;
}

/** The records of a decrypted archive (the gzip `decryptArchive` wrote). */
export async function* archiveRecords(plainGz: string): AsyncGenerator<{ meta: RecordMeta; data: Buffer }> {
  yield* readRecords(fs.createReadStream(plainGz).pipe(createGunzip()));
}

/** Re-exported so service.ts builds the host's restore stream with the host's own codec. */
export { END_RECORD, encodeRecord, readRecords };
