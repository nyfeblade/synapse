import fs from "node:fs";
import { SCRIPT_READ_CAP } from "@synapse/shared";

/**
 * Bug 431: the Mac gate's script reader (PermContext.readScript). Symlinks resolved, then opened non-blocking and checked
 * on the open file itself, so only a regular file is read (a FIFO or device can't stall the gate) and only when it is at
 * most SCRIPT_READ_CAP bytes. Anything else, or any error, is null: the fixed rules then keep today's verdict.
 */
export function readScriptCapped(p: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(fs.realpathSync.native(p), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > SCRIPT_READ_CAP) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (r <= 0) break; n += r; }
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}
