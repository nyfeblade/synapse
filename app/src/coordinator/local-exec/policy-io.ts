import fs from "node:fs";

/** The policy files' raw JSON read (null when missing or unparsable) and their atomic, private write. */
export const readRaw = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as unknown; } catch { return null; } };
export const writeRaw = (f: string, v: unknown): void => {
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(v, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
};
