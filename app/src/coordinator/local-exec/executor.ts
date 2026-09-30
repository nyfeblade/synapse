import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readScriptCapped } from "./script-read";
import { LIMITS5, appDataRoots, appDataWalls, MAC_CLAUDE_CONFIG_DIR, MAC_STARTUP_DIRS, MAC_STARTUP_FILES, MAC_TOOL_CONFIG_DIRS, MAC_TOOL_CONFIG_FILES, STR5, evaluateFixedRules, MAC_CLAUDE_API_KEY_MSG, MAC_CLAUDE_AUTH_UNKNOWN_MSG, MAC_CLAUDE_PROXY_DOWN_MSG, macUsesGitNetworkOrGh, macWrappedClaudeNeedsAuth, macExemptTool, macCredentialStore, macWrappedToolPrelude, macWrappedUsesClaude, macSafeGitConfigSet, macSandboxExemptSimple, macPlainUrlOpenArgs, macSandboxInteractive, macUnsandboxedHandoff, macPrivateStoreRules, macStandInStoreRules, macCaseFoldRe, macPrivateStorePath, macPrivateStoreRead, macQuietHandoff, type MacPrivateStoreRules, type LocalExecRequest, type MacClaudeAuth } from "@synapse/shared";
import { macAllowedApp } from "./app-trust";
import type { MacKeyGrantResult, MacKeyGrantor } from "./mac-key-proxy";
import { MAC_CLAUDE_LOGIN_REFUSED_MSG, emptyClaudeConfigDir, isClaudeLoginCommand, macRunEnv } from "./login-scrub";
import { FIXED_PATH, exemptInstallTrees, pinTool, pinnedPath, samePin, type ToolPin } from "./tool-path";

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

type IO = {
  output(stream: "stdout" | "stderr", chunk: string): void; /** bug 235: the exempt tool as pinned when its card was approved. */ pin?: ToolPin | null; readBox?(boxPath: string): AsyncIterable<Buffer>; uploadBox?(chunk: Buffer, offset: number, final: boolean): Promise<void>;
  /** Bug 258: the policy passed an everyday hand-off with no card (Full auto): it runs in the light sandbox. */
  quiet?: boolean;
  /** Bug 258: Full auto: a dev tool's web page (http/https only) opens through the executor's bridge. */
  openBridge?: boolean;
  /** Bug 258: the Bot is in No limits: the sandbox drops the private-store rules; the app's data and keychain stay. */
  noLimits?: boolean;
  /** Bug 441: the real path the policy judged for a file write; the write goes there or nowhere. */
  target?: string;
};

/** Bug 441: the refusal when a file's real location moved between the check and the write. */
export const WRITE_MOVED = "The file's location changed between the check and the write, so nothing was written. Try again.";

/** P5 review I4: the Mac exec env is a minimal allowlist — never the app's own env (tokens, Electron vars). */
export const MAC_EXEC_ENV_KEYS = ["HOME", "USER", "PATH", "LANG", "TERM", "SHELL", "TMPDIR"] as const;
export function macExecEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of MAC_EXEC_ENV_KEYS) if (typeof src[k] === "string") env[k] = src[k]!;
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  env.HOME ??= os.homedir();
  env.USER ??= os.userInfo().username;
  env.LANG ??= "en_US.UTF-8";
  env.TERM ??= "xterm-256color";
  env.SHELL ??= "/bin/zsh";
  env.BOT_AGENT = "1";
  return env;
}

/**
 * Bug 237: added DELIBERATELY to every unwrapped run's env (on top of the MAC_EXEC_ENV_KEYS allowlist, never taken
 * from the app's own env): git ignores the system config, never runs an fsmonitor or hooks, and uses plain ssh — so
 * a pinned tool that calls git can't be steered by a config a Bot managed to plant.
 */
export const UNWRAPPED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
  GIT_CONFIG_KEY_2: "core.sshCommand", GIT_CONFIG_VALUE_2: "",
};

/** Bug 240: the wrapped claude's own config dir (~/.synapse/claude-mac), created 0700 (its parent too) on first use. */
export function synapseClaudeDir(home: string): string {
  const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
  for (const d of [path.dirname(dir), dir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(d, 0o700); } catch { /* not ours to change */ }
  }
  return dir;
}

/** mac-keychain-guard: a Mac-side git/gh that wanted the user's credentials (never given to Bots). */
const GITHUB_CREDENTIALS_NEEDED = /could not read (?:Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey|gh auth login|not logged in|HTTP 401|HTTP 403|errSec[A-Za-z]+|osxkeychain|SecKeychain/i;
/** mac-keychain-guard: output that means a wrapped command needed the keychain (the sandbox denies the Security server). */
const KEYCHAIN_NEEDED = /errSec[A-Za-z]+|SecKeychain|osxkeychain|keychain (?:could not|cannot|is not)|User interaction is not allowed|Security(?:Server| framework)|com\.apple\.SecurityServer/i;

/** Final secfix item 2: the on-disk spelling of a path (realpathSync.native resolves case on APFS, the JS one doesn't). */
const realNative = (p: string): string => fs.realpathSync.native(p);
const fold = (p: string): string => p.normalize("NFC").toLowerCase();

/**
 * Bug 225: every Mac command runs in a macOS sandbox that denies reading or writing the app's own data folder (the
 * permission key and the signed permission files live there, with no keychain around them). The static NEVER wall
 * catches a command that names the folder; this catches the ones that don't (globs, computed paths, a script file).
 * The sandbox is probed once per folder; where it can't be applied (not macOS, sandbox-exec refused) commands run
 * as before, behind the static wall.
 */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const NESTED_SANDBOX = /sandbox_apply: Operation not permitted/;
const sbString = (p: string): string => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/**
 * Bug 233: a kernel-level backstop under the static hand-off rules. Inside the sandbox the programs that hand code to
 * something outside it can't be exec'd at all, and the launch-item places can't be written — so a hand-off spelled
 * where the static rules can't see it (a string a python/node program builds at runtime) fails at exec. A hand-off
 * the user approved on its card runs unwrapped for that one call (LocalExecutor.shell).
 */
export const HANDOFF_BINARIES = ["/bin/launchctl", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/batch", "/usr/bin/open", "/usr/bin/osascript", "/usr/bin/sfltool", "/usr/bin/shortcuts", "/usr/bin/automator"] as const;
/** Bug 234: the one `open` a plain URL open runs, spawned directly with the URLs (no shell, no PATH). */
export const SYSTEM_OPEN = "/usr/bin/open";
/** mac-keychain-guard: the keychain reader whose exec (and the Security server it talks to) the sandbox denies. */
export const KEYCHAIN_BINARIES = ["/usr/bin/security"] as const;
const LAUNCH_PLACES = ["Library/LaunchAgents", "Library/LaunchDaemons", "Library/Application Support/com.apple.backgroundtaskmanagementagent"];
const HANDOFF_BLOCKED = /operation not permitted/i;
const HANDOFF_NAMES = /\b(launchctl|crontab|at|batch|open|osascript|sfltool|shortcuts|automator)\b/;

const bothForms = (p: string): string[] => {
  const forms = new Set([path.resolve(p)]);
  try { forms.add(realNative(p)); } catch { /* not created yet */ }
  return [...forms];
};
/** Private-store hardening: the store rules for this home (or, in tests only, neutral stand-in folders). */
function storeRulesFor(home: string, testStores?: readonly string[]): MacPrivateStoreRules {
  return testStores ? macStandInStoreRules(testStores.flatMap(bothForms)) : macPrivateStoreRules(bothForms(home));
}
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Review round 3, finding 1: the dirs a Claude login lives in (relative to home), rename-locked in every mode. */
const LOGIN_DIRS = [".claude", ".synapse", MAC_CLAUDE_CONFIG_DIR] as const;
const regexes = (rs: readonly string[]): string => rs.map((r) => `(regex ${sbString(r)})`).join(" ");
/** Tests only: `testPrivateStores` replaces the real private-store list with neutral stand-in folders; `testProfileExtra`
 *  is appended to the profile as is (a malformed one proves the fail-closed path).
 *  Bug 258: `handoffLite` (an everyday hand-off in Full auto) lets osascript and open themselves run and keeps every
 *  other deny; `noLimits` drops the private-store rules and keeps the app's data, the keychain and the rest. */
export interface SandboxOpts { testPrivateStores?: readonly string[]; testProfileExtra?: string; handoffLite?: boolean; noLimits?: boolean }
/** Bug 258: the two hand-off programs an everyday hand-off runs in the light sandbox. */
const LITE_ALLOWED = new Set<string>(["/usr/bin/osascript", "/usr/bin/open"]);
export function ownDataSandboxProfile(userData: string, home: string = os.homedir(), opts: SandboxOpts = {}): string {
  const homes = bothForms(home);
  const deny = dataRootRules(userData, homes);
  const launch = homes.flatMap((h) => LAUNCH_PLACES.map((d) => `(subpath ${sbString(`${h.replace(/\/+$/, "")}/${d}`)})`)).join(" ");
  // mac-keychain-guard: the keychain item for the user's Claude OAuth token (and others) trusts /usr/bin/security, so
  // any sandboxed command could read it with `security find-generic-password …` and no prompt. Deny exec of it, and
  // deny mach-lookup of the Security server too, so a copied `security` binary or an interpreter (python keyring /
  // ctypes calling the Security framework) can't reach securityd either. git/node/python don't use it.
  const exec = [...HANDOFF_BINARIES.filter((b) => !(opts.handoffLite && LITE_ALLOWED.has(b))), ...KEYCHAIN_BINARIES].map((b) => `(literal ${sbString(b)})`).join(" ");
  // Bug 234: shell startup files are code the user's own Terminal runs later; the sandbox never writes them (a
  // symlinked dotfile is denied at its real place too).
  const startup = homes.flatMap((h) => [
    ...MAC_STARTUP_FILES.flatMap((f) => bothForms(`${h.replace(/\/+$/, "")}/${f}`).map((p) => `(literal ${sbString(p)})`)),
    ...MAC_STARTUP_DIRS.flatMap((d) => bothForms(`${h.replace(/\/+$/, "")}/${d}`).map((p) => `(subpath ${sbString(p)})`)),
  ]);
  // Bug 235/236: the exempt tools' install trees (recomputed for every profile), so a Bot can't swap the binary
  // an approved one-shot will run outside the sandbox.
  // Bug 237: the settings those tools read (Claude's settings and hooks, Codex's config, git's global config).
  const config = homes.flatMap((h) => [
    ...MAC_TOOL_CONFIG_FILES.flatMap((f) => bothForms(`${h.replace(/\/+$/, "")}/${f}`).map((p) => `(literal ${sbString(p)})`)),
    ...MAC_TOOL_CONFIG_DIRS.flatMap((d) => bothForms(`${h.replace(/\/+$/, "")}/${d}`).map((p) => `(subpath ${sbString(p)})`)),
  ]);
  startup.push(...config);
  const trees = installTreesFor(home);
  const tools = [...trees.subpaths.map((p) => `(subpath ${sbString(p)})`), ...trees.literals.map((p) => `(literal ${sbString(p)})`)];
  // Private-store hardening: a browser's saved logins and cookies, Mail, Messages, Safari and SSH private keys can't
  // be read (or written) from inside the sandbox, however the command spells the path; the folders above them can't
  // be renamed, so a store can't be moved out from under these rules. The public files in ~/.ssh stay readable
  // (later SBPL rules win, so that allow comes after the deny and touches nothing else).
  const stores = storeRulesFor(home, opts.testPrivateStores);
  // Bug 258 + fix round: No limits lifts the READ deny only. Every store path — ~/.ssh, saved logins, cookies, mail,
  // messages — stays WRITE-denied in every mode, so ssh config / authorized_keys and a browser's stores can never be
  // planted. The browser-root and parent write-locks also stay in every mode.
  const storeRules = [
    ...(opts.noLimits ? [] : [`(deny file-read* ${regexes(stores.deny)})`]),
    `(deny file-write* ${regexes(stores.deny)})`,
    ...(!opts.noLimits && stores.allowRead.length ? [`(allow file-read* ${regexes(stores.allowRead)})`] : []),
    `(deny file-write* ${regexes(stores.writeLock)})`,
  ].join("\n");
  // Fix round: the LaunchServices preferences (default-app / URL-scheme handlers) are code the sandbox never writes:
  // a Bot must not make itself the handler for a scheme so its own `open` reaches an app it planted. Both profiles.
  const launchServices = homes.flatMap((h) => bothForms(`${h.replace(/\/+$/, "")}/Library/Preferences`).map((p) => `(regex ${sbString(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/com\\.apple\\.LaunchServices`)})`)).join(" ");
  // Review round 3 (S2a): where a Claude login lives on disk is unreadable (and unwritable) from inside the sandbox in
  // every mode, No limits included: the user's ~/.claude/.credentials.json, the app-owned config dir's, and
  // ~/.claude.json (account fields; a wrapped claude uses its own CLAUDE_CONFIG_DIR, so it never needs the user's).
  // The keychain (where claude keeps its login on macOS) is denied below: exec of `security` and the Security server.
  const logins = homes.flatMap((h) => [".claude/.credentials.json", `${MAC_CLAUDE_CONFIG_DIR}/.credentials.json`, ".claude.json"]
    .flatMap((f) => bothForms(`${h.replace(/\/+$/, "")}/${f}`))).map((p) => `(literal ${sbString(p)})`);
  // Review round 3, finding 1: a literal deny matches the path at access time, so `mv ~/.claude ~/.cx` carried the
  // login out from under it (then `CLAUDE_CONFIG_DIR=~/.cx claude`). The dirs a login lives in can't be renamed or
  // removed from inside the sandbox (each spelling of home, and in either case below it, like the private-store parent
  // locks); what's inside them is untouched. A `.credentials.json` anywhere under home, in any case, can't be read or
  // written, so a copy or a moved file stays unreadable wherever it ends up.
  const homeRes = [...new Set(homes.map((h) => h.replace(/\/+$/, "")))].map(escRe);
  const loginDirs = homes.flatMap((h) => LOGIN_DIRS.flatMap((d) => bothForms(`${h.replace(/\/+$/, "")}/${d}`)))
    .map((p) => `(literal ${sbString(p)})`)
    .concat(homeRes.flatMap((h) => LOGIN_DIRS.map((d) => `(regex ${sbString(`^${h}/${macCaseFoldRe(d)}/?$`)})`)))
    // D3: nothing directly in ~/.synapse is made, moved or removed from inside either, so the migration's trash name
    // (the config dir it moved aside) can't be swapped for a link while it looks inside it.
    .concat(homeRes.map((h) => `(regex ${sbString(`^${h}/${macCaseFoldRe(".synapse")}/[^/]+/?$`)})`));
  const anyLogin = homeRes.map((h) => `(regex ${sbString(`^${h}/(.*/)?${macCaseFoldRe(".credentials.json")}$`)})`);
  return `(version 1)\n(allow default)\n(deny file-read* file-write* ${deny.denied})\n(deny file-write-unlink ${deny.locked})\n(deny file-read* file-write* ${[...new Set(logins)].join(" ")} ${anyLogin.join(" ")})\n(deny file-write* ${[...new Set(loginDirs)].join(" ")})\n(deny file-write* ${launch} ${launchServices} ${[...new Set([...startup, ...tools])].join(" ")})\n(deny process-exec ${exec})\n(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.security.agent") (global-name "com.apple.securityd"))\n${storeRules}\n${opts.testProfileExtra ?? ""}`;
}
/**
 * Bug 285 + 288: the app's data under both names (…/Synapse, and …/Bots). Not only the profile: the whole data root
 * (every profile, the shared voice engines the main process runs outside the sandbox, backups, releases) is read- and
 * write-denied, in any case below home. A literal deny matches the path at access time, so the folders above the root
 * (~/Library, ~/Library/Application Support) can't be unlinked (which is what a rename or rmdir of them is): none can
 * be moved to carry the data out from under the deny. Making files and folders inside them (`mkdir -p`) still works.
 */
function dataRootRules(userData: string, homes: string[]): { denied: string; locked: string } {
  const roots = [...new Set(appDataRoots(userData).flatMap(bothForms))];
  const homeDirs = [...new Set(homes.map((h) => h.replace(/\/+$/, "")))];
  const denied = roots.map((p) => `(subpath ${sbString(p)})`);
  const locked: string[] = [];
  for (const r of roots) {
    const h = homeDirs.find((d) => r.startsWith(`${d}/`));
    if (!h) { locked.push(`(literal ${sbString(path.dirname(r))})`); continue; }
    const rel = r.slice(h.length + 1);
    denied.push(`(regex ${sbString(`^${escRe(h)}/${macCaseFoldRe(rel)}(/.*)?$`)})`);
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i++) {
      const up = segs.slice(0, i).join("/");
      locked.push(`(literal ${sbString(`${h}/${up}`)})`, `(regex ${sbString(`^${escRe(h)}/${macCaseFoldRe(up)}/?$`)})`);
    }
  }
  return { denied: [...new Set(denied)].join(" "), locked: [...new Set(locked)].join(" ") };
}
/** Bug 236: recomputed for every profile (cheap), so a tool installed after start-up is covered at once. */
function installTreesFor(home: string): { subpaths: string[]; literals: string[] } {
  return exemptInstallTrees(home);
}
const sandboxOk = new Set<string>();
/**
 * Private-store hardening (fail closed): null when the sandbox can't be applied (no data folder, not macOS, the
 * profile didn't load), and then the caller REFUSES the command — it never runs it unwrapped. Only a load that worked
 * is remembered, so a one-off failure (a probe that timed out under load) is tried again on the next command.
 */
function sandboxFor(userData: string | null | undefined, home: string, opts: SandboxOpts = {}): string[] | null {
  if (!userData || process.platform !== "darwin") return null;
  let profile: string;
  try { profile = ownDataSandboxProfile(userData, home, opts); } catch { return null; }
  if (!sandboxOk.has(profile)) {
    let ok = false;
    try { ok = spawnSync(SANDBOX_EXEC, ["-p", profile, "/usr/bin/true"], { env: macExecEnv(), timeout: 5_000, stdio: "ignore" }).status === 0; } catch { ok = false; }
    if (!ok) { console.error("local-exec: the command sandbox profile didn't load; Mac commands are refused until it does"); return null; }
    sandboxOk.add(profile);
  }
  return [SANDBOX_EXEC, "-p", profile];
}

/** A shell-style glob (`**`, `*`, `?`, `{a,b}`) to a RegExp matched against a forward-slash relative path. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") { if (glob[i + 1] === "*") { re += "(?:.*)"; i++; if (glob[i + 1] === "/") i++; } else re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const e = glob.indexOf("}", i); if (e < 0) { re += "\\{"; } else { re += `(?:${glob.slice(i + 1, e).split(",").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`; i = e; } }
    else if (".+^$()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Bug 258: the web-page bridge for Full auto. `open` is exec-denied inside the command sandbox (a hand-off), so a dev
 * tool that opens its page in the browser failed there. For a wrapped run the executor puts a tiny `open` first on
 * PATH (and sets $BROWSER to it): it passes only http/https URLs, one per line, into a file in a fresh temp folder,
 * and refuses anything else. The executor, outside the sandbox, reads that file (never following a link) and opens
 * each valid URL with the system `open` directly — no shell, a capped number per run. Nothing but a web address
 * crosses, so no file, app or script can be opened this way. The folder is removed when the run ends.
 */
// Fix round (review of bug 258): the bridge auto-opens PLAIN web URLs only. A query string (or fragment) can carry
// data outward, so a dev tool's URL with one is not opened here — it would need the user's own card.
const BRIDGE_URL = /^https?:\/\/[^\s\x00-\x1f\x7f?#]{1,2048}$/i;
const BRIDGE_MAX_OPENS = 10;
const BRIDGE_REFUSED = "open: only web pages (http/https) can be opened from here";
class OpenBridge {
  readonly dir: string;
  private readonly file: string;
  private offset = 0;
  private opened = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private openBinary: string) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-open-"));
    this.file = path.join(this.dir, "requests");
    fs.writeFileSync(this.file, "", { mode: 0o600 });
    const shim = [
      "#!/bin/sh",
      "# Synapse: from a Bot's command only web pages (http/https) open in the browser.",
      `[ $# -gt 0 ] || { echo ${shQuote(BRIDGE_REFUSED)} >&2; exit 1; }`,
      `for a in "$@"; do case "$a" in http://*|https://*) ;; *) echo ${shQuote(BRIDGE_REFUSED)} >&2; exit 1;; esac; done`,
      `for a in "$@"; do printf '%s\\n' "$a" >> ${shQuote(this.file)}; done`,
      "exit 0",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(this.dir, "open"), shim, { mode: 0o755 });
  }
  /** Exported after the login shell's startup files (path_helper would put /usr/bin first again). */
  prelude(): string {
    return `export PATH=${shQuote(this.dir)}:"$PATH"; export BROWSER=${shQuote(path.join(this.dir, "open"))}; `;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), 250);
    this.timer.unref?.();
  }
  private poll(): void {
    if (this.opened >= BRIDGE_MAX_OPENS) return;
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size <= this.offset) return;
      const len = Math.min(st.size - this.offset, 64 * 1024);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, this.offset);
      const text = buf.subarray(0, n).toString("utf8");
      const end = text.lastIndexOf("\n");
      if (end < 0) return;
      this.offset += Buffer.byteLength(text.slice(0, end + 1));
      for (const line of text.slice(0, end).split("\n")) {
        if (this.opened >= BRIDGE_MAX_OPENS || !BRIDGE_URL.test(line)) continue;
        this.opened++;
        try { spawn(this.openBinary, [line], { env: macExecEnv(), detached: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch { /* the browser didn't open */ }
      }
    } catch { /* a bad read opens nothing */ } finally { fs.closeSync(fd); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.poll();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

/** Bug 258: a file operation's options. `noLimitsRead`: a No limits read, which may open ~/.ssh and the stores. */
interface FileOpts { noLimitsRead?: boolean }

export class LocalExecutor {
  private procs = new Map<string, ChildProcess>();
  /** Bug 232: runs started without the sandbox wrapper (one-shot only: no stdin, no send-input). */
  private unsandboxed = new Set<string>();
  /** feat-mac-access-parity: fullAccess() true = commands and file ops may run anywhere the user can (CLI parity),
   *  bounded only by the protected-path NEVER guard. false = the old behaviour (bounded to the local root). */
  constructor(private o: {
    root: () => string; maxBytes?: number; home?: () => string; userData?: () => string | null; fullAccess?: () => boolean;
    /** tests only: the plain-URL open binary (default SYSTEM_OPEN). */ openBinary?: string;
    /** Asked before every claude run (wiring.ts hostClaudeAuth): whether the host has a key, and the budget's answer.
     *  null or absent = the host couldn't be asked (a claude run that needs to sign in is refused). */ claudeAuth?: (botId: string) => Promise<MacClaudeAuth | null>;
    /** A per-run proxy token for a wrapped claude (mac-key-proxy.ts), never the key. */ keyProxy?: MacKeyGrantor;
    /** Parity #6: the prompt-cache TTL a granted claude run is pinned to (the Savings setting). Default "1h". */ promptCacheTtl?: () => "1h" | "5m";
    /** tests only: neutral stand-in folders that replace the real private-store list (sandbox rules and the approved-read check). */ testPrivateStores?: readonly string[];
    /** tests only: appended to the sandbox profile as is. */ testProfileExtra?: string;
  }) {}

  /** 5.6: the home `~` expands to (the action log proves a command's file effects against it). */
  homeDir(): string { return this.o.home?.() ?? os.homedir(); }

  /** P5 review I3: places no Bot file operation may touch — keys, the keychain, startup items, shell rc files, the app's own data.
   *  Bug 258: a No limits READ may open ~/.ssh (the keychain and the app's data stay closed). */
  private protectedPaths(o: FileOpts = {}): string[] {
    const home = this.o.home?.() ?? os.homedir();
    const rc = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".inputrc"];
    const list = [
      ...(o.noLimitsRead ? [] : [path.join(home, ".ssh")]), path.join(home, "Library", "Keychains"), path.join(home, "Library", "LaunchAgents"),
      "/Library/LaunchAgents", "/Library/LaunchDaemons", "/Library/Keychains", ...rc.map((f) => path.join(home, f)),
      ...appDataWalls(this.o.userData?.()),
    ];
    return list.flatMap((p) => { try { return [p, realNative(p)]; } catch { return [p]; } });
  }

  /** Final secfix item 2: APFS is case-insensitive, so every comparison is case-folded (~/.SSH is ~/.ssh). */
  private guard(real: string, o: FileOpts = {}): string {
    const r = fold(real);
    const hit = this.protectedPaths(o).some((p0) => { const p = fold(p0); return r === p || r.startsWith(p + path.sep); });
    if (hit) throw new Error("That path is protected on this computer (keys, keychain, startup items, shell settings or the app's own data).");
    return real;
  }

  /** LOC-01: the working directory is bounded to the local root (default: home). Walks up to the
   * nearest existing ancestor (the target itself may not exist yet, e.g. a write-file destination
   * whose parent directories haven't been created) so symlinks in an existing prefix still resolve. */
  within(p: string, o: FileOpts = {}): string {
    const home = this.o.home?.() ?? os.homedir();
    // Full access (CLI parity): ~ expands to home, and there is no root boundary — only the protected NEVER guard.
    // Bounded mode keeps the old local-root wall. Relative paths resolve against the local root when it exists (the
    // "project dir"), else home; in full access an unresolvable root is not fatal.
    const full = this.o.fullAccess?.() ?? false;
    let root: string | null = null;
    try { root = realNative(this.o.root()); } catch { if (!full) throw new Error(`That path is outside the local root (${this.o.root()}).`); }
    const base = root ?? realNative(home);
    const abs = path.resolve(base, p.replace(/^~(?=$|\/)/, realNative(home)));
    const missing: string[] = [];
    let cur = abs;
    while (!fs.existsSync(cur)) {
      missing.unshift(path.basename(cur));
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    const real = realNative(cur);
    const parent = missing.length ? path.join(real, ...missing) : real;
    if (!full && fold(parent) !== fold(root!) && !fold(parent).startsWith(fold(root!) + path.sep)) throw new Error(`That path is outside the local root (${root}).`);
    return this.guard(parent, o);
  }

  /** Bug 256 (review): a walk from a base that is not itself a credential store (the card for that one was answered
   *  by the user) skips every store below it: saved logins, cookies, Mail, Messages, .env. */
  private credentialSkip(baseDir: string, full: string, o: FileOpts = {}): boolean {
    if (o.noLimitsRead) return false; // bug 258: No limits searches the stores too
    const home = this.o.home?.() ?? os.homedir();
    return !macCredentialStore(baseDir, home) && macCredentialStore(full, home);
  }

  /** A glob like `**​/*.ts` under a base dir, protected paths skipped, capped. Returns newest-first paths.
   *  0.1.4 first-run (code audit 3.4): async, so a search of a big folder never stops the coordinator's thread (every
   *  chat stream goes through it). */
  private async glob(req: LocalExecRequest, _max: number, o: FileOpts = {}): Promise<{ exitCode: number; result: string }> {
    const baseDir = this.within(req.path ?? ".", o);
    const re = globToRegExp(req.pattern ?? "**/*");
    const hits: { p: string; m: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 30 || hits.length >= LIMITS5.localGlobMax) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= LIMITS5.localGlobMax) return;
        const full = path.join(dir, e.name);
        try { this.guard(realNative(full), o); } catch { continue; } // never descend into a protected place
        if (this.credentialSkip(baseDir, full, o)) continue; // bug 256: nor list a credential store's contents unasked
        if (e.name === "node_modules" || e.name === ".git") continue;
        const rel = path.relative(baseDir, full);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (re.test(rel)) { try { hits.push({ p: full, m: (await fs.promises.stat(full)).mtimeMs }); } catch { /* gone */ } }
      }
    };
    await walk(baseDir, 0);
    hits.sort((a, b) => b.m - a.m);
    return { exitCode: 0, result: hits.map((h) => h.p).join("\n") };
  }

  /** A ripgrep-lite content search: a regex over files under a base dir, protected paths skipped, capped. Async, like glob. */
  private async grep(req: LocalExecRequest, o: FileOpts = {}): Promise<{ exitCode: number; result: string }> {
    const baseDir = this.within(req.path ?? ".", o);
    let re: RegExp;
    try { re = new RegExp(req.pattern ?? "", "m"); } catch { throw new Error("That search pattern is not a valid regular expression."); }
    const fileRe = req.command ? globToRegExp(req.command) : null; // command carries an optional --glob filter
    const out: string[] = [];
    const scan = (file: string, text: string) => {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && out.length < LIMITS5.localGrepMax; i++) if (re.test(lines[i]!)) out.push(`${file}:${i + 1}:${lines[i]!.slice(0, 400)}`);
    };
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 30 || out.length >= LIMITS5.localGrepMax) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= LIMITS5.localGrepMax) return;
        const full = path.join(dir, e.name);
        try { this.guard(realNative(full), o); } catch { continue; }
        if (this.credentialSkip(baseDir, full, o)) continue; // bug 256: a search never reads a credential store it wasn't pointed at
        if (e.name === "node_modules" || e.name === ".git") continue;
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        if (fileRe && !fileRe.test(path.relative(baseDir, full))) continue;
        let text: string;
        try { if ((await fs.promises.stat(full)).size > 4 * 1024 * 1024) continue; text = await fs.promises.readFile(full, "utf8"); } catch { continue; }
        if (text.includes("\u0000")) continue; // binary
        scan(full, text);
      }
    };
    const single = (await fs.promises.stat(baseDir)).isFile();
    if (single) scan(baseDir, await fs.promises.readFile(baseDir, "utf8"));
    else await walk(baseDir, 0);
    return { exitCode: out.length ? 0 : 1, result: out.join("\n") };
  }

  /**
   * Bug 441: open a file for writing only where it was judged. The path must still be the real path the policy
   * judged; the last part is never followed if it became a link (O_NOFOLLOW); the parent folders are re-resolved right
   * before and after the open, and the file opened must be the one now at that path. Anything else refuses the write
   * before a byte is written or the file is emptied.
   */
  private openChecked(p: string, target: string | undefined, o: { create: boolean; read?: boolean }): number {
    const moved = () => new Error(WRITE_MOVED);
    if (target !== undefined && fold(target) !== fold(p)) throw moved();
    const dir = path.dirname(p);
    const dirOk = () => { try { return fold(realNative(dir)) === fold(dir); } catch { return false; } };
    if (!dirOk()) throw moved();
    const C = fs.constants;
    let fd: number;
    try {
      fd = fs.openSync(p, (o.read ? C.O_RDWR : C.O_WRONLY) | C.O_NOFOLLOW | (o.create ? C.O_CREAT : 0), 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ELOOP") throw moved();
      throw e;
    }
    try {
      const st = fs.fstatSync(fd);
      const now = fs.lstatSync(p);
      if (!st.isFile() || !dirOk() || now.isSymbolicLink() || now.ino !== st.ino || now.dev !== st.dev) throw moved();
      return fd;
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  }

  /** Bug 441: replace a file's contents through a checked descriptor. */
  private writeChecked(p: string, target: string | undefined, data: string | Buffer, create: boolean): void {
    const fd = this.openChecked(p, target, { create });
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data, 0, undefined, 0);
    } finally { fs.closeSync(fd); }
  }

  kill(execId: string): void {
    const p = this.procs.get(execId);
    if (p?.pid) try { process.kill(-p.pid, "SIGTERM"); } catch { p.kill("SIGTERM"); }
  }

  async run(req: LocalExecRequest, io: IO): Promise<{ exitCode: number | null; result?: string }> {
    const max = this.o.maxBytes ?? LIMITS5.localFileMaxBytes;
    const readOpts: FileOpts = { noLimitsRead: io.noLimits === true };
    switch (req.op) {
      case "run-command": return this.shell(req, io);
      case "send-input": {
        if (this.unsandboxed.has(req.command ?? "")) throw new Error(STR5.macExemptNoInput);
        const target = this.procs.get(req.command ?? "");
        if (!target?.stdin) throw new Error("That shell is no longer running.");
        target.stdin.write(req.input ?? "");
        return { exitCode: 0 };
      }
      case "kill": this.kill(req.command ?? ""); return { exitCode: 0 };
      case "revoke-grants": throw new Error("revoke-grants is handled by the daemon, not run."); // ruling (b)
      case "browser": throw new Error("browser requests are handled by the daemon (the app's browser controller), not run."); // mac-browser
      case "mac-app": throw new Error("app requests are handled by the daemon (the app's MacApp controller), not run."); // mac-apps
      case "read-file": {
        const p = this.within(req.path ?? "", readOpts);
        if (fs.statSync(p).isDirectory()) return { exitCode: 0, result: fs.readdirSync(p).sort().join("\n") };
        if (fs.statSync(p).size > max) throw new Error(STR5.localTooLarge);
        const text = fs.readFileSync(p, "utf8");
        // CLI parity: optional 1-based line range (offset/limit), paginated so a big file no longer errors out.
        if (typeof req.offset === "number" || typeof req.limit === "number") {
          const lines = text.split("\n");
          const start = Math.max(0, (req.offset ?? 1) - 1);
          const end = req.limit ? start + req.limit : lines.length;
          return { exitCode: 0, result: lines.slice(start, end).join("\n").slice(0, LIMITS5.localOutputMaxChars) };
        }
        return { exitCode: 0, result: text.slice(0, LIMITS5.localOutputMaxChars) };
      }
      case "edit-file": {
        // Claude Code's Edit: exact-string replace. Fails if the old string is absent, or non-unique without replaceAll.
        const p = this.within(req.path ?? "");
        const old = req.oldString ?? "";
        const next = req.newString ?? "";
        if (old === next) throw new Error("The old and new strings are identical.");
        const rfd = this.openChecked(p, io.target, { create: false, read: true }); // bug 441: read the file that is judged
        let text: string;
        try { text = fs.readFileSync(rfd, "utf8"); } finally { fs.closeSync(rfd); }
        const count = old === "" ? 0 : text.split(old).length - 1;
        if (count === 0) throw new Error("The exact text to replace was not found in the file.");
        if (count > 1 && !req.replaceAll) throw new Error(`The text to replace appears ${count} times; pass replace_all or make it unique.`);
        const out = req.replaceAll ? text.split(old).join(next) : text.replace(old, () => next); // a function: `$&` in the new text stays literal
        if (Buffer.byteLength(out) > max) throw new Error(STR5.localTooLarge);
        this.writeChecked(p, io.target, out, false);
        return { exitCode: 0, result: `Edited ${p} (${count} replacement${count === 1 ? "" : "s"}).` };
      }
      case "glob": return this.glob(req, max, readOpts);
      case "grep": return this.grep(req, readOpts);
      case "list-directory": {
        const p = this.within(req.path ?? ".", readOpts);
        return { exitCode: 0, result: fs.readdirSync(p, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort().join("\n") };
      }
      case "write-file": {
        const p = this.within(req.path ?? "");
        if (Buffer.byteLength(req.content ?? "") > max) throw new Error(STR5.localTooLarge);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        this.writeChecked(p, io.target, req.content ?? "", true);
        return { exitCode: 0, result: p };
      }
      case "copy-to-box": {
        const p = this.within(req.path ?? "", readOpts);
        const size = fs.statSync(p).size;
        if (size > max) throw new Error(STR5.localTooLarge);
        const fd = fs.openSync(p, "r");
        try {
          let offset = 0;
          const buf = Buffer.alloc(LIMITS5.localChunkBytes);
          do {
            const n = fs.readSync(fd, buf, 0, buf.length, offset);
            await io.uploadBox!(buf.subarray(0, n), offset, offset + n >= size);
            offset += n;
          } while (offset < size);
        } finally { fs.closeSync(fd); }
        return { exitCode: 0, result: `${size}` };
      }
      case "copy-from-box": {
        const p = this.within(req.path ?? "");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const out = this.openChecked(p, io.target, { create: true }); // bug 441
        fs.ftruncateSync(out, 0);
        let total = 0;
        try {
          for await (const chunk of io.readBox!(req.boxPath ?? "")) {
            total += chunk.length;
            if (total > max) throw new Error(STR5.localTooLarge);
            fs.writeSync(out, chunk);
          }
        } finally { fs.closeSync(out); }
        return { exitCode: 0, result: p };
      }
    }
  }

  private async shell(req: LocalExecRequest, io: IO): Promise<{ exitCode: number | null }> {
    // synapse-public (security review blocking 1): a run that might use claude gets a per-run proxy token up front,
    // revoked when the run ends (or at once if it never starts). The real key never enters any run's env, and no Claude
    // login ever does (the API key is the only sign-in). The host is asked before every claude run (no cache): no answer,
    // no key saved on the host (a stale Mac copy can't keep spending), or no budget OK: a run that signs in is refused.
    // Security review S2: claude's own sign-in commands are never run for a Bot (the API key is the only sign-in).
    if (isClaudeLoginCommand(req.command ?? "")) { io.output("stderr", `${MAC_CLAUDE_LOGIN_REFUSED_MSG}\n`); return { exitCode: 1 }; }
    const usesClaude = macWrappedUsesClaude(req.command ?? "");
    const auth: MacClaudeAuth | null = usesClaude && this.o.claudeAuth ? await this.o.claudeAuth(req.botId) : null;
    const refuse = (msg: string) => { io.output("stderr", `${msg}\n`); return { exitCode: 1 }; };
    if (usesClaude && macWrappedClaudeNeedsAuth(req.command ?? "")) {
      if (!auth) return refuse(MAC_CLAUDE_AUTH_UNKNOWN_MSG);
      if (!auth.keySaved) return refuse(MAC_CLAUDE_API_KEY_MSG);
      if (!auth.spend.ok) return refuse(auth.spend.message ?? MAC_CLAUDE_API_KEY_MSG);
    }
    const mode: "api-key" | "unknown" = auth ? "api-key" : "unknown";
    const spendOk = !!auth && auth.keySaved && auth.spend.ok;
    const grant: MacKeyGrantResult | null = usesClaude && spendOk ? (this.o.keyProxy ? await this.o.keyProxy.grant({ botId: req.botId }) : { refused: "proxy-down" }) : null;
    try {
      // Open item (round 3): the host's Savings cache TTL rides on its macClaudeAuth answer (optional: an older host omits it).
      return await this.shellWith(req, io, mode, grant, auth?.promptCacheTtl);
    } finally {
      if (grant && "token" in grant) grant.release();
    }
  }

  private shellWith(req: LocalExecRequest, io: IO, mode: "api-key" | "unknown", grant: MacKeyGrantResult | null, cacheTtl?: "5m" | "1h"): Promise<{ exitCode: number | null }> {
    const cwd = this.within(req.cwd ?? ".");
    // NEVER backstop on the Mac itself: even an approved command may not exfiltrate credentials. The host's
    // fixed rules and the reviewer already walled this; here it holds whatever the host said (defense in depth).
    const home = this.o.home?.() ?? os.homedir();
    // Bug 433: each path resolved once (a command naming thousands of paths resolved each one several times).
    const resolved = new Map<string, string | Error>();
    const realpath = (p: string): string => {
      let r = resolved.get(p);
      if (r === undefined) { try { r = realNative(p); } catch (e) { r = e instanceof Error ? e : new Error(String(e)); } resolved.set(p, r); }
      if (r instanceof Error) throw r;
      return r;
    };
    const never = evaluateFixedRules({ side: "mac", kind: "command", command: req.command ?? "", cwd }, { home, projectDirs: [], userData: this.o.userData?.() ?? null, realpath, readScript: readScriptCapped, noLimits: io.noLimits === true });
    if (never.verdict === "never") throw new Error(never.reason);
    if (macSandboxInteractive(req.command ?? "")) throw new Error(STR5.macExemptInteractive); // bug 232, as the policy
    return new Promise((resolve, reject) => {
      // Bug 229: a known self-sandboxing program runs unwrapped (the policy made it a card in every mode); the rest
      // run in the sandbox, and a nested-sandbox failure is named instead of left as a bare sandbox_apply line.
      // Bug 232: an unsandboxed run is one-shot: its stdin is closed and send-input to it is refused.
      // Bug 233: so does a hand-off that carries an approval id (the policy passes a hand-off only by consuming this
      // call's own card approval), and a command that is exactly `open <http(s) URL…>`. Both are one-shot too.
      const cmd = req.command ?? "";
      const urls = macPlainUrlOpenArgs(cmd);
      const exemptTool = macSandboxExemptSimple(cmd) ? macExemptTool(cmd) : null; // bug 236: one simple command only
      // Private-store hardening: a card-approved single plain read of one private store (`cat <store>`) runs unwrapped
      // for that one call; the policy passes it only by consuming this call's own card approval, in every mode.
      const stores = storeRulesFor(home, this.o.testPrivateStores);
      const isStore = (p: string): boolean => macPrivateStorePath(p, home, stores);
      const storeRead = !!req.approvalId && !!macPrivateStoreRead(cmd, { home, cwd, realpath: realNative, isStore });
      const unsandboxed = !!exemptTool || (!!req.approvalId && !!macUnsandboxedHandoff(cmd, { home, cwd })) || storeRead || urls !== null || macSafeGitConfigSet(cmd); // bug 237: an ordinary `git config --global <safe key>` (the sandbox denies ~/.gitconfig)
      const noLimits = io.noLimits === true;
      // Bug 258: an everyday hand-off the policy passed with no card (Full auto) runs in the LIGHT sandbox: osascript and
      // open may run, every file deny and the keychain block stay. The executor checks the command again itself.
      const quiet = !unsandboxed && io.quiet === true && !req.approvalId && !!macQuietHandoff(cmd, {
        home, cwd, userData: this.o.userData?.() ?? null, realpath: realNative, isStore, noLimits,
        isExecFile: (p) => { try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } },
        isAllowedApp: (n) => macAllowedApp(n, home),
        isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
      });
      const sb = unsandboxed ? null : sandboxFor(this.o.userData?.(), home, { testPrivateStores: this.o.testPrivateStores, testProfileExtra: this.o.testProfileExtra, noLimits, handoffLite: quiet });
      /** One-shot: no stdin, and send-input to it is refused (every run outside the full sandbox). */
      const oneShot = unsandboxed || quiet;
      // Fail closed: only the explicitly unwrapped runs above skip the sandbox. If it can't be applied, refuse.
      if (!unsandboxed && !sb) return reject(new Error(STR5.macSandboxUnavailable));
      // Bug 234: nothing a sandboxed Bot could have planted reaches an unwrapped run. A plain URL open spawns the one
      // system `open` with the URLs (no shell, no PATH); every other unwrapped run is `zsh -f` (no startup files) with
      // the fixed PATH plus only the exempt tool's own resolved directory. Wrapped runs keep the login shell.
      let argv: string[];
      // Review round 3 (S6): the env is built last, by macRunEnv (login-scrub.ts, over the shared claudeEnv): every login
      // variable deleted and checked at runtime, and the dead sentinel key and closed base URL unless this run's grant
      // replaces them, so a claude the parser missed can never fall back to a stored Claude login.
      let env: Record<string, string | undefined> = macExecEnv();
      let runGrant: { token: string; baseUrl: string } | null = null;
      let claudeConfigDir: string | undefined;
      let bridge: OpenBridge | null = null;
      if (urls) argv = [this.o.openBinary ?? SYSTEM_OPEN, ...urls];
      else if (quiet) {
        // Bug 258: `zsh -f` with the fixed PATH, as for an unwrapped run, so nothing a Bot planted is sourced or found.
        argv = [...sb!, "/bin/zsh", "-f", "-c", cmd];
        env = { ...env, PATH: FIXED_PATH, ...UNWRAPPED_GIT_ENV };
      }
      else if (unsandboxed) {
        // Bug 235: an exempt tool runs by its pinned realpath (zsh's command hash maps the name to it), with the fixed
        // PATH plus only its interpreter's realpath dir; a tool that changed since its card was approved is refused.
        let pre = "";
        let PATH = FIXED_PATH;
        if (exemptTool) {
          const now = pinTool(exemptTool, { home });
          if (!now || (io.pin && !samePin(io.pin, now))) return reject(new Error(`${STR5.macToolChanged} (${exemptTool} → ${now?.realpath ?? "not found"})`));
          PATH = pinnedPath(now);
          if (!exemptTool.includes("/") && /^[A-Za-z0-9._+-]+$/.test(exemptTool)) pre = `hash ${exemptTool}=${shQuote(now.realpath)}; `;
        }
        argv = ["/bin/zsh", "-f", "-c", `${pre}${cmd}`];
        env = { ...env, PATH, ...UNWRAPPED_GIT_ENV };
        // Review round 3 (S2c): an unsandboxed run (an exempt tool, an approved hand-off) keeps the dead sentinel and gets
        // an empty app-owned claude config dir, so a claude it starts finds no login and no settings. (An approved
        // exempt tool runs outside the sandbox, with the access the user approved it for.)
        const ud = this.o.userData?.();
        if (ud) { try { claudeConfigDir = emptyClaudeConfigDir(ud); } catch { /* no data folder: the sentinel still holds */ } }
      } else {
        // Bug 239: claude and codex run here, in the sandbox; their own sandboxes are turned off (ours is the boundary).
        // Bug 258: in Full auto a dev tool that opens a web page (vite --open, jupyter, `open http://localhost:…` in a
        // script) reaches the browser through the bridge: an `open` first on PATH and $BROWSER that pass only http(s).
        if (sb && io.openBridge) { try { bridge = new OpenBridge(this.o.openBinary ?? SYSTEM_OPEN); } catch { bridge = null; } }
        argv = [...(sb ?? []), "/bin/zsh", "-lc", `${sb ? macWrappedToolPrelude(cmd) : ""}${bridge ? bridge.prelude() : ""}${cmd}`];
        // Bug 240 (ruling): a wrapped claude gets a Synapse-owned config dir (0700), never the user's ~/.claude — added
        // to the env on purpose, beside the MAC_EXEC_ENV_KEYS allowlist, and only for a run that uses claude.
        if (sb && macWrappedUsesClaude(cmd)) {
          claudeConfigDir = synapseClaudeDir(home);
          if (mode === "api-key") {
            // The Bots' claude reaches Anthropic through the coordinator's key proxy with a token for this run only
            // (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY = the token); never the key. No key on this Mac, or no proxy: the
            // run is refused (fail closed).
            const g = grant && "token" in grant ? grant : null;
            if (g) runGrant = { token: g.token, baseUrl: g.baseUrl };
            else if (macWrappedClaudeNeedsAuth(cmd)) {
              io.output("stderr", `${grant && "refused" in grant && grant.refused === "proxy-down" ? MAC_CLAUDE_PROXY_DOWN_MSG : MAC_CLAUDE_API_KEY_MSG}\n`);
              return resolve({ exitCode: 1 });
            }
          }
          // mode "unknown" (review fix 3): the host couldn't be asked. Only a run that merely mentions claude gets here
          // (one that signs in was refused above), and it runs with no credential at all.
        }
      }
      let child: ChildProcess;
      let runEnv: Record<string, string>;
      try {
        // The Savings "Keep conversations ready" TTL from the host's answer (1h when it doesn't say).
        runEnv = macRunEnv(env, { grant: runGrant, claudeConfigDir, cacheTtl: cacheTtl ?? this.o.promptCacheTtl?.() ?? "1h" });
      } catch (e) { bridge?.close(); return reject(e as Error); }
      try {
        child = spawn(argv[0]!, argv.slice(1), { cwd, env: runEnv, detached: true, stdio: [oneShot ? "ignore" : "pipe", "pipe", "pipe"] });
      } catch (e) { bridge?.close(); return reject(e as Error); }
      this.procs.set(req.execId, child);
      if (oneShot) this.unsandboxed.add(req.execId);
      bridge?.start();
      const timer = req.timeoutMs ? setTimeout(() => this.kill(req.execId), req.timeoutMs) : null;
      let nested = false;
      let blocked = false;
      let keychain = false;
      let github = false;
      let privateStore = false;
      // A denied line that names a store (the rules unanchored at the end: the path is followed by ": Operation …").
      const storeNamed = stores.deny.map((r) => new RegExp(r.slice(1).replace(/\$$/, "")));
      const gitNetwork = !!sb && macUsesGitNetworkOrGh(cmd);
      const seen = (s: string) => {
        if (!sb) return;
        if (!nested && NESTED_SANDBOX.test(s)) nested = true;
        if (!blocked && s.split("\n").some((l) => HANDOFF_BLOCKED.test(l) && HANDOFF_NAMES.test(l))) blocked = true;
        if (!privateStore && s.split("\n").some((l) => HANDOFF_BLOCKED.test(l) && storeNamed.some((re) => re.test(l)))) privateStore = true;
        if (!keychain && KEYCHAIN_NEEDED.test(s)) keychain = true;
        if (!github && gitNetwork && GITHUB_CREDENTIALS_NEEDED.test(s)) github = true;
      };
      child.stdout!.on("data", (d: Buffer) => { const s = d.toString("utf8"); seen(s); io.output("stdout", s); });
      child.stderr!.on("data", (d: Buffer) => { const s = d.toString("utf8"); seen(s); io.output("stderr", s); });
      child.on("error", (e) => { bridge?.close(); reject(e); });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        bridge?.close();
        this.procs.delete(req.execId);
        this.unsandboxed.delete(req.execId);
        if (nested) io.output("stderr", `\n${STR5.macNestedSandbox}\n`);
        else if (blocked) io.output("stderr", `\n${STR5.macHandoffBlocked}\n`);
        else if (privateStore) io.output("stderr", `\n${STR5.macPrivateStoreBlocked}\n`);
        else if (github) io.output("stderr", `\n${STR5.macGithubFromBotComputer}\n`);
        else if (keychain) io.output("stderr", `\n${STR5.macKeychainBlocked}\n`);
        resolve({ exitCode: nested && code === 0 ? 1 : code });
      });
    });
  }
}
