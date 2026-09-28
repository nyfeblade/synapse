/**
 * Review round 3 (S6): THE env for every claude process Synapse starts, on the box, on the Mac and in the dev tools.
 * One list of every way the CLI could sign in other than our API key, one builder that deletes them all and sets the
 * key (a proxy token, the dead sentinel, or an explicit dev key), and one runtime check that none survived. The host
 * (auth/auth-env.ts, claude/spawn.ts), the Mac (coordinator/local-exec/login-scrub.ts) and the dev tools
 * (auth/dev-auth.ts) all build their claude env here; a guard test proves no other file starts claude.
 */
export const CLAUDE_LOGIN_VARS = [
  // A Claude login in any form, and the claude.ai plan hints that go with it.
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE", "CLAUDE_CODE_RATE_LIMIT_TIER",
  // A bearer token, an API key other than ours (by value or by file descriptor), the remote / socket modes that turn
  // claude.ai OAuth back on, and a profile.
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_REMOTE", "ANTHROPIC_UNIX_SOCKET", "ANTHROPIC_PROFILE",
  // Round 2 (S4): a host/provider-managed login, a host credentials file, a custom OAuth endpoint, and the entrypoint
  // hint that can switch the CLI onto one of them.
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_CODE_CUSTOM_OAUTH_URL",
  // Round 3 (S6): a cloud provider's login instead of Anthropic's, and extra headers that could carry a credential.
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_CUSTOM_HEADERS",
] as const;
export type ClaudeLoginVar = (typeof CLAUDE_LOGIN_VARS)[number];

/** The dead pair for a claude with no real key: the CLI sees an API key (so OAuth stays off) and every call fails at once. */
export const SENTINEL_API_KEY = "sk-ant-api03-synproxy-none";
export const SENTINEL_BASE_URL = "http://127.0.0.1:9";

/** A copy of `env` with every login var removed (ANTHROPIC_API_KEY included). */
export function scrubClaudeLogin<E extends Record<string, string | undefined>>(env: E): E {
  const out: Record<string, string | undefined> = { ...env };
  for (const k of CLAUDE_LOGIN_VARS) delete out[k];
  return out as E;
}

export class ClaudeLoginEnvError extends Error {
  constructor(readonly variable: string) {
    super(`A Claude login variable reached a claude process env: ${variable}`);
    this.name = "ClaudeLoginEnvError";
  }
}

/**
 * Throws if `env` holds any login var, except ANTHROPIC_API_KEY equal to `apiKey` (the one this spawn was given). The
 * error names the variable, never its value. `sdkEntrypoint`: the Agent SDK sets CLAUDE_CODE_ENTRYPOINT=sdk-… itself
 * in the child env it hands a spawn hook; that value alone is allowed there.
 */
export function assertNoClaudeLogin(env: Record<string, string | undefined>, o: { apiKey?: string | null; sdkEntrypoint?: boolean } = {}): void {
  for (const k of CLAUDE_LOGIN_VARS) {
    const v = env[k];
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" && o.apiKey !== undefined && v === o.apiKey) continue;
    if (k === "CLAUDE_CODE_ENTRYPOINT" && o.sdkEntrypoint && /^sdk-[a-z]+$/.test(v)) continue;
    throw new ClaudeLoginEnvError(k);
  }
}

/**
 * The env for one claude process: `base` with every login var deleted, then the one key it may use (`apiKey`: a proxy
 * token, an explicit dev key, or null for the dead sentinel pair) and its base URL. Checked before it is returned.
 */
export function claudeEnv(base: Record<string, string | undefined>, cred: { apiKey: string | null; baseUrl?: string | null }): Record<string, string> {
  const out = scrubClaudeLogin(base);
  if (out.ANTHROPIC_BASE_URL === SENTINEL_BASE_URL) delete out.ANTHROPIC_BASE_URL;
  if (cred.apiKey === null) {
    out.ANTHROPIC_API_KEY = SENTINEL_API_KEY;
    out.ANTHROPIC_BASE_URL = SENTINEL_BASE_URL;
  } else {
    out.ANTHROPIC_API_KEY = cred.apiKey;
    if (cred.baseUrl) out.ANTHROPIC_BASE_URL = cred.baseUrl;
  }
  const clean = Object.fromEntries(Object.entries(out).filter((e): e is [string, string] => typeof e[1] === "string"));
  assertNoClaudeLogin(clean, { apiKey: clean.ANTHROPIC_API_KEY });
  return clean;
}
