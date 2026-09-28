import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { SigningProvider } from "./webhook-server";

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const hmacHex = (secret: string, data: Buffer) => createHmac("sha256", secret).update(data).digest("hex");
const header = (h: http.IncomingHttpHeaders, n: string) => { const v = h[n]; return Array.isArray(v) ? v[0] : v; };

export function verifyGithubSignature(secret: string, body: Buffer, sig: string | undefined): boolean {
  return !!sig && safeEq(sig, `sha256=${hmacHex(secret, body)}`);
}

export function verifySlackSignature(secret: string, body: Buffer, ts: string | undefined, sig: string | undefined, nowMs: number): boolean {
  if (!ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > 300) return false;
  return safeEq(sig, `v0=${hmacHex(secret, Buffer.concat([Buffer.from(`v0:${ts}:`), body]))}`);
}

export function verifyHmacHex(secret: string, body: Buffer, sig: string | undefined): boolean {
  return !!sig && safeEq(sig.toLowerCase(), hmacHex(secret, body));
}

export function verifyProviderSignature(provider: SigningProvider, secret: string, h: http.IncomingHttpHeaders, body: Buffer, nowMs: number): boolean {
  switch (provider) {
    case "github": return verifyGithubSignature(secret, body, header(h, "x-hub-signature-256"));
    case "slack": return verifySlackSignature(secret, body, header(h, "x-slack-request-timestamp"), header(h, "x-slack-signature"), nowMs);
    case "linear": return verifyHmacHex(secret, body, header(h, "linear-signature"));
    case "sentry": return verifyHmacHex(secret, body, header(h, "sentry-hook-signature"));
  }
}
