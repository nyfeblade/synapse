import { CLAUDE_LOGIN_VARS, SENTINEL_API_KEY, SENTINEL_BASE_URL, STR_AUTH, claudeEnv, scrubClaudeLogin } from "@synapse/shared";

/**
 * How the Anthropic API key reaches every Claude process the host starts. All of them (Bot turns, children, coding
 * agents, compaction, the reviewer, memory extraction, dreaming, helpers, avatar, template drafts, conformance) go
 * through usage/metered-query.ts, which calls prepareAuthEnv on each call's env just before the CLI spawns. The key
 * is read per call: a new key applies to every call that starts after it, and a running turn keeps the process it
 * started with.
 *
 * API key only (api-key-only): there is no Claude-login path. Every Claude login the CLI could otherwise pick up is
 * scrubbed from the env (CLAUDE_AUTH_SCRUB), and ANTHROPIC_API_KEY is always set: with an API key in its env and no
 * CLAUDE_CODE_REMOTE, Claude Code 2.1.277 turns claude.ai OAuth off (its isAnthropicAuthEnabled() returns false when
 * the API-key source is ANTHROPIC_API_KEY), so a stored login in the config dir or the keychain is never read.
 * With no key saved a call fails (AuthMissingError); it never falls back to anything.
 */
export interface AuthSource { apiKey(): string | null; generation?(): number }

let source: AuthSource | null = null;
/** app.ts sets this at boot. Unset (unit tests), envs lose every Claude login but keep an API key the caller gave. */
export function setAuthSource(s: AuthSource | null): void { source = s; }
/** A closing host app lets go of its own source only. */
export function releaseAuthSource(s: AuthSource): void { if (source === s) source = null; }
/** An API key is saved. */
export function credentialsReady(): boolean { return !!source?.apiKey(); }
/** Bumps on every key change: a process started before it (a prewarmed reviewer) is stale. */
export function authGeneration(): number { return source?.generation?.() ?? 0; }

export class AuthMissingError extends Error {
  constructor() {
    super(STR_AUTH.noKeyDetail);
    this.name = "AuthMissingError";
  }
}

/**
 * Every env key that could sign the CLI in some other way than our API key (review round 3, S6: one shared list,
 * shared/src/claude-env.ts, the same on the box, the Mac and the dev tools). Removed from every Claude process's env
 * (buildBotEnv, applyAuthEnv); ANTHROPIC_API_KEY too, so only the one applyAuthEnv / prepareAuthEnv sets is ever there.
 */
export const CLAUDE_AUTH_SCRUB = CLAUDE_LOGIN_VARS;
export { SENTINEL_API_KEY, SENTINEL_BASE_URL };

/**
 * Review round 2 (S1): an env built for a process that gets no key (a background Shell, an MCP server, a claude a Bot
 * starts by hand) carries the dead pair (shared SENTINEL_*), so the CLI sees an API key and never turns claude.ai OAuth
 * on or reads a stored login. A real spawn replaces both (applyAuthEnv / prepareAuthEnv).
 */
export function applySentinel<E extends Record<string, string | undefined>>(env: E): E {
  (env as Record<string, string | undefined>).ANTHROPIC_API_KEY = SENTINEL_API_KEY;
  (env as Record<string, string | undefined>).ANTHROPIC_BASE_URL = SENTINEL_BASE_URL;
  return env;
}

/** Deletes every login var from `env` in place (buildBotEnv builds its env in place). */
export function scrubClaudeAuth<E extends Record<string, string | undefined>>(env: E): E {
  const clean = scrubClaudeLogin(env);
  for (const k of Object.keys(env)) if (!(k in clean)) delete env[k];
  return env;
}

/** Security review (minor 2): the box's key proxy is required and isn't running, so no Claude process may start. */
export class AuthProxyDownError extends Error {
  constructor() {
    super(STR_AUTH.proxyDownDetail);
    this.name = "AuthProxyDownError";
  }
}

/** What a spawn needs from the auth proxy (proxy.ts): a per-spawn token, the URL, and revocation. */
/** Tokens a CLI reported for its own runs (meteredQuery), so the proxy can tell what went through unreported. */
/** What a CLI reported for its runs (tokens and web searches, both inside its total_cost_usd), for the proxy to reconcile. */
export interface ReportedUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearchRequests: number }
export interface ProxyLike { readonly url: string; issue(g: { botId: string | null }): string; revoke(token: string, reported?: ReportedUsage): void }
let proxy: ProxyLike | null = null;
let proxyRequired = false;
/** app.ts: from here on a Claude process gets ANTHROPIC_BASE_URL = the proxy and a proxy token, never the real key. */
export function setAuthProxy(p: ProxyLike | null): void { proxy = p; }
/**
 * app.ts, real brain: the proxy is required. While it isn't set (it couldn't start), every spawn is refused
 * (AuthProxyDownError) instead of getting the key in its env: fail closed. Only a test build may run without it.
 */
export function requireAuthProxy(on: boolean): void { proxyRequired = on; }

/**
 * The env for one Claude process, and `release` to call when that process is done (its proxy token is revoked).
 * Through the proxy: ANTHROPIC_API_KEY = a proxy token and ANTHROPIC_BASE_URL = the proxy; no real credential.
 */
export function prepareAuthEnv<E extends Record<string, string | undefined>>(env: E | undefined, o: { botId: string | null }): { env: E | undefined; release(reported?: ReportedUsage): void } {
  if (proxyRequired && !proxy && source) throw new AuthProxyDownError();
  const direct = applyAuthEnv(env);
  if (!proxy || !direct || !source) return { env: direct, release: () => {} };
  const p = proxy;
  const token = p.issue({ botId: o.botId });
  const out: Record<string, string | undefined> = { ...direct, ANTHROPIC_BASE_URL: p.url, ANTHROPIC_API_KEY: token };
  let done = false;
  return { env: out as E, release: (reported?: ReportedUsage) => { if (!done) { done = true; p.revoke(token, reported); } } };
}

/** The env with every other sign-in scrubbed and ANTHROPIC_API_KEY set to the saved key. No key: AuthMissingError. */
export function applyAuthEnv<E extends Record<string, string | undefined>>(env: E | undefined): E | undefined {
  if (!source) {
    if (!env) return env;
    const out: Record<string, string | undefined> = { ...env };
    for (const k of CLAUDE_AUTH_SCRUB) if (k !== "ANTHROPIC_API_KEY") delete out[k];
    return out as E;
  }
  const key = source.apiKey();
  if (!key) throw new AuthMissingError();
  // claudeEnv (shared): every login var deleted, the key set, and checked before it is returned.
  return claudeEnv(env ?? (process.env as Record<string, string | undefined>), { apiKey: key }) as unknown as E;
}
