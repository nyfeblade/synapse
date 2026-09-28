import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSafeFolderId } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { vaultKeySync } from "../secrets/crypto";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

export type ConnectorPlatform = "slack" | "github" | "linear" | "sentry";
interface Sealed { sealed: 1; iv: string; ct: string; tag: string }
const isSealed = (v: unknown): v is Sealed => !!v && typeof v === "object" && (v as Sealed).sealed === 1;

/** Field names the scanner labels a connector value with (I10). */
const LABEL: Record<string, string> = {
  appToken: "SLACK_APP_TOKEN", botToken: "SLACK_BOT_TOKEN", token: "GITHUB_TOKEN", signingSecret: "WEBHOOK_SIGNING_SECRET", appPassword: "IMAP_PASSWORD",
};

/**
 * I4: listener credentials (Slack/GitHub tokens and provider signing secrets) sealed at rest with an HKDF
 * subkey of the ORIG-12 vault key, in `/home/box/.host/connector-secrets/<botId>/<platform>.json` (0600).
 * A legacy plaintext file still reads, and is sealed on the next write. Never visible to the Bot.
 */
export class ConnectorSecrets {
  private k: Buffer | null = null;
  private listeners = new Set<(botId: string) => void>();

  constructor(private hostPrivate: string) {}

  private key(): Buffer {
    return (this.k ??= Buffer.from(hkdfSync("sha256", vaultKeySync(this.hostPrivate), Buffer.alloc(0), "bots/connector-secrets/v1", 32)));
  }

  dir(botId: string): string {
    if (!isSafeFolderId(botId)) throw new GatewayError("INVALID_BOT_ID", `Invalid Bot id: ${JSON.stringify(botId)}`, 400);
    return path.join(this.hostPrivate, "connector-secrets", botId);
  }

  private file(botId: string, platform: ConnectorPlatform): string {
    return path.join(this.dir(botId), `${platform}.json`);
  }

  private open(raw: unknown): Record<string, string> | null {
    if (!raw || typeof raw !== "object") return null;
    if (!isSealed(raw)) return raw as Record<string, string>;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(raw.iv, "base64"));
      d.setAuthTag(Buffer.from(raw.tag, "base64"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as Record<string, string>;
    } catch {
      return null; // tampered or a different vault key: treated as not connected
    }
  }

  get(botId: string, platform: ConnectorPlatform): Record<string, string> | null {
    return this.open(readJson<unknown>(this.file(botId, platform), null));
  }

  set(botId: string, platform: ConnectorPlatform, fields: Record<string, string>): void {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(fields), "utf8"), c.final()]);
    fs.mkdirSync(this.dir(botId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file(botId, platform), { sealed: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") } satisfies Sealed, 0o600);
    for (const l of this.listeners) l(botId);
  }

  /** I10: every connector secret value of the Bot (listener tokens, signing secrets, IMAP passwords) for the scanner. */
  values(botId: string): { name: string; value: string }[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir(botId)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: { name: string; value: string }[] = [];
    for (const f of names) {
      const rec = this.open(readJson<unknown>(path.join(this.dir(botId), f), null)) ?? {};
      for (const [k, v] of Object.entries(rec)) if (LABEL[k] && typeof v === "string" && v) out.push({ name: LABEL[k]!, value: v });
    }
    return out;
  }

  onChange(cb: (botId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  changed(botId: string): void {
    for (const l of this.listeners) l(botId);
  }
}
