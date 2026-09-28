import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** ORIG-04 §04.2: bot_ + 32 base62 chars (190 bits), unbiased (bytes ≥ 248 are rejected). */
export function newWebhookKey(): string {
  let out = "";
  while (out.length < 32) {
    for (const b of randomBytes(48)) {
      if (b >= 248) continue;
      out += B62[b % 62];
      if (out.length === 32) break;
    }
  }
  return `bot_${out}`;
}
export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");
export const keyPreview = (key: string) => key.slice(-4);
export function verifyKey(key: string, hash: string): boolean {
  const a = Buffer.from(hashKey(key), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
