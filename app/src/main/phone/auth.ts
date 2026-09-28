import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Bug 198: who may talk to the phone server. Three gates, all of them required:
 *
 * 1. The request came THROUGH `tailscale serve`: it arrived on the server's own Unix socket (0600,
 *    in a 0700 folder of the app's data — the only transport; there is no TCP listener) AND
 *    Tailscale's identity header is present. serve sets `Tailscale-User-Login` itself for every
 *    tailnet user and drops one a client sent (see MIN_TAILSCALE_VERSION), so it can't be forged; on
 *    anything but that socket it is never believed at all.
 * 2. That login is the Mac's own Tailscale user: another person on a shared tailnet is refused.
 * 3. The Host is this Mac's tailnet name.
 *
 * Then the API and the call socket also want a paired device's cookie (store.ts, pairing below).
 */

export const COOKIE = "synapse_phone";
export const TAILSCALE_LOGIN = "tailscale-user-login";

export type Denied = { ok: false; status: 403; why: string };
export type Gate = { ok: true; login: string } | Denied;

/** The Host a request may carry: this Mac's tailnet name (what serve forwards). */
export function allowedHosts(dnsName: string | null): Set<string> {
  const s = new Set<string>();
  if (dnsName) { s.add(dnsName.toLowerCase()); s.add(`${dnsName.toLowerCase()}:443`); }
  return s;
}

const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : Array.isArray(v) && v.length === 1 ? v[0]! : null);

/** `viaSocket`: the request came in on the server's own Unix socket — the ONLY way identity is trusted. */
export function checkTailnet(req: { headers: IncomingHttpHeaders }, owner: { login: string | null; hosts: Set<string>; viaSocket: boolean }): Gate {
  if (!owner.viaSocket) return { ok: false, status: 403, why: "not-socket" };
  const login = one(req.headers[TAILSCALE_LOGIN]);
  if (!login) return { ok: false, status: 403, why: "no-tailnet-identity" };
  if (!owner.login) return { ok: false, status: 403, why: "owner-unknown" };
  if (login.trim().toLowerCase() !== owner.login.trim().toLowerCase()) return { ok: false, status: 403, why: "wrong-user" };
  const host = (one(req.headers.host) ?? "").toLowerCase();
  if (!owner.hosts.has(host)) return { ok: false, status: 403, why: "wrong-host" };
  return { ok: true, login };
}

/** A WebSocket may only be opened by the page this server served (cross-site socket hijacking). */
export function originAllowed(origin: string | undefined, hosts: Set<string>): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return false;
    return hosts.has(u.host.toLowerCase());
  } catch { return false; }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** The paired device's cookie: httpOnly (no script reads it), Secure, SameSite=Strict, a year. */
export function deviceCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}
export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Pairing codes are six digits, live ten minutes, and die after five wrong tries. */
export const PAIRING = { digits: 6, ttlMs: 10 * 60_000, maxTries: 5 } as const;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * Bug 198: the one-time code Settings shows for pairing a phone. One code at a time; using it,
 * five wrong guesses, ten minutes or Settings closing it all end it. The code is typed on the phone
 * and POSTed — it never appears in a URL.
 */
export class Pairing {
  private code: { hash: Buffer; expiresAt: number; tries: number } | null = null;
  constructor(private now: () => number = Date.now) {}

  start(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 10 ** PAIRING.digits)).padStart(PAIRING.digits, "0");
    const expiresAt = this.now() + PAIRING.ttlMs;
    this.code = { hash: digest(code), expiresAt, tries: 0 };
    return { code, expiresAt };
  }

  cancel(): void { this.code = null; }

  active(): boolean {
    if (this.code && this.now() > this.code.expiresAt) this.code = null;
    return this.code !== null;
  }

  /** True once, for the right code. */
  redeem(input: unknown): boolean {
    if (!this.active() || typeof input !== "string") return false;
    const typed = input.replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(typed)) { this.miss(); return false; }
    const ok = timingSafeEqual(digest(typed), this.code!.hash);
    if (!ok) { this.miss(); return false; }
    this.code = null;
    return true;
  }

  private miss(): void {
    if (!this.code) return;
    this.code.tries += 1;
    if (this.code.tries >= PAIRING.maxTries) this.code = null;
  }
}

/** Refused requests are logged at most once per reason every 10 s (with how many were folded in). */
export function throttledLog(log: ((line: string) => void) | undefined, everyMs = 10_000, now: () => number = Date.now): (why: string) => void {
  const last = new Map<string, { at: number; n: number }>();
  return (why) => {
    const t = now();
    const e = last.get(why);
    if (e && t - e.at < everyMs) { e.n++; return; }
    last.set(why, { at: t, n: 0 });
    log?.(`phone: refused (${why})${e?.n ? ` (+${e.n} more since)` : ""}`);
  };
}

/** A short, human name for a paired phone, from its browser (shown in Settings; never trusted). */
export function deviceName(ua: string | undefined): string {
  const u = ua ?? "";
  if (/iPhone/.test(u)) return "iPhone";
  if (/iPad/.test(u)) return "iPad";
  if (/Android/.test(u)) { const m = /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(u); return m?.[1] && !/^[kK]$/.test(m[1].trim()) ? m[1].trim().slice(0, 40) : "Android phone"; }
  if (/Macintosh/.test(u)) return "Mac";
  return "Phone";
}
