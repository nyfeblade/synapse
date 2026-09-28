import { randomBytes } from "node:crypto";

/**
 * Capability walks run against the REAL box (real Claude, real screens, the user's plan). They are
 * never part of `npm test` or `npm run e2e`, and they refuse to start unless asked for by name.
 */
export function assertWalkEnv(): void {
  if (process.env.FUZZ !== undefined) throw new Error("walk refused: FUZZ is set — capability walks run against the real box only");
  if (process.env.WALK_REAL !== "1") throw new Error("walk refused: set WALK_REAL=1 to run a capability walk against the real box");
}

export const nonce = (): string => randomBytes(4).toString("hex");

/** Every string that must never reach output. Filled before a secret is used, not after. */
const secrets = new Set<string>();
export function registerSecret(s: string): void { if (s) secrets.add(s); }
export function redact(s: string): string {
  let out = s;
  for (const k of secrets) out = out.split(k).join("[REDACTED]");
  return out;
}

/** Runs `fn`; a failure is rethrown with its message and stack redacted. */
export async function redacting<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const clean = new Error(redact(err.message));
    clean.stack = redact(err.stack ?? "");
    throw clean;
  }
}

/** A labelled timeout. A walk that times out FAILED; it is never a skip. */
export function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`TIMEOUT (${ms} ms): ${label}`)), ms); }),
  ]);
}
