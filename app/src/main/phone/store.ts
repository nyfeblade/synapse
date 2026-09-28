import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bug 198: one phone the user paired (its token is only ever kept as a hash). */
export interface PairedDevice { id: string; tokenHash: string; name: string; createdAt: number; lastSeenAt: number }
/** A Web Push subscription from a paired phone (the endpoint is the browser vendor's push service). */
export interface PushSub { deviceId: string; endpoint: string; p256dh: string; auth: string; createdAt: number }

export interface PhoneState {
  /** Phone access is switched on in Settings (the user wants it; `live` in the wiring says it really is). */
  enabled: boolean;
  /** A "remove our mapping" that hasn't succeeded yet: it survives a restart and is retried. */
  offPending: boolean;
  devices: PairedDevice[];
  /** VAPID key pair (P-256): public = the 65-byte point (base64url); the private scalar only SEALED (the app's key file). */
  vapid: { publicKey: string; sealed: string } | null;
  subs: PushSub[];
  /** The serve target Synapse last put on :443 ("unix:/…/phone.sock"), so "off" only ever removes ours. */
  mapped: string | null;
}

/** The app's sealer (the profile's key file, sealing.ts), as the app's other secrets use it. */
export interface Sealer { encrypt(s: string): Buffer; decrypt(b: Buffer): string }

const EMPTY: PhoneState = { enabled: false, offPending: false, devices: [], vapid: null, subs: [], mapped: null };

export const b64url = (b: Buffer): string => b.toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** A fresh VAPID key pair, made on this Mac (nothing leaves it but the public half). */
export function makeVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
  return { publicKey: b64url(point), privateKey: priv.d! };
}

/**
 * Bug 198: Phone access's own file in the app's data folder (0600): paired phones, the push keys and
 * subscriptions, the switch and the serve target. Read on every question — it is tiny and written rarely.
 */
export class PhoneStore {
  constructor(private file: string, private seal?: Sealer) {}

  static in(userData: string, seal?: Sealer): PhoneStore { return new PhoneStore(path.join(userData, "phone-access.json"), seal); }

  read(): PhoneState {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<PhoneState>;
      return {
        enabled: d.enabled === true,
        offPending: d.offPending === true,
        devices: Array.isArray(d.devices) ? d.devices.filter((x) => x && typeof x.id === "string" && typeof x.tokenHash === "string") : [],
        vapid: d.vapid && typeof d.vapid.publicKey === "string" && typeof d.vapid.sealed === "string" ? { publicKey: d.vapid.publicKey, sealed: d.vapid.sealed } : null,
        subs: Array.isArray(d.subs) ? d.subs.filter((x) => x && typeof x.endpoint === "string" && typeof x.deviceId === "string") : [],
        mapped: typeof d.mapped === "string" ? d.mapped : null,
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  write(patch: Partial<PhoneState>): PhoneState {
    const next = { ...this.read(), ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return next;
  }

  /**
   * The VAPID pair. The private half lives in this file only sealed by the app's key file (sealing.ts);
   * with no sealer (secrets aren't open yet) there is no push — this throws rather than store it bare.
   */
  vapid(): { publicKey: string; privateKey: string } {
    if (!this.seal) throw new Error("Call alerts need the app's secrets, which aren't open yet.");
    const s = this.read();
    if (s.vapid) return { publicKey: s.vapid.publicKey, privateKey: this.seal.decrypt(Buffer.from(s.vapid.sealed, "base64")) };
    const v = makeVapidKeys();
    this.write({ vapid: { publicKey: v.publicKey, sealed: this.seal.encrypt(v.privateKey).toString("base64") } });
    return v;
  }

  /** A new paired phone: the token goes to the phone's cookie, only its hash stays here. */
  addDevice(name: string, now = Date.now()): { device: PairedDevice; token: string } {
    const token = b64url(randomBytes(32));
    const device: PairedDevice = { id: randomUUID(), tokenHash: hashToken(token), name: name.slice(0, 60) || "Phone", createdAt: now, lastSeenAt: now };
    this.write({ devices: [...this.read().devices, device] });
    return { device, token };
  }

  deviceForToken(token: string | null | undefined): PairedDevice | null {
    if (!token || token.length > 200) return null;
    const h = hashToken(token);
    return this.read().devices.find((d) => d.tokenHash === h) ?? null;
  }

  touch(id: string, now = Date.now()): void {
    const s = this.read();
    const d = s.devices.find((x) => x.id === id);
    // At most once a minute: this runs on every request.
    if (!d || now - d.lastSeenAt < 60_000) return;
    d.lastSeenAt = now;
    this.write({ devices: s.devices });
  }

  /** Forget a phone: its token stops working at once and its notifications stop. */
  revoke(id: string): boolean {
    const s = this.read();
    if (!s.devices.some((d) => d.id === id)) return false;
    this.write({ devices: s.devices.filter((d) => d.id !== id), subs: s.subs.filter((x) => x.deviceId !== id) });
    return true;
  }

  /** A phone's push subscription. False: that endpoint is another phone's (a phone only ever touches its own). */
  addSub(sub: PushSub): boolean {
    const s = this.read();
    if (s.subs.some((x) => x.endpoint === sub.endpoint && x.deviceId !== sub.deviceId)) return false;
    const mine = s.subs.filter((x) => x.deviceId === sub.deviceId && x.endpoint !== sub.endpoint).slice(-4);
    this.write({ subs: [...s.subs.filter((x) => x.deviceId !== sub.deviceId), ...mine, sub] });
    return true;
  }

  /** Drop a subscription: `deviceId` = only if it is that phone's (the API); none = any (the push service said it's gone). */
  removeSub(endpoint: string, deviceId?: string): void {
    const s = this.read();
    this.write({ subs: s.subs.filter((x) => !(x.endpoint === endpoint && (deviceId === undefined || x.deviceId === deviceId))) });
  }
}
