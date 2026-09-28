/**
 * Bug 284: the app was called Bots and its env settings were BOTS_*. They are SYNAPSE_* now. A box's
 * /etc/bothost.env, a systemd drop-in an older build wrote, or an owner's hand edit may still say BOTS_*, so for one
 * release the old name is still read. The new name wins when both are set.
 */
export const ENV_PREFIX = "SYNAPSE_";
export const LEGACY_ENV_PREFIX = "BOTS_";

export function envSetting(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[`${ENV_PREFIX}${name}`] ?? env[`${LEGACY_ENV_PREFIX}${name}`];
}
