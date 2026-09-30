import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES, LIMITS5, STRG, type GoogleAccountView, type GoogleService, type GoogleStatusView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { GoogleEndpoints } from "./endpoints";
import type { GoogleAccount, GoogleAccountRecord, GoogleStore, GoogleTokens } from "./store";

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
  /** 4.3b: a sign-in added a NEW account (not a reconnect of one already here), before onChange. */
  onAccountAdded?(accountId: string): void;
}

/** 4.3b: what one account looks like to the rest of the host (never its tokens). */
export interface GoogleAccountInfo { id: string; email: string | null; needsReconnect: boolean; services: GoogleService[]; refreshExpiresAt: number | null }

/**
 * The app's own Google sign-in: authorization code + PKCE (S256), access_type=offline, prompt=consent, redirected
 * to the existing OAuth loopback. State is random, single-use and expires. Tokens are used host-side only.
 */
export class GoogleAuth {
  private pending = new Map<string, { verifier: string; createdAt: number; redirect: string }>();
  private refreshing = new Map<string, Promise<string>>();
  private lastError: string | null = null;

  constructor(private d: GoogleAuthDeps) {}

  private get fetch(): typeof fetch { return this.d.fetch ?? fetch; }
  private redirect(): string { return this.d.redirectUri?.() ?? GOOGLE_REDIRECT_URI; }

  /** 4.3b: the top-level state is "needs-reconnect" while ANY account needs it (its own row says which). */
  status(): GoogleStatusView {
    const a = this.d.store.read();
    this.prune();
    const list = a.accounts ?? [];
    const first = list[0];
    const state = !a.client ? "not-configured"
      : list.some((x) => x.needsReconnect) ? "needs-reconnect"
      : list.length ? "connected"
      : this.pending.size ? "waiting" : "disconnected";
    const accounts: GoogleAccountView[] = list.map((x) => ({
      id: x.id, email: x.email ?? null, state: x.needsReconnect ? "needs-reconnect" : "connected", services: servicesOf(x.tokens.scope), bots: [...(a.grants?.[x.id] ?? [])],
    }));
    return {
      state, clientId: a.client?.clientId ?? null, email: first?.email ?? null,
      services: first ? servicesOf(first.tokens.scope) : [], redirectUri: this.redirect(), error: state === "connected" ? null : this.lastError,
      testing: list.some((x) => x.tokens.refreshExpiresAt) ? true : a.publishing ? a.publishing === "testing" : null,
      accounts,
    };
  }

  /** Any account (or, with an id, that one) is connected. */
  isConnected(accountId?: string): boolean { return !!this.record(accountId); }
  /** 4.4: when a Testing app's refresh token ends (Google ends it after 7 days); null when it doesn't. */
  refreshExpiresAt(accountId?: string): number | null { return this.record(accountId)?.tokens.refreshExpiresAt ?? null; }
  /** The first account's address (mail triggers and older callers). */
  email(): string | null { return this.record()?.email ?? null; }
  /** 4.3b: every connected account, oldest first. */
  accounts(): GoogleAccountInfo[] {
    return (this.d.store.read().accounts ?? []).map((x) => ({ id: x.id, email: x.email ?? null, needsReconnect: !!x.needsReconnect, services: servicesOf(x.tokens.scope), refreshExpiresAt: x.tokens.refreshExpiresAt ?? null }));
  }
  /** 4.3b: every connected address (the owner's own "yourself"). */
  emails(): string[] { return (this.d.store.read().accounts ?? []).map((x) => x.email).filter((e): e is string => !!e); }
  /** 4.3b: account id → Bot ids. */
  grants(): Record<string, string[]> { return { ...(this.d.store.read().grants ?? {}) }; }
  setGrants(grants: Record<string, string[]>): void { this.d.store.write({ grants }); }

  /** The account with this id, or the first one. */
  private record(accountId?: string, a: GoogleAccount = this.d.store.read()): GoogleAccountRecord | undefined {
    const list = a.accounts ?? [];
    return accountId === undefined ? list[0] : list.find((x) => x.id === accountId);
  }
  private patchAccount(id: string, patch: Partial<GoogleAccountRecord>): void {
    const a = this.d.store.read();
    const accounts = (a.accounts ?? []).map((x) => {
      if (x.id !== id) return x;
      const next = { ...x, ...patch };
      for (const k of Object.keys(next) as (keyof GoogleAccountRecord)[]) if (next[k] === undefined) delete next[k];
      return next;
    });
    this.d.store.write({ accounts });
  }

  setClient(clientId: string, clientSecret: string, o: { inProduction?: boolean } = {}): GoogleStatusView {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret || /\s/.test(id) || /\s/.test(secret) || id.length > 300 || secret.length > 300) throw new GatewayError("BAD_ARGS", "Paste both the Client ID and the Client secret from Google Cloud.");
    const cur = this.d.store.read();
    // Tokens belong to the client that issued them.
    if (cur.client?.clientId !== id) this.d.store.write({ accounts: undefined, grants: undefined });
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
    const email = await this.profileEmail(tokens.accessToken);
    // 4.3b: the same address signing in again is a reconnect of that account; any other address is a new account.
    // An address Google wouldn't tell us replaces the only account there is (the old single-account behaviour).
    const cur = this.d.store.read().accounts ?? [];
    const same = email ? cur.find((x) => x.email?.toLowerCase() === email.toLowerCase()) : cur.length === 1 && !cur[0]!.email ? cur[0] : undefined;
    let added: string | null = null;
    if (same) this.d.store.write({ accounts: cur.map((x) => (x.id === same.id ? { id: x.id, tokens, ...(email ? { email } : {}) } : x)) });
    else {
      added = `g-${randomBytes(5).toString("hex")}`;
      this.d.store.write({ accounts: [...cur, { id: added, tokens, ...(email ? { email } : {}) }] });
    }
    this.pending.clear();
    this.lastError = null;
    if (added) this.d.onAccountAdded?.(added);
    this.d.onChange?.();
    return { serverId: "google", status: "connected" };
  }

  /** A valid access token, refreshed when it is within a minute of expiring. Host-side only. */
  /** 4.3b: `accountId` picks the account (default: the first). */
  async accessToken(force = false, accountId?: string): Promise<string> {
    const a = this.d.store.read();
    const rec = this.record(accountId, a);
    if (!rec || !a.client) throw new GoogleAuthError("not-connected", STRG.toolNotConnected);
    if (rec.needsReconnect) throw new GoogleAuthError("needs-reconnect", STRG.toolNeedsReconnect);
    if (!force && rec.tokens.expiresAt - SKEW_MS > this.d.now()) return rec.tokens.accessToken;
    let p = this.refreshing.get(rec.id);
    if (!p) {
      p = this.refresh(rec.id).finally(() => { this.refreshing.delete(rec.id); });
      this.refreshing.set(rec.id, p);
    }
    return p;
  }

  /** google-setup: the saved client secret, for the secret scanner (host-side only). */
  clientSecret(): string | null { return this.d.store.read().client?.clientSecret ?? null; }

  /** Every token value currently stored, so callers can scrub them from anything that leaves the host. */
  secrets(): string[] {
    const a = this.d.store.read();
    return [...(a.accounts ?? []).flatMap((x) => [x.tokens.accessToken, x.tokens.refreshToken]), a.client?.clientSecret].filter((s): s is string => !!s && s.length >= 8);
  }

  /** 4.3b: with an id, only that account (its tokens revoked, its grants gone); without, every account. */
  async disconnect(accountId?: string): Promise<GoogleStatusView> {
    const a = this.d.store.read();
    const gone = (a.accounts ?? []).filter((x) => accountId === undefined || x.id === accountId);
    for (const x of gone) {
      const token = x.tokens.refreshToken || x.tokens.accessToken;
      if (token) await this.fetch(this.d.endpoints().revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    }
    const ids = new Set(gone.map((x) => x.id));
    const grants = { ...(a.grants ?? {}) };
    for (const id of ids) delete grants[id];
    const accounts = (a.accounts ?? []).filter((x) => !ids.has(x.id));
    this.d.store.write({ accounts: accounts.length ? accounts : undefined, grants: Object.keys(grants).length ? grants : undefined });
    if (accountId === undefined) this.pending.clear();
    this.lastError = null;
    this.d.onChange?.();
    return this.status();
  }

  private async refresh(accountId: string): Promise<string> {
    const a = this.d.store.read();
    const rec = this.record(accountId, a);
    if (!rec || !a.client) throw new GoogleAuthError("not-connected", STRG.toolNotConnected);
    const r = await this.tokenCall({ grant_type: "refresh_token", refresh_token: rec.tokens.refreshToken, client_id: a.client.clientId, client_secret: a.client.clientSecret });
    if (r.body.error === "invalid_grant") {
      this.patchAccount(rec.id, { needsReconnect: true });
      this.lastError = STRG.needsReconnect;
      this.d.onChange?.();
      this.d.onNeedsReconnect?.();
      throw new GoogleAuthError("needs-reconnect", STRG.toolNeedsReconnect);
    }
    if (!r.ok || !r.body.access_token) throw new GoogleAuthError("failed", `Google sign-in refresh failed (${r.body.error ?? r.status}). Try again in a minute.`);
    const tokens: GoogleTokens = { ...rec.tokens, accessToken: r.body.access_token, expiresAt: this.d.now() + Number(r.body.expires_in ?? 3600) * 1000, ...(r.body.refresh_token ? { refreshToken: r.body.refresh_token } : {}), ...(r.body.scope ? { scope: r.body.scope } : {}), ...this.refreshExpiry(r.body) };
    this.patchAccount(rec.id, { tokens });
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
