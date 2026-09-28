import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { writeTextAtomic } from "../util/atomic-text";

/** TCH-03: the recording queue entry is HMAC-signed with a host-private key, so TeachAnalyze only opens sessions the host recorded. */
export interface QueueEntry { sessionId: string; botId: string; sessionDir: string; createdAt: number; sig: string }

export function loadQueueKey(file: string): Buffer {
  const k = readJson<{ key: string } | null>(file, null);
  if (k) return Buffer.from(k.key, "base64");
  const key = randomBytes(32);
  writeJsonAtomic(file, { key: key.toString("base64") }, 0o600);
  return key;
}

const sign = (key: Buffer, e: Omit<QueueEntry, "sig">) =>
  createHmac("sha256", key).update(JSON.stringify([e.sessionId, e.botId, e.sessionDir, e.createdAt])).digest("hex");

export function appendQueueEntry(o: { keyFile: string; queueFile: string; entry: Omit<QueueEntry, "sig"> }): QueueEntry {
  const full: QueueEntry = { ...o.entry, sig: sign(loadQueueKey(o.keyFile), o.entry) };
  fs.appendFileSync(o.queueFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
  return full;
}

export function findQueueEntry(o: { keyFile: string; queueFile: string; sessionId: string; botId: string }): QueueEntry | null {
  if (!fs.existsSync(o.queueFile)) return null;
  const key = loadQueueKey(o.keyFile);
  const lines = fs.readFileSync(o.queueFile, "utf8").split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    let e: QueueEntry;
    try {
      e = JSON.parse(line) as QueueEntry;
    } catch {
      continue;
    }
    if (e.sessionId !== o.sessionId || e.botId !== o.botId) continue;
    const want = Buffer.from(sign(key, e), "hex");
    const got = Buffer.from(String(e.sig), "hex");
    if (got.length === want.length && timingSafeEqual(got, want)) return e;
  }
  return null;
}

/** I7: drop every queue entry of a deleted Bot; returns the removed entries whose signature verified. */
export function removeBotEntries(o: { keyFile: string; queueFile: string; botId: string }): QueueEntry[] {
  if (!fs.existsSync(o.queueFile)) return [];
  const key = loadQueueKey(o.keyFile);
  const keep: string[] = [];
  const removed: QueueEntry[] = [];
  for (const line of fs.readFileSync(o.queueFile, "utf8").split("\n").filter(Boolean)) {
    let e: QueueEntry | null = null;
    try { e = JSON.parse(line) as QueueEntry; } catch { /* malformed: dropped */ }
    if (!e) continue;
    if (e.botId !== o.botId) { keep.push(line); continue; }
    const want = Buffer.from(sign(key, e), "hex");
    const got = Buffer.from(String(e.sig), "hex");
    if (got.length === want.length && timingSafeEqual(got, want)) removed.push(e);
  }
  writeTextAtomic(o.queueFile, keep.length ? `${keep.join("\n")}\n` : "", 0o600);
  return removed;
}
