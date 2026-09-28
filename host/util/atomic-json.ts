import fs from "node:fs";
import path from "node:path";
import { envSetting } from "@synapse/shared";

/**
 * Whether a durable write waits on the device before it renames. On by default; SYNAPSE_ATOMIC_FSYNC=off
 * turns it off, and host/vitest.config.ts sets that for the suite.
 *
 * fsync is not CPU work the OS can timeshare — it is a barrier the storage device has to honour,
 * and every vitest worker on the machine queues on the same device. Measured on this repo: ~9.0 ms
 * per atomic write with fsync versus ~1.4 ms without, and it degrades further the more workers run.
 * The host's cap and history tests do hundreds to thousands of durable writes each (the routine
 * store's "20 max, ≤1,000 archive lines" test alone issues 2,040 fsyncs, 77.5% of its 17 s), which
 * is why a rotating set of host files reported "Test timed out in 20000ms" only under load and
 * passed in isolation: they were measuring the disk queue, not the code.
 *
 * Only the fsync is optional. The temp file and the rename — what actually makes a concurrent
 * reader see either the whole old file or the whole new one — always happen, so a test still
 * exercises the real write path. host/test/util/durable-writes.test.ts pins both halves.
 */
let fsyncOn = envSetting(process.env, "ATOMIC_FSYNC") !== "off";

/** Returns the previous setting, so a test that needs the real thing can put it back. */
export function setFsyncOnWrite(on: boolean): boolean {
  const was = fsyncOn;
  fsyncOn = on;
  return was;
}

export function fsyncOnWrite(): boolean {
  return fsyncOn;
}

/** The one place the durability decision is made, shared by every atomic writer in the host. */
export function syncIfDurable(fd: number): void {
  if (fsyncOn) fs.fsyncSync(fd);
}

export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    syncIfDurable(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Like readJson, but a file whose *contents* cannot be parsed is moved aside instead of taking
 * the caller down: a settings.json truncated by a crash or a full disk must not stop the host from
 * starting, and must not be quietly overwritten in place either. IO errors (EACCES, EIO, …) still
 * throw — those are not corruption, and starting from the defaults would risk losing real state. */
export function readJsonOrQuarantine<T>(file: string, fallback: T): { value: T; quarantined: string | null } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) as T, quarantined: null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { value: fallback, quarantined: null };
    if (!(e instanceof SyntaxError)) throw e;
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    return { value: fallback, quarantined: aside };
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}
