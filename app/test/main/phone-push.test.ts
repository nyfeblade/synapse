import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPayload, pushEndpointAllowed, sendPush, vapidJwt, vapidSubject } from "../../src/main/phone/push";
import { makeVapidKeys } from "../../src/main/phone/store";
import { decryptAes128gcm } from "../fixtures/webpush";

// Bug 198: Web Push with no library. What the phone's browser does on receipt (RFC 8291 decryption)
// is written out here independently, from the receiving side's keys.

function uaKeys() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { privateKey: e.getPrivateKey(), publicKey: e.getPublicKey(), auth: randomBytes(16) };
}

describe("RFC 8291 payload encryption", () => {
  it("the phone's browser can read what the Mac encrypted (and only it)", () => {
    const ua = uaKeys();
    const msg = Buffer.from(JSON.stringify({ title: "Nova is calling", body: "About the launch", botId: "b1" }));
    const body = encryptPayload(msg, ua.publicKey, ua.auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(decryptAes128gcm(body, ua, ua.auth).toString()).toBe(msg.toString());
    const other = uaKeys();
    expect(() => decryptAes128gcm(body, { ...other, publicKey: ua.publicKey }, ua.auth)).toThrow();
    expect(() => decryptAes128gcm(body, ua, randomBytes(16))).toThrow();
  });

  it("refuses a malformed browser key", () => {
    expect(() => encryptPayload(Buffer.from("x"), randomBytes(64), randomBytes(16))).toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs a JWT for the push service's origin that verifies with the public key", () => {
    const v = makeVapidKeys();
    const jwt = vapidJwt({ audience: "https://web.push.apple.com", subject: "mailto:me@example.com", ...v, now: 1_700_000_000_000 });
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ aud: "https://web.push.apple.com", exp: 1_700_000_000 + 12 * 3600, sub: "mailto:me@example.com" });
    const pub = Buffer.from(v.publicKey, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"))).toBe(true);
  });

  it("uses a mailto: subject when the login is an email, else the tailnet https URL", () => {
    expect(vapidSubject("me@example.com", "mac.t.ts.net")).toBe("mailto:me@example.com");
    expect(vapidSubject("github-user", "mac.t.ts.net")).toBe("https://mac.t.ts.net");
  });
});

describe("sending", () => {
  it("POSTs aes128gcm ciphertext with the VAPID header to the subscription's endpoint", async () => {
    const ua = uaKeys();
    const v = makeVapidKeys();
    const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const r = await sendPush(
      { deviceId: "d", endpoint: "https://web.push.apple.com/QABC", p256dh: ua.publicKey.toString("base64url"), auth: ua.auth.toString("base64url"), createdAt: 0 },
      { title: "Nova is calling", body: "Now", botId: "b1", tag: "call-b1" },
      { vapid: v, subject: "mailto:me@example.com", fetch: async (url, init) => { seen.push({ url, ...init }); return { status: 201 }; } },
    );
    expect(r).toEqual({ ok: true, status: 201, gone: false });
    expect(seen[0]!.url).toBe("https://web.push.apple.com/QABC");
    expect(seen[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(seen[0]!.headers.Authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${v.publicKey}$`));
    expect(seen[0]!.headers.Topic).toBe("call-b1");
    // A redirect would carry the signed request somewhere else: never followed.
    expect((seen[0] as unknown as { redirect: string }).redirect).toBe("error");
    expect(JSON.parse(decryptAes128gcm(seen[0]!.body, ua, ua.auth).toString())).toEqual({ title: "Nova is calling", body: "Now", botId: "b1", tag: "call-b1" });
  });

  it("a 410 means the subscription is gone", async () => {
    const ua = uaKeys();
    const r = await sendPush({ deviceId: "d", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: ua.publicKey.toString("base64url"), auth: ua.auth.toString("base64url"), createdAt: 0 },
      { title: "t", body: "b" }, { vapid: makeVapidKeys(), subject: "mailto:a@b.co", fetch: async () => ({ status: 410 }) });
    expect(r.gone).toBe(true);
  });

  it("only sends to real push services (never an arbitrary URL a page hands over)", () => {
    expect(pushEndpointAllowed("https://web.push.apple.com/abc")).toBe(true);
    expect(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(pushEndpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(pushEndpointAllowed("https://evil.example/push")).toBe(false);
    expect(pushEndpointAllowed("http://web.push.apple.com/abc")).toBe(false);
    expect(pushEndpointAllowed("http://127.0.0.1:9/x")).toBe(false);
    expect(pushEndpointAllowed("http://127.0.0.1:9/x", true)).toBe(true);
  });
});
