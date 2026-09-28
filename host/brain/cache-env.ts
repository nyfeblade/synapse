import type { PromptCacheTtl } from "@synapse/shared";

/**
 * Token diet (3): the prompt-cache env every Bot CLI runs with. Kept out of spawn-options.ts so that
 * file's own edits and this one never collide; buildBotEnv calls it after the Bot's secrets are in.
 *
 * Claude Code 2.1.277 (docs: env-vars, prompt-caching "Which TTL each request gets"): the main
 * conversation gets a 5-minute cache TTL by default on an API key (the only sign-in).
 * CLAUDE_CODE_PROMPT_CACHE_TTL=1h pins 1 hour for the Bot's own turns. FORCE_PROMPT_CACHING_5M overrides it and DISABLE_PROMPT_CACHING* turn caching
 * off, so none of those can come in from a Bot's stored secrets.
 */
export const PROMPT_CACHE_TTL: PromptCacheTtl = "1h";
const CACHE_OVERRIDES = /^(FORCE_PROMPT_CACHING_5M|DISABLE_PROMPT_CACHING(_[A-Z]+)?|ENABLE_PROMPT_CACHING_1H(_BEDROCK)?)$/;

/**
 * saving-settings, "Keep conversations ready": the user may pick 5 minutes (writes billed 1.25x input instead of 2x on an
 * API key; a reply 5-60 minutes after the last one re-writes the cache). The value is in the env, so it is in the spawn
 * key's env hash: a warm process picks a change up by respawning on its next turn (never mid-turn).
 */
export function applyCacheEnv(env: Record<string, string>, ttl: PromptCacheTtl = PROMPT_CACHE_TTL): void {
  for (const k of Object.keys(env)) if (CACHE_OVERRIDES.test(k)) delete env[k];
  env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl;
}
