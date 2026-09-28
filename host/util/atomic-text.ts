import fs from "node:fs";
import path from "node:path";
import { syncIfDurable } from "./atomic-json";

/** Same convention as writeJsonAtomic: temp file, fsync, rename. */
export function writeTextAtomic(file: string, text: string, mode = 0o640): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, text);
    syncIfDurable(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
