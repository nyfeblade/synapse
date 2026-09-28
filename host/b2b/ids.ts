import { randomBytes } from "node:crypto";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const RID_RE = /^r_[a-z2-7]{8}$/;

function base32(n: number): string {
  let s = "";
  for (const b of randomBytes(n)) s += B32[b & 31];
  return s;
}

/** ORIG-09 §09.1: request ids `r_<8 base32>`. */
export const newRid = (): string => `r_${base32(8)}`;
export const newChainId = (): string => `c_${randomBytes(6).toString("hex")}`;
export const newTaskId = (): string => `t_${base32(8)}`;
