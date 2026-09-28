import fs from "node:fs";
import { LIMITS } from "@synapse/shared";
import { sleep } from "../util/sleep";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readPid(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function acquireHostLock(file: string, opts: { takeoverMs?: number } = {}): Promise<() => void> {
  const takeoverMs = opts.takeoverMs ?? LIMITS.lockTakeoverMs;
  const holder = readPid(file);
  if (holder !== null && holder !== process.pid && isAlive(holder)) {
    process.kill(holder, "SIGTERM");
    const deadline = Date.now() + takeoverMs;
    while (isAlive(holder) && Date.now() < deadline) await sleep(50);
    if (isAlive(holder)) process.kill(holder, "SIGKILL");
  }
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (readPid(file) === process.pid) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}
