import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";

/**
 * Bug 198: what a browser does when a Web Push arrives (RFC 8291 aes128gcm decryption), written out
 * independently of the sender, from the receiving side's keys. Used by the unit and e2e tests.
 */
export function decryptAes128gcm(body: Buffer, ua: { privateKey: Buffer; publicKey: Buffer }, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(ua.privateKey);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.publicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const ct = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("no last-record delimiter");
  return plain.subarray(0, end);
}
