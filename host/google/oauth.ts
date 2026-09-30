import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES, LIMITS5, STRG, type GoogleService, type GoogleStatusView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { GoogleEndpoints } from "./endpoints";
import type { GoogleStore, GoogleTokens } from "./store";

export type GoogleAuthErrorKind = "not-connected" | "needs-reconnect" | "failed";
export class GoogleAuthError extends Error {
  constructor(readonly kind: GoogleAuthErrorKind, message: string) { super(message); }
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const SKEW_MS = 60_000;
const SERVICE_OF: Record<string, GoogleService> = { gmail: "Gmail", calendar: "Calendar", drive: "Drive" };

export function servicesOf(scope: string): GoogleService[] {
  const out = new Set<GoogleService>();
  for (const s of scope.split(/\s+/)) {
    const m = /auth\/(gmail|calendar|drive)\b/.exec(s);
    if (m) out.add(SERVICE_OF[m[1]!]!);
  }
  return (["Gmail", "Calendar", "Drive"] as const).filter((s) => out.has(s));
}

export interface GoogleAuthDeps {
  store: GoogleStore;
  endpoints(): GoogleEndpoints;
  now(): number;
  fetch?: typeof fetch;
  onChange?(): void;
  /** invalid_grant (testing-mode refresh tokens expire after 7 days): the user gets a "Reconnect Google" notification. */
  onNeedsReconnect?(): void;
  /** Final secfix item 5: the redirect for the loopback port the Mac actually bound (default: the first port). */
  redirectUri?(): string;
}

/**
 * The app's own Google sign-in: authorization code + PKCE (S256), access_type=offline, prompt=consent, redirected
 * to the existing OAuth loopback. State is random, single-use and expires. Tokens are used host-side only.
 */
export class GoogleAuth {
  private pending = new Map<string, { verifier: string; createdAt: number; redirect: string }>();
  private refreshing: Promise<string> | null = null;
  private lastError: string | null = null;

  constructor(private d: GoogleAuthDeps) {}

  private get fetch(): typeof fetch { return this.d.fetch ?? fetch; }
  private redirect(): string { return this.d.redirectUri?.() ?? GOOGLE_REDIRECT_URI; }

  status(): GoogleStatusView {
    const a = this.d.store.read();
    this.prune();
    const state = !a.client ? "not-configured"
      : a.tokens && a.needsReconnect ? "needs-reconnect"
      : a.tokens ? "connected"
      : this.pending.size ? "waiting" : "disconnected";
    return {
      state, clientId: a.client?.clientId ?? null, email: a.tokens ? a.email ?? null : null,
      services: a.tokens ? servicesOf(a.tokens.scope) : [], redirectUri: this.redirect(), error: state === "connected" ? null : this.lastError,
      testing: a.tokens?.refreshExpiresAt ? true : a.publishing ? a.publishing === "testing" : null,
    };
  }

  isConnected(): boolean { return !!this.d.store.read().tokens; }
  email(): string | null { const a = this.d.store.read(); return a.tokens ? a.email ?? null : null; }

  setClient(clientId: string, clientSecret: string, o: { inProduction?: boolean } = {}): GoogleStatusView {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret || /\s/.test(id) || /\s/.test(secret) || id.length > 300 || secret.length > 300) throw new GatewayError("BAD_ARGS", "Paste both the Client ID and the Client secret from Google Cloud.");
    const cur = this.d.store.read();
    // Tokens belong to the client that issued them.
    if (cur.client?.clientId !== id) this.d.store.write({ tokens: undefined, email: undefined, needsReconnect: undefined });
    this.d.store.write({ client: { clientId: id, clientSecret: secret }, ...(typeof o.inProduction === "boolean" ? { publishing: o.inProduction ? "production" as const : "testing" as const } : {}) });
    this.pending.clear();
    this.lastError = null;
    this.d.onChange?.();
    return this.status();
  }

  start(): string {
    const client = this.d.store.read().client;
    if (!client) throw new GatewayError("BAD_ARGS", "Add your Google OAuth client (Client ID and Client secret) first.");
    this.prune();
    const verifier = b64url(randomBytes(32));
    const state = randomBytes(16).toString("hex");
    const redirect = this.redirect();
    this.pending.set(state, { verifier, createdAt: this.d.now(), redirect });
    const u = new URL(this.d.endpoints().authUrl);
    u.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirect, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state,
    }).toString();
    this.lastError = null;
    this.d.onChange?.();
    return u.toString();
  }

  /** Whether a loopback callback's state belongs to a Google sign-in (the MCP dispatcher handles the rest). */
  owns(state: string): boolean {
    this.prune();
    return this.pending.has(state);
  }

  async complete(a: { state: string; code?: string; error?: string }): Promise<{ serverId: "google"; status: "connected" | "needs-auth" }> {
    this.prune();
    const p = this.pending.get(a.state);
    if (!p) throw new GatewayError("OAUTH_EXPIRED", "This Google sign-in link expired. Start again from Connect Google.", 410);
    this.pending.delete(a.state); // single use
    const client = this.d.store.read().client;
    const fail = (msg: string) => { this.lastError = msg; this.d.onChange?.(); return { serverId: "google" as const, status: "needs-auth" as const }; };
    if (a.error || !a.code) return fail("Google sign-in was cancelled.");
    if (!client) return fail("Add your Google OAuth client first.");
    const r = await this.tokenCall({ grant_type: "authorization_code", code: a.code, code_verifier: p.verifier, redirect_uri: p.redirect, client_id: client.clientId, client_secret: client.clientSecret });
    if (!r.ok || !r.body.access_token) return fail(`Google didn't accept the sign-in (${r.body.error ?? r.status}).`);
    if (!r.body.refresh_token) return fail("Google didn't return a refresh token. Remove Bots' access in your Google account settings and connect again.");
    const tokens: GoogleTokens = { accessToken: r.body.access_token, refreshToken: r.body.refresh_token, expiresAt: this.d.now() + Number(r.body.expires_in ?? 3600) * 1000, scope: r.body.scope ?? GOOGLE_SCOPES.join(" "), ...this.refreshExpiry(r.body) };
    this.d.store.write({ tokens, needsReconnect: undefined });
    const email = await this.profileEmail(tokens.accessToken);
    this.d.store.write({ email: email ?? undefined });
    this.pending.clear();
    this.lastError = null;
    this.d.onChange?.();
    return { serverId: "google", status: "connected" };
  }

  /** A valid access token, refreshed when it is within a minute of expiring. Host-side only. */
  async accessToken(force = false): Promise<string> {
    const a = this.d.store.read();
    if (!a.tokens || !a.client) throw new GoogleAuthError("not-connected", STRG.toolNotConnected);
    if (a.needsReconnect) throw new GoogleAuthError("needs-reconnect", STRG.toolNeedsReconnect);
    if (!force && a.tokens.expiresAt - SKEW_MS > this.d.now()) return a.tokens.accessToken;
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** google-setup: the saved client secret, for the secret scanner (host-side only). */
  clientSecret(): string | null { return this.d.store.read().client?.clientSecret ?? null; }

  /** Every token value currently stored, so callers can scrub them from anything that leaves the host. */
  secrets(): string[] {
    const a = this.d.store.read();
    return [a.tokens?.accessToken, a.tokens?.refreshToken, a.client?.clientSecret].filter((s): s is string => !!s && s.length >= 8);
  }

  async disconnect(): Promise<GoogleStatusView> {
    const a = this.d.store.read();
    const token = a.tokens?.refreshToken ?? a.tokens?.accessToken;
    if (token) {
      await this.fetch(this.d.endpoints().revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    }
    this.d.store.write({ tokens: undefined, email: undefined, needsReconnect: undefined });
    this.pending.clear();
    this.lastError = null;
    this.d.onChange?.();
    return this.status();
  }

  private async refresh(): Promise<string> {
    const a = this.d.store.read();
    if (!a.tokens || !a.client) throw new GoogleAuthError("not-connected", STRG.toolNotConnected);
    const r = await this.tokenCall({ grant_type: "refresh_token", refresh_token: a.tokens.refreshToken, client_id: a.client.clientId, client_secret: a.client.clientSecret });
    if (r.body.error === "invalid_grant") {
      this.d.store.write({ needsReconnect: true });
      this.lastError = STRG.needsReconnect;
      this.d.onChange?.();
      this.d.onNeedsReconnect?.();
      throw new GoogleAuthError("needs-reconnect", STRG.toolNeedsReconnect);
    }
    if (!r.ok || !r.body.access_token) throw new GoogleAuthError("failed", `Google sign-in refresh failed (${r.body.error ?? r.status}). Try again in a minute.`);
    const tokens: GoogleTokens = { ...a.tokens, accessToken: r.body.access_token, expiresAt: this.d.now() + Number(r.body.expires_in ?? 3600) * 1000, ...(r.body.refresh_token ? { refreshToken: r.body.refresh_token } : {}), ...(r.body.scope ? { scope: r.body.scope } : {}), ...this.refreshExpiry(r.body) };
    this.d.store.write({ tokens });
    return tokens.accessToken;
  }

  /** google-setup: a Testing app's refresh token comes with refresh_token_expires_in (Google ends it after 7 days). */
  private refreshExpiry(b: { refresh_token_expires_in?: number }): { refreshExpiresAt?: number } {
    const n = Number(b.refresh_token_expires_in);
    return Number.isFinite(n) && n > 0 ? { refreshExpiresAt: this.d.now() + n * 1000 } : {};
  }

  private async tokenCall(form: Record<string, string>): Promise<{ ok: boolean; status: number; body: { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string } }> {
    try {
      const r = await this.fetch(this.d.endpoints().tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000) });
      const body = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string; error?: string };
      return { ok: r.ok, status: r.status, body: { ...body, error: typeof body.error === "string" ? body.error.slice(0, 60) : undefined } };
    } catch {
      return { ok: false, status: 0, body: { error: "network error" } };
    }
  }

  private async profileEmail(accessToken: string): Promise<string | null> {
    try {
      const r = await this.fetch(`${this.d.endpoints().gmail}/users/me/profile`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { emailAddress?: unknown };
      return typeof j.emailAddress === "string" ? j.emailAddress.slice(0, 320) : null;
    } catch {
      return null;
    }
  }

  private prune(): void {
    for (const [k, v] of this.pending) if (this.d.now() - v.createdAt > LIMITS5.mcpOAuthPendingTtlMs) this.pending.delete(k);
  }
}
