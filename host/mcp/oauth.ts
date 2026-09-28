import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME, LIMITS5, STR5, type McpServerStatus } from "@synapse/shared";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GatewayError } from "../gateway/errors";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import type { McpRegistry } from "./registry";

export const OAUTH_LOOPBACK_PORT = 47823;
/** P5 review minor: the Mac's loopback falls back through these; every one is a registered redirect. */
export const OAUTH_LOOPBACK_PORTS: readonly number[] = [47823, 47824, 47825];
export const redirectFor = (port: number) => `http://127.0.0.1:${port}/mcp/oauth/callback`;
export const OAUTH_REDIRECT = redirectFor(OAUTH_LOOPBACK_PORT);

interface Stored { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string }

interface Sealed { v: 1; iv: string; tag: string; ct: string }
const isSealed = (x: unknown): x is Sealed => typeof x === "object" && x !== null && (x as Sealed).v === 1 && typeof (x as Sealed).ct === "string";

/** Tokens and client registrations stay in /home/box/.host/mcp/oauth (0600), sealed with the ORIG-12 vault key
 *  (AES-256-GCM); they never reach a CLI child. Without a key (unit tests) they are stored as plain JSON. */
export class FileOAuthProvider implements OAuthClientProvider {
  lastAuthUrl: URL | null = null;
  private currentState: string | null = null;

  /** legacyKey: files sealed before per-cipher subkeys (the raw vault key) still open, and are re-sealed on the next write. */
  constructor(private file: string, readonly serverId: string, private key?: Uint8Array, private legacyKey?: Uint8Array) {}

  private port = OAUTH_LOOPBACK_PORT;
  setLoopbackPort(port: number): void {
    if (!OAUTH_LOOPBACK_PORTS.includes(port)) throw new GatewayError("BAD_ARGS", "That isn't one of the OAuth loopback ports.");
    this.port = port;
  }
  get redirectUrl(): string { return redirectFor(this.port); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: `${APP_NAME} (${this.serverId})`, redirect_uris: OAUTH_LOOPBACK_PORTS.map(redirectFor), grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  setState(s: string): void { this.currentState = s; }
  state(): string { return this.currentState ?? randomBytes(16).toString("hex"); }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.read().client; }
  saveClientInformation(c: OAuthClientInformationMixed): void { this.write({ client: c }); }
  tokens(): OAuthTokens | undefined { return this.read().tokens; }
  saveTokens(t: OAuthTokens): void { this.write({ tokens: t }); }
  hasTokens(): boolean { return !!this.read().tokens?.access_token; }
  redirectToAuthorization(u: URL): void { this.lastAuthUrl = u; }
  saveCodeVerifier(v: string): void { this.write({ verifier: v }); }
  codeVerifier(): string {
    const v = this.read().verifier;
    if (!v) throw new Error("No PKCE verifier saved for this sign-in.");
    return v;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const cur = this.read();
    if (scope === "all") return void fs.rmSync(this.file, { force: true });
    if (scope === "client") delete cur.client;
    if (scope === "tokens") delete cur.tokens;
    if (scope === "verifier") delete cur.verifier;
    writeJsonAtomic(this.file, this.seal(cur), 0o600);
  }
  private read(): Stored {
    const raw = readJson<Stored | Sealed>(this.file, {});
    if (!isSealed(raw)) return raw as Stored; // legacy plain file: re-sealed on the next write
    for (const k of [this.key, this.legacyKey]) {
      if (!k) continue;
      try {
        const d = createDecipheriv("aes-256-gcm", k, Buffer.from(raw.iv, "base64"));
        d.setAuthTag(Buffer.from(raw.tag, "base64"));
        return JSON.parse(Buffer.concat([d.update(Buffer.from(raw.ct, "base64")), d.final()]).toString("utf8")) as Stored;
      } catch { /* try the next key */ }
    }
    return {};
  }
  private write(patch: Stored): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, this.seal({ ...this.read(), ...patch }), 0o600);
  }
  private seal(s: Stored): Stored | Sealed {
    if (!this.key) return s;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }
}

export class McpOAuth {
  private pending = new Map<string, { serverId: string; createdAt: number }>();
  private providers = new Map<string, FileOAuthProvider>();

  constructor(private d: { dir: string; registry: McpRegistry; now(): number; authFn?: typeof auth; onWaiting(serverId: string): void; onAuthorized(serverId: string): Promise<void>; key?: Uint8Array; legacyKey?: Uint8Array }) {}

  private loopbackPort = OAUTH_LOOPBACK_PORT;
  /** Final secfix item 5: the redirect for the port the Mac bound (the Google sign-in uses it too). */
  get redirectUrl(): string { return redirectFor(this.loopbackPort); }
  /** P5 review minor: the Mac reports which loopback port it could bind. */
  setLoopbackPort(port: number): void {
    if (!OAUTH_LOOPBACK_PORTS.includes(port)) throw new GatewayError("BAD_ARGS", "That isn't one of the OAuth loopback ports.");
    this.loopbackPort = port;
    for (const p of this.providers.values()) p.setLoopbackPort(port);
  }

  providerFor(serverId: string): FileOAuthProvider {
    let p = this.providers.get(serverId);
    if (!p) this.providers.set(serverId, (p = new FileOAuthProvider(path.join(this.d.dir, "oauth", `${serverId}.json`), serverId, this.d.key, this.d.legacyKey)));
    p.setLoopbackPort(this.loopbackPort);
    return p;
  }

  pendingFor(serverId: string): boolean {
    this.prune();
    return [...this.pending.values()].some((p) => p.serverId === serverId);
  }

  async start(serverId: string): Promise<string> {
    const s = this.d.registry.get(serverId);
    if (!s || s.kind !== "remote") throw new GatewayError("NOT_FOUND", `No remote MCP server ${serverId}`, 404);
    const state = randomBytes(16).toString("hex");
    const p = this.providerFor(serverId);
    p.setState(state);
    p.lastAuthUrl = null;
    let r: Awaited<ReturnType<typeof auth>>;
    try {
      r = await (this.d.authFn ?? auth)(p, { serverUrl: s.url! });
    } catch (e) {
      if (/dynamic client registration|incompatible auth server/i.test(String(e))) {
        throw new GatewayError("OAUTH_FAILED", STR5.oauthNeedsHeader);
      }
      throw e;
    }
    if (r === "AUTHORIZED") {
      this.clearPending(serverId);
      await this.d.onAuthorized(serverId);
      return "";
    }
    const authUrl = p.lastAuthUrl as URL | null;
    if (!authUrl) throw new GatewayError("OAUTH_FAILED", "The server didn't provide a sign-in page.");
    this.prune();
    this.pending.set(state, { serverId, createdAt: this.d.now() });
    this.d.onWaiting(serverId);
    return authUrl.toString();
  }

  async complete(a: { state: string; code?: string; error?: string }): Promise<{ serverId: string; status: McpServerStatus }> {
    this.prune();
    const pend = this.pending.get(a.state);
    if (!pend) throw new GatewayError("OAUTH_EXPIRED", "This sign-in link expired. Start again from the Marketplace.", 410);
    this.pending.delete(a.state);
    if (a.error || !a.code) return { serverId: pend.serverId, status: "needs-auth" };
    const s = this.d.registry.get(pend.serverId);
    if (!s) throw new GatewayError("NOT_FOUND", "That connector was removed.", 404);
    const p = this.providerFor(pend.serverId);
    p.setState(a.state);
    const r = await (this.d.authFn ?? auth)(p, { serverUrl: s.url!, authorizationCode: a.code });
    if (r !== "AUTHORIZED") return { serverId: pend.serverId, status: "needs-auth" };
    this.clearPending(pend.serverId);
    await this.d.onAuthorized(pend.serverId);
    return { serverId: pend.serverId, status: "connected" };
  }

  forget(serverId: string): void {
    this.providerFor(serverId).invalidateCredentials("all");
    this.providers.delete(serverId);
  }

  /** Task 34 fuzz: signing in through a Reopened tab ends every other pending sign-in for that server
   *  (an abandoned first tab used to keep the entry "Waiting for authorization" for 11 minutes). */
  private clearPending(serverId: string): void {
    for (const [k, v] of this.pending) if (v.serverId === serverId) this.pending.delete(k);
  }

  private prune(): void {
    for (const [k, v] of this.pending) if (this.d.now() - v.createdAt > LIMITS5.mcpOAuthPendingTtlMs) this.pending.delete(k);
  }
}
