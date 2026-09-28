import { execFileSync } from "node:child_process";
import { scrubClaudeLogin } from "@synapse/shared";
import type { HostConfig } from "../config";
import { log } from "../util/log";

/** Root-owned helper installed by box/provision.sh; see box/files/bot-user. */
export const BOT_USER_HELPER = "/usr/local/libexec/bot-user";

/**
 * Bug #66: the host's side of per-Bot OS accounts. `ensure` runs when a Bot is created (before anything is staged for
 * it) and for every Bot on host start (idempotent: it re-checks the account and re-applies its layout); `remove` runs
 * when a Bot is deleted. Synchronous on purpose: Bot creation and deletion are synchronous, and one call is ~10 ms.
 * Only on a migrated box (cfg.perBotUid) and with the real brain; a failure is logged, never thrown, and the next
 * host start retries (until then that Bot's CLI refuses to start, which is the safe side).
 */
export interface BotAccounts { ensure(botId: string): void; remove(botId: string): void }

type Run = (file: string, args: string[]) => void;
const sudo: Run = (file, args) => { execFileSync(file, args, { env: scrubClaudeLogin(process.env), stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 }); };

export function sudoBotAccounts(cfg: Pick<HostConfig, "perBotUid" | "brain">, run: Run = sudo): BotAccounts | undefined {
  if (!cfg.perBotUid || cfg.brain !== "claude") return undefined;
  const call = (verb: "ensure" | "remove", botId: string) => {
    try {
      run("sudo", ["-n", BOT_USER_HELPER, verb, botId]);
    } catch (err) {
      log.error(`bot-user ${verb} failed`, { botId, error: String((err as { stderr?: Buffer }).stderr ?? err).trim().slice(0, 300) });
    }
  };
  return { ensure: (id) => call("ensure", id), remove: (id) => call("remove", id) };
}
