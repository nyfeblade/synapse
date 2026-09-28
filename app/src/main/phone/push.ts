import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { PushSub } from "./store";

/**
 * Bug 198: Web Push from this Mac, with no push library and no account anywhere: the payload is
 * encrypted for the phone's browser (RFC 8291, aes128gcm) and the request is signed with this
 * Mac's own VAPID key (RFC 8292). The browser vendor's push service (Apple / Google) only relays
 * ciphertext it can't read.
 */

const b64u = (b: Buffer) => b.toString("base64url");

/** RFC 8291 §3.4 + RFC 8188: one record, the payload followed by the 0x02 last-record delimiter. */
export function encryptPayload(payload: Buffer, uaPublic: Buffer, authSecret: Buffer, o: { salt?: Buffer; asKeys?: { privateKey: Buffer; publicKey: Buffer } } = {}): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("That push key isn't valid.");
  if (authSecret.length < 16) throw new Error("That push secret isn't valid.");
  const ecdh = createECDH("prime256v1");
  if (o.asKeys) ecdh.setPrivateKey(o.asKeys.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = o.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** RFC 8292: the ES256-signed claim that this request comes from the holder of the VAPID key. */
export function vapidJwt(o: { audience: string; subject: string; publicKey: string; privateKey: string; now?: number }): string {
  const pub = Buffer.from(o.publicKey, "base64url");
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: o.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: o.audience, exp: now + 12 * 3600, sub: o.subject })));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64u(sig)}`;
}

/** Apple rejects a subject that isn't a mailto: or https: URL. */
export function vapidSubject(login: string | null, dnsName: string | null): string {
  if (login && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return `mailto:${login}`;
  return `https://${dnsName ?? "synapse.invalid"}`;
}

/** Only the push services a phone browser really uses (and a loopback one for the tests). */
export function pushEndpointAllowed(endpoint: string, allowLoopback = false): boolean {
  try {
    const u = new URL(endpoint);
    if (allowLoopback && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return u.protocol === "http:" || u.protocol === "https:";
    if (u.protocol !== "https:") return false;
    return /(^|\.)push\.apple\.com$|^fcm\.googleapis\.com$|(^|\.)push\.services\.mozilla\.com$|(^|\.)notify\.windows\.com$|^android\.googleapis\.com$/.test(u.hostname);
  } catch { return false; }
}

export interface PushMessage { title: string; body: string; botId?: string; tag?: string }

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; redirect: "error" }) => Promise<{ status: number }>;

/** Sends to one subscription. `gone`: the push service says it no longer exists (drop it). */
export async function sendPush(sub: PushSub, msg: PushMessage, o: { vapid: { publicKey: string; privateKey: string }; subject: string; fetch?: Fetch; ttl?: number }): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const body = encryptPayload(Buffer.from(JSON.stringify(msg), "utf8"), Buffer.from(sub.p256dh, "base64url"), Buffer.from(sub.auth, "base64url"));
  const audience = new URL(sub.endpoint).origin;
  const jwt = vapidJwt({ audience, subject: o.subject, ...o.vapid });
  // A push service never redirects; following one would send the signed request somewhere else.
  const f: Fetch = o.fetch ?? (async (url, init) => { const r = await fetch(url, { method: init.method, headers: init.headers, body: new Uint8Array(init.body), redirect: init.redirect }); return { status: r.status }; });
  const r = await f(sub.endpoint, {
    method: "POST", redirect: "error",
    headers: {
      TTL: String(o.ttl ?? 60), Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      Authorization: `vapid t=${jwt}, k=${o.vapid.publicKey}`,
      ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
    },
    body,
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
}
