import path from "node:path";
import type { HostConfig } from "../config";
import { botUserName } from "./bot-uid";

/**
 * Bug #61 (Bot walls): every per-Bot data path on the box, declared once.
 *
 * Every Bot's CLI runs as the one OS uid `box`, so "private" comes in two strengths:
 *  - host-private: an OS wall. bothost-only DAC (0700 dirs), so uid box (and boxmcp, and Chrome running as box) can't
 *    read it by any means. The owning Bot reaches it only through host tools that scope by the host-resolved Bot id
 *    (SearchHistory, update_state memory, the memory screen, the chat store).
 *  - box-private: readable by uid box because the Bot genuinely needs file access to its own copy (a staged upload, a
 *    screenshot) or because the CLI itself writes it (session JSONLs). Walled ONLY by the Read/Glob/Grep/Edit/Write/
 *    Bash/Shell path guard in review/classify.ts, which is weaker than an OS wall: a Bash command can reach a path
 *    without naming it (globs, variables, cd, a script file, the browser's file:// URLs). `stronger` names the fix.
 *  - bot-private (bug #66): an OS wall by uid. The Bot's own OS account owns it (0700), so no other Bot's processes
 *    (CLI, shells, Chrome) can read it by any means; the host reaches it only through root helpers that act AS that
 *    account. Exists once the box is migrated to per-Bot accounts (cfg.perBotUid, walls/bot-uid.ts).
 *  - shared: every Bot may read it by design; `reason` says why.
 *
 * Bug #66: every box-private entry also says, in `perBotUid`, what the per-Bot accounts do to it: after the
 * migration each one is an OS wall too (or holds only the service uid box's own data, which no Bot uid can read),
 * and the tool guard stays as a second layer.
 *
 * The one sanctioned way across the wall is asking the teammate (SendToAgent kind "question"): the teammate answers
 * from its own history and memory, and the exchange shows in both transcripts.
 */
export type WallClass =
  | { kind: "host-private"; how: string }
  | { kind: "box-private"; stronger: string; perBotUid: string }
  | { kind: "bot-private"; how: string }
  | { kind: "shared"; reason: string };

export type WallRoot = "dataRoot" | "workspace" | "claudeConfigDir" | "boxHome" | "hostPrivate" | "proc" | "botHomes";

export interface BotDataPath {
  key: string;
  what: string;
  root: WallRoot;
  /** Segments below the root. "{bot}" is the owning Bot's id, "{account}" its OS account (walls/bot-uid.ts), "*" any one
   *  segment. Everything below belongs to the entry. */
  pattern: string[];
  cls: WallClass;
}

const PER_BOT_UID = "per-Bot OS uids (or a per-Bot mount+pid namespace AND a per-Bot Chrome) so the kernel, not a tool guard, keeps it out of other Bots' reach";

export const BOT_DATA_PATHS: readonly BotDataPath[] = [
  { key: "bot-folder", root: "dataRoot", pattern: ["agents", "{bot}"],
    what: "the Bot's folder: chat store (store.db), profile, settings, its own memory, attachment originals, routines, follow-ups, joined-projects list, avatar",
    cls: { kind: "host-private", how: "agents/ is bothost 0700; served through the host (chat, memory screen, update_state memory, attachments)" } },
  { key: "agents-root", root: "dataRoot", pattern: ["agents"], what: "the folder of every Bot folder, and active-agent.json",
    cls: { kind: "host-private", how: "bothost 0700" } },
  { key: "transcript-mirror", root: "dataRoot", pattern: ["agent-transcripts", "{bot}"], what: "the Bot's CTX-04 transcript mirror",
    cls: { kind: "host-private", how: "agent-transcripts/ is bothost 0700; the Bot searches its history with SearchHistory" } },
  { key: "transcripts-root", root: "dataRoot", pattern: ["agent-transcripts"], what: "the folder of every transcript mirror",
    cls: { kind: "host-private", how: "bothost 0700" } },
  { key: "user-memory", root: "dataRoot", pattern: ["user-memory", "agents", "{bot}"], what: "the facts about the user this Bot learned (its user-memory shard)",
    cls: { kind: "shared", reason: "MEM-*: user memory is one store about the user, written in per-Bot shards; every Bot reads every shard by design" } },
  { key: "user-memory-root", root: "dataRoot", pattern: ["user-memory"], what: "the user-memory shards",
    cls: { kind: "shared", reason: "MEM-*: facts about the user, read by every Bot" } },
  { key: "project-memory", root: "dataRoot", pattern: ["projects", "*", "memory", "agents", "{bot}"], what: "facts this Bot saved to a project it joined",
    cls: { kind: "shared", reason: "MEM-*: project memory is the shared notebook of a project's members" } },
  { key: "projects-root", root: "dataRoot", pattern: ["projects"], what: "project folders (project.md and project memory)",
    cls: { kind: "shared", reason: "MEM-*: projects are team spaces Bots join" } },
  { key: "host-private", root: "hostPrivate", pattern: [], what: "the host's own data: history archive, memory index, secrets vault, upload parts, B2B threads, scheduler",
    cls: { kind: "host-private", how: "bothost 0700 since Phase 1; every query is scoped by the host-resolved Bot id" } },
  { key: "uploads", root: "workspace", pattern: [".host-out", "uploads", "{bot}"], what: "the Bot's staged copies of files the user attached (CHAT-09)",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "staged under uploads/<bot>/, bothost:<the Bot's own group> 2750 (bot-user ensure): only the Bot's uid can enter" } },
  { key: "screens", root: "workspace", pattern: [".host-out", "screens", "{bot}"], what: "the Bot's screenshots of its display",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "screens/<bot>/ is bothost:<the Bot's own group> 2750: only the Bot's uid can enter" } },
  { key: "events", root: "workspace", pattern: [".host-out", "events", "{bot}"], what: "oversized webhook bodies for the Bot's triggers",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "events/<bot>/ is bothost:<the Bot's own group> 2750: only the Bot's uid can enter" } },
  { key: "mcp-output", root: "workspace", pattern: [".host-out", "mcp-output", "{bot}"], what: "large MCP tool results spilled for the Bot",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "mcp-output/<bot>/ is bothost:<the Bot's own group> 2750: only the Bot's uid can enter" } },
  { key: "terminals", root: "workspace", pattern: [".host-out", "terminals", "{bot}"], what: "the Bot's Shell transcripts (command output), once the box runs per-Bot accounts",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "terminals/<bot>/ is bothost:<the Bot's own group> 2750, files 0640, appended by systemd: only the Bot's uid can read them, none can write" } },
  { key: "uploads-legacy", root: "workspace", pattern: [".host-out", "uploads"], what: "pre-wall flat upload staging (migrated into uploads/<bot>/ on host start)",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "emptied on host start (walls/migrate.ts); its per-Bot subfolders are OS-walled as above" } },
  { key: "mcp-output-legacy", root: "workspace", pattern: [".host-out", "mcp-output"], what: "pre-wall flat MCP spills (moved host-private on host start)",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "emptied on host start (walls/migrate.ts); its per-Bot subfolders are OS-walled as above" } },
  { key: "teach-recordings", root: "workspace", pattern: [".host-out", "teach"], what: "published Teach recordings",
    cls: { kind: "shared", reason: "the user records a demonstration to make a skill, and skills are one shared library (SKL-*); follow-up: per-Bot recordings" } },
  { key: "workspace", root: "workspace", pattern: [], what: "the one /workspace: files, repos, teach-sessions, coding-agent transcripts, and (before the per-Bot accounts) .bot/terminals",
    cls: { kind: "shared", reason: "one shared workspace all Bots work in by design (spec: Workspace); share files by path" } },
  { key: "skills", root: "claudeConfigDir", pattern: ["skills"], what: "user-authored skills", cls: { kind: "shared", reason: "SKL-*: one skills library, enabled per Bot" } },
  { key: "bot-home", root: "botHomes", pattern: ["{account}"],
    what: "the Bot's own OS home (bug #66): its CLI config and sessions, its Chrome profile, its private work files",
    cls: { kind: "bot-private", how: "/home/bots/<account> is the Bot's own uid, 0700; the host reads its sessions only through the root helpers, as that uid" } },
  { key: "cli-sessions", root: "claudeConfigDir", pattern: ["projects"], what: "every Bot's Claude Code session JSONLs (all Bots share cwd /workspace, so one folder holds them all)",
    cls: { kind: "box-private", stronger: `${PER_BOT_UID}; with them each Bot gets its own CLAUDE_CONFIG_DIR`, perBotUid: "each Bot's sessions move to its own 0700 home (/home/bots/<account>/.claude, migrate-per-bot-uid.sh); what stays here is uid box's own (host-internal calls) at 0600" } },
  { key: "cli-state", root: "claudeConfigDir", pattern: [], what: "the CLI's own state: .claude.json, sessions/, session-env/, shell-snapshots/, backups/",
    cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "each Bot has its own CLAUDE_CONFIG_DIR in its 0700 home; this one is left to uid box (host-internal calls)" } },
  { key: "chrome-profile", root: "boxHome", pattern: ["chrome-profile"], what: "display 1's Chrome profile (cookies and logins)", cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "a Bot's screen runs as its account with its profile in its 0700 home; this one is display 1's (box), not a Bot's" } },
  { key: "chrome-screens", root: "boxHome", pattern: [".chrome-screens"], what: "every other display's Chrome profile (cookies and logins)", cls: { kind: "box-private", stronger: PER_BOT_UID, perBotUid: "moved into each owning Bot's 0700 home (chrome-profile) by migrate-per-bot-uid.sh; left only for pre-migration screens" } },
  { key: "process-env", root: "proc", pattern: ["*"], what: "another Bot's live process: /proc/<pid>/environ holds its secrets and token, /proc/<pid>/root and cwd its view",
    cls: { kind: "box-private", stronger: `${PER_BOT_UID}; a pid namespace hides other Bots' processes`, perBotUid: "another Bot's processes run as another uid: /proc/<pid>/environ, root, cwd, fd, mem are owner-only (ptrace denied)" } },
];

/** ownerId: the owning Bot's id, or (for a "{account}" entry) its OS account name; null when the path has none. */
export interface WallHit { entry: BotDataPath; ownerId: string | null }

function rootOf(cfg: HostConfig, r: WallRoot): string {
  switch (r) {
    case "dataRoot": return cfg.dataRoot;
    case "workspace": return cfg.workspace;
    case "claudeConfigDir": return cfg.claudeConfigDir;
    case "boxHome": return cfg.boxHome;
    case "hostPrivate": return cfg.hostPrivate;
    case "proc": return "/proc";
    case "botHomes": return cfg.botHomes;
  }
}

/** A Bot id segment (a UUID in production); a file name such as a flat legacy "notes.md" is not one. */
const BOT_ID_SEG = /^[A-Za-z0-9_-]{1,64}$/;
const PROC_PRIVATE = /^(environ|root|cwd|fd|fdinfo|mem|map_files)$/;

/** The most specific declared entry an absolute path falls under, and its owner Bot id (null when the path has none). */
export function wallHit(cfg: HostConfig, abs: string): WallHit | null {
  const p = path.resolve(abs);
  let best: { hit: WallHit; score: number } | null = null;
  for (const entry of BOT_DATA_PATHS) {
    const base = path.resolve(rootOf(cfg, entry.root));
    if (p !== base && !p.startsWith(`${base}/`)) continue;
    const segs = p === base ? [] : p.slice(base.length + 1).split("/");
    if (entry.root === "proc") {
      // Only another process's private views; /proc/self and plain status files stay readable.
      if (segs.length < 2 || segs[0] === "self" || segs[0] === "thread-self" || !PROC_PRIVATE.test(segs[1]!)) continue;
    }
    if (segs.length < entry.pattern.length) continue;
    let owner: string | null = null;
    let ok = true;
    entry.pattern.forEach((pat, i) => {
      if (pat === "{bot}") { owner = segs[i]!; if (!BOT_ID_SEG.test(owner)) ok = false; }
      else if (pat === "{account}") owner = segs[i]!; // any name: one that isn't a Bot's account is nobody's own
      else if (pat !== "*" && pat !== segs[i]) ok = false;
    });
    if (!ok) continue;
    const score = base.length * 100 + entry.pattern.length;
    if (!best || score > best.score) best = { hit: { entry, ownerId: owner }, score };
  }
  return best?.hit ?? null;
}

/** True when `botId` must not read `abs`: it is private (either strength) and not the Bot's own. */
export function privateToAnother(cfg: HostConfig, botId: string | undefined, abs: string): boolean {
  const h = wallHit(cfg, abs);
  if (!h || h.entry.cls.kind === "shared") return false;
  if (h.ownerId === null || !botId) return true;
  if (h.entry.pattern.includes("{account}")) return !BOT_ID_SEG.test(botId) || h.ownerId !== botUserName(botId);
  return h.ownerId !== botId;
}

/** Roots whose private entries a recursive Glob/Grep from an ancestor would walk into (the workspace itself excepted). */
export function privateRoots(cfg: HostConfig): string[] {
  return BOT_DATA_PATHS.filter((e) => e.cls.kind !== "shared" && e.root !== "proc")
    .map((e) => path.join(rootOf(cfg, e.root), ...e.pattern.filter((s) => s !== "{bot}" && s !== "{account}" && s !== "*")));
}
