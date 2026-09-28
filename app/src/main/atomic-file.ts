import fs from "node:fs";
import path from "node:path";

/**
 * The Mac side's one durable-write helper, mirroring host/util/atomic-json.ts: write a temp file in
 * the same directory, fsync it, then rename it over the name. Without the fsync a rename can be
 * visible while the bytes it points at are not, which is exactly how a power loss leaves a
 * zero-length or half-written secrets vault / snapshot index behind.
 */
export function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`; // <file>.<pid>.<ts>.tmp, the project-wide convention
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    rm(tmp);
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    rm(tmp);
    throw e;
  }
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600, space?: number): void {
  writeFileAtomic(file, JSON.stringify(value, null, space), mode);
}

/**
 * Reads JSON that must never be mistaken for "nothing here". ENOENT alone means the file has not
 * been written yet and yields `fallback`; a truncated, unparsable or unreadable file throws, so a
 * caller can't act on an empty view of state it actually failed to load (ORIG-12 §12.1: for the
 * secrets vault that mistake deletes every secret on the box).
 */
export function readJsonStrict<T>(file: string, fallback: T, valid?: (v: unknown) => boolean): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Couldn't read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is damaged and couldn't be read: ${(e as Error).message}`);
  }
  if (valid && !valid(parsed)) throw new Error(`${file} is damaged and couldn't be read: unexpected contents`);
  return parsed as T;
}

function rm(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* the temp file is already gone */
  }
}
