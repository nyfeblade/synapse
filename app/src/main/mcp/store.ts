import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MCP_LIMITS, MCP_PROTOCOL } from "@synapse/shared";
import { writeFileAtomic } from "../atomic-file";

/** The app's sealer (the profile's key file, sealing.ts), as the app's other secrets use it. */
export interface Sealer { encrypt(s: string): Buffer; decrypt(b: Buffer): string }

/** One approved MCP client. Its token is kept only SEALED; the helper holds the plaintext copy. */
export interface McpClient { id: string; key: string; name: string; exe: string | null; createdAt: number; lastSeenAt: number; sealed: string }
export interface McpState { enabled: boolean; clients: McpClient[] }
/** What Settings shows of a client: never its token. */
export type McpClientView = Omit<McpClient, "sealed">;

/** The proof a helper sends: HMAC(token, protocol ‖ nonce ‖ key). Bound to this connection's nonce, so never replayable. */
export function proofFor(token: string, nonce: string, key: string): string {
  return createHmac("sha256", token).update(`${MCP_PROTOCOL}\n${nonce}\n${key}`).digest("hex");
}

/**
 * 0.1.4 — Settings → System → MCP's own file in the app's data folder (0600): the switch (off by default) and the
 * approved clients. Read on every question — it is tiny and written rarely.
 */
export class McpStore {
  constructor(private file: string, private seal: Sealer | null) {}

  static in(userData: string, seal: Sealer | null): McpStore { return new McpStore(path.join(userData, "mcp-access.json"), seal); }

  read(): McpState {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<McpState>;
      const clients = Array.isArray(d.clients) ? d.clients.filter((c) => c && typeof c.id === "string" && typeof c.key === "string" && typeof c.sealed === "string") : [];
      return { enabled: d.enabled === true, clients };
    } catch {
      return { enabled: false, clients: [] };
    }
  }

  private write(next: McpState): McpState {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    return next;
  }

  setEnabled(on: boolean): McpState { return this.write({ ...this.read(), enabled: on }); }

  byKey(key: string): McpClient | null { return this.read().clients.find((c) => c.key === key) ?? null; }
  byId(id: string): McpClient | null { return this.read().clients.find((c) => c.id === id) ?? null; }

  views(): McpClientView[] {
    return this.read().clients.map(({ sealed: _s, ...v }) => v);
  }

  /** Allow: a fresh token for this key (replacing any older one). Throws when the app's secrets aren't open. */
  approve(key: string, name: string, exe: string | null, now = Date.now()): { client: McpClient; token: string } {
    if (!this.seal) throw new Error("Synapse's secrets aren't open yet.");
    const token = randomBytes(32).toString("base64url");
    const sealed = this.seal.encrypt(token).toString("base64");
    const s = this.read();
    const old = s.clients.find((c) => c.key === key);
    const client: McpClient = { id: old?.id ?? randomUUID(), key, name, exe, createdAt: now, lastSeenAt: now, sealed };
    this.write({ ...s, clients: [...s.clients.filter((c) => c.key !== key), client] });
    return { client, token };
  }

  /** The helper's proof for this connection's nonce, checked in constant time against the sealed token. */
  verify(client: McpClient, nonce: string, proof: unknown): boolean {
    if (!this.seal || typeof proof !== "string" || !/^[0-9a-f]{64}$/.test(proof)) return false;
    let token: string;
    try { token = this.seal.decrypt(Buffer.from(client.sealed, "base64")); } catch { return false; }
    return timingSafeEqual(Buffer.from(proofFor(token, nonce, client.key), "hex"), Buffer.from(proof, "hex"));
  }

  touch(id: string, now = Date.now()): void {
    const s = this.read();
    const c = s.clients.find((x) => x.id === id);
    if (!c || now - c.lastSeenAt < 60_000) return;
    c.lastSeenAt = now;
    this.write(s);
  }

  /** Revoke: the token stops working at once (the server closes its connections). */
  revoke(id: string): McpClient | null {
    const s = this.read();
    const c = s.clients.find((x) => x.id === id) ?? null;
    if (c) this.write({ ...s, clients: s.clients.filter((x) => x.id !== id) });
    return c;
  }
}

export type McpOutcome = "ok" | "refused" | "limited" | "error" | "approved" | "denied" | "revoked";
export interface McpAuditEntry { at: number; clientId: string | null; client: string; tool: string; bot: string | null; outcome: McpOutcome; detail?: string }

/**
 * 0.1.4 — every MCP call (and every refusal), newest last, in `<userData>/mcp-audit.jsonl` (0600). Loaded on first
 * use only (nothing is read while MCP access is off) and trimmed to the newest MCP_LIMITS.auditKeep entries.
 */
export class McpAudit {
  private entries: McpAuditEntry[] | null = null;
  constructor(private file: string) {}

  static in(userData: string): McpAudit { return new McpAudit(path.join(userData, "mcp-audit.jsonl")); }

  private load(): McpAuditEntry[] {
    if (this.entries) return this.entries;
    try {
      this.entries = fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as McpAuditEntry]; } catch { return []; } });
    } catch { this.entries = []; }
    return this.entries;
  }

  record(e: McpAuditEntry): void {
    const all = this.load();
    all.push(e);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (all.length > MCP_LIMITS.auditKeep * 1.2) {
      this.entries = all.slice(-MCP_LIMITS.auditKeep);
      writeFileAtomic(this.file, this.entries.map((x) => JSON.stringify(x)).join("\n") + "\n", 0o600);
    } else {
      fs.appendFileSync(this.file, JSON.stringify(e) + "\n", { mode: 0o600 });
    }
  }

  /** Newest first. */
  recent(n: number = MCP_LIMITS.auditShown): McpAuditEntry[] { return this.load().slice(-n).reverse(); }
}
