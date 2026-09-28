/**
 * The Synapse backup record stream: one file after another, each a 4-byte big-endian header length,
 * a JSON header { p: path, n: bytes, m?: mode }, then exactly n bytes; four zero bytes end it.
 *
 * Both ends are ours (the host writes it, the Mac stores it inside the encrypted archive and sends it
 * back), so this is deliberately simpler than tar: no links, no devices, no owners, and every path is
 * checked by safeRecordPath() before anything is written from it.
 */
export interface RecordMeta { p: string; n: number; m?: number }

export const END_RECORD = Buffer.alloc(4);
const MAX_HEADER = 64 * 1024;
const SEGMENT = /^[A-Za-z0-9_@+=,.~ -]+$/;

/** A relative path of plain segments: no "", ".", "..", absolute paths, backslashes or control characters. */
export function safeRecordPath(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/")) return false;
  return p.split("/").every((s) => s !== "." && s !== ".." && SEGMENT.test(s));
}

export function encodeRecord(p: string, data: Buffer, mode?: number): Buffer {
  if (!safeRecordPath(p)) throw new Error(`backup: unsafe record path ${JSON.stringify(p)}`);
  const head = Buffer.from(JSON.stringify(mode === undefined ? { p, n: data.length } : { p, n: data.length, m: mode & 0o777 }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, data]);
}

/** Parses a record stream. Throws on a bad path, a malformed header or a stream that ends early. */
export async function* readRecords(src: AsyncIterable<Buffer | string>): AsyncGenerator<{ meta: RecordMeta; data: Buffer }> {
  let buf = Buffer.alloc(0);
  let ended = false;
  const it = src[Symbol.asyncIterator]();
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const r = await it.next();
      if (r.done) return false;
      buf = Buffer.concat([buf, Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value)]);
    }
    return true;
  };
  for (;;) {
    if (!(await need(4))) break;
    const hl = buf.readUInt32BE(0);
    if (hl === 0) { ended = true; buf = buf.subarray(4); break; }
    if (hl > MAX_HEADER) throw new Error("backup: malformed record header");
    if (!(await need(4 + hl))) break;
    let meta: RecordMeta;
    try { meta = JSON.parse(buf.subarray(4, 4 + hl).toString("utf8")) as RecordMeta; } catch { throw new Error("backup: malformed record header"); }
    if (!meta || !safeRecordPath(meta.p)) throw new Error("backup: a record has an unsafe path");
    if (!Number.isSafeInteger(meta.n) || meta.n < 0) throw new Error("backup: malformed record size");
    if (!(await need(4 + hl + meta.n))) break;
    const data = Buffer.from(buf.subarray(4 + hl, 4 + hl + meta.n));
    buf = buf.subarray(4 + hl + meta.n);
    yield { meta, data };
  }
  if (!ended) throw new Error("backup: the record stream is truncated");
}
