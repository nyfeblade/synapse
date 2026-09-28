import { createHash } from "node:crypto";
import path from "node:path";
import type { HostConfig } from "../config";

/**
 * Bug #66: one OS account per Bot, so the kernel (not only the tool guard) keeps one Bot out of another's home, CLI
 * sessions, Chrome profile, staged files and live process. The root helper box/files/bot-user creates and removes the
 * accounts and must follow the same rules as this file (host/test/box/bot-user-helper.test.ts runs both).
 *
 * Off until the box is migrated (box/migrate-per-bot-uid.sh sets SYNAPSE_PER_BOT_UID=1 in /etc/bothost.env): then every
 * Bot runs as its own uid and uid `box` is left to host-internal model calls (reviewer, memory, helper, compiler)
 * and coding-agent git in the shared /workspace.
 */

/** Reserved: above useradd's UID_MAX (60000) and below systemd's dynamic users (61184). */
export const BOT_UID_MIN = 60200;
export const BOT_UID_MAX = 61099;
/** The box's path (box/files/bot-user); cfg.botHomes overrides it for tests only. */
export const BOT_HOMES = "/home/bots";
export const BOT_USER_RE = /^bot-[0-9a-f]{12}$/;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The GECOS field ties an account to exactly one Bot id; the helpers refuse an account whose GECOS doesn't match. */
export const gecosFor = (botId: string) => `synapse-bot ${botId}`;
/** Where the staged host output lives, per Bot (walls/registry.ts); "terminals" holds its Shell transcripts. */
export const STAGING_KINDS = ["uploads", "screens", "events", "mcp-output", "terminals"] as const;

export function botUserName(botId: string): string {
  if (!BOT_ID_RE.test(botId)) throw new Error(`not a Bot id: ${JSON.stringify(botId)}`);
  return `bot-${createHash("sha256").update(botId).digest("hex").slice(0, 12)}`;
}

/**
 * The next uid for a new Bot account: the high-water mark `next` while it is still in range (a removed Bot's uid is
 * not handed to the next Bot while there is room above), otherwise the lowest free uid. `taken` is every uid AND gid
 * in use (each account's private group has the same number).
 */
export function allocateUid(o: { taken: Iterable<number>; next: number | null; min?: number; max?: number }): number {
  const min = o.min ?? BOT_UID_MIN, max = o.max ?? BOT_UID_MAX;
  const taken = new Set(o.taken);
  const start = o.next !== null && o.next >= min && o.next <= max ? o.next : null;
  if (start !== null) for (let u = start; u <= max; u++) if (!taken.has(u)) return u;
  for (let u = min; u <= max; u++) if (!taken.has(u)) return u;
  throw new Error(`the Bot uid range ${min}-${max} is full`);
}

export interface BotOsUser { name: string; home: string; claudeConfigDir: string }

function userOf(cfg: Partial<Pick<HostConfig, "botHomes">>, botId: string): BotOsUser {
  const name = botUserName(botId);
  const home = path.posix.join(cfg.botHomes ?? BOT_HOMES, name);
  return { name, home, claudeConfigDir: path.posix.join(home, ".claude") };
}

/** The Bot's own OS account, or null while the box still runs every Bot as `box`. */
export function botOsUser(cfg: Pick<HostConfig, "perBotUid"> & Partial<Pick<HostConfig, "botHomes">>, botId: string): BotOsUser | null {
  return cfg.perBotUid ? userOf(cfg, botId) : null;
}

/**
 * Bug 231: where a Bot keeps its code (~/code). Under per-Bot accounts it is inside the Bot's own 0700 home, so no
 * other Bot can plant hooks or npm scripts in it (the shared /workspace is box:bots 2775 with umask 002) and the
 * review fast path can trust it (review/static.ts closedAncestor). Before the migration every Bot is uid box: /home/box/code.
 */
export function botCodeDir(cfg: Pick<HostConfig, "perBotUid" | "boxHome"> & Partial<Pick<HostConfig, "botHomes">>, botId: string): string {
  return path.posix.join(botOsUser(cfg, botId)?.home ?? cfg.boxHome, "code");
}

/** CLAUDE_CONFIG_DIR of the process that runs this Bot (its own, or the shared legacy one). */
export function cliConfigDirFor(cfg: Pick<HostConfig, "perBotUid" | "claudeConfigDir">, botId: string): string {
  return botOsUser(cfg, botId)?.claudeConfigDir ?? cfg.claudeConfigDir;
}

/** The CLI writes a session to <config>/projects/<cwd with every non-alphanumeric as "-">/<sid>.jsonl. */
export function cliSessionFile(cfg: Pick<HostConfig, "perBotUid" | "claudeConfigDir" | "workspace">, botId: string, sid: string): string {
  return path.join(cliConfigDirFor(cfg, botId), "projects", cfg.workspace.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
}

export interface LayoutEntry { path: string; type: "dir" | "link"; owner: string; group: string; mode: number; target?: string }

/**
 * What `bot-user ensure <botId>` leaves on disk. The home is created by root under root-owned /home/bots; everything
 * inside it is created AS the Bot (so a link the Bot planted can only redirect its own rights). The staging dirs stay
 * bothost's (the host writes them) with the Bot's private group and setgid, so only that Bot can read what is staged.
 */
export function botLayoutPlan(cfg: Pick<HostConfig, "workspace" | "claudeConfigDir"> & Partial<Pick<HostConfig, "botHomes">>, botId: string): LayoutEntry[] {
  const u = userOf(cfg, botId);
  const own = (p: string): LayoutEntry => ({ path: p, type: "dir", owner: u.name, group: u.name, mode: 0o700 });
  return [
    own(u.home),
    own(u.claudeConfigDir),
    own(path.posix.join(u.claudeConfigDir, "projects")),
    { path: path.posix.join(u.claudeConfigDir, "skills"), type: "link", owner: u.name, group: u.name, mode: 0o777, target: path.posix.join(cfg.claudeConfigDir, "skills") },
    own(path.posix.join(u.home, "chrome-profile")),
    own(path.posix.join(u.home, "code")), // bug 231: projects and clones live here, not in the shared /workspace
    ...STAGING_KINDS.map((k): LayoutEntry => ({ path: path.posix.join(cfg.workspace, ".host-out", k, botId), type: "dir", owner: "bothost", group: u.name, mode: 0o2750 })),
  ];
}
