import { realOfDeepest } from "./linear-text";
import { macPrivateStorePath } from "./mac-private-stores";
import { appDataWalls } from "./app-data";
import { parseShell, shPath, type ShCmd, type ShWord } from "./shell-parse";

/**
 * Bug 229: every Mac command runs under sandbox-exec, which denies the app's own data folder (the permission key and
 * the signed permission files; bug 225). Two things follow.
 *
 * 1. A program that applies a sandbox of its own can't run inside one ("sandbox_apply: Operation not permitted"). A
 *    small known list of them runs WITHOUT the wrapper — still behind the static NEVER rules, and always with the
 *    user's card, in every mode, Full auto included (nothing else guards the key for that one run).
 * 2. A command can hand code to something that runs later OUTSIDE the sandbox: launchd, cron, a script or app opened
 *    through LaunchServices, Terminal/iTerm told to run a line. Those always ask, Full auto included.
 */

const text = (w: ShWord | undefined): string => (w && !w.dynamic ? w.text : "");
const args = (c: ShCmd): string[] => c.argv.slice(1).map((w) => text(w));

/** A package runner's target: `npx playwright`, `pnpm exec playwright`, `yarn dlx electron`. */
function runnerTarget(c: ShCmd): string | null {
  const runners: Record<string, string[]> = { npx: [], bunx: [], pnpx: [], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], npm: ["exec"], bun: ["x"] };
  const skip = runners[c.program];
  if (!skip) return null;
  const rest = args(c).filter((a) => !a.startsWith("-"));
  if (skip.length && !skip.includes(rest[0] ?? "")) return c.program === "npm" || c.program === "bun" ? null : rest[0] ?? null;
  return (skip.length ? rest[1] : rest[0]) ?? null;
}

/**
 * Bug 239 (ruling): only tools that truly apply a sandbox of their own run unwrapped — Swift, Xcode, and the browser
 * engines (Playwright, Electron, Chromium). claude and codex are NOT exempt: they run inside the command sandbox like
 * anything else, so every deny applies to whatever they do, whatever flags or project files they read
 * (macWrappedToolPrelude turns their own sandboxes off there — ours is the boundary).
 */
const EXEMPT_PROGRAMS: Record<string, string> = {
  swift: "Swift", "swift-build": "Swift", "swift-test": "Swift", xcodebuild: "Xcode",
  playwright: "Playwright", electron: "Electron", chromium: "Chromium", "Google Chrome for Testing": "Chromium",
};

function exemptOne(c: ShCmd): string | null {
  if (!c.argv[0] || c.argv[0].dynamic) return null;
  const name = c.program;
  if (EXEMPT_PROGRAMS[name]) return EXEMPT_PROGRAMS[name]!;
  const via = runnerTarget(c);
  if (via) {
    const base = via.replace(/^@[^/]+\//, "").replace(/@.*$/, "");
    if (base === "playwright" || (base === "test" && via.startsWith("@playwright/"))) return "Playwright";
    if (EXEMPT_PROGRAMS[base]) return EXEMPT_PROGRAMS[base]!;
    return null;
  }
  return null;
}

/** The known program this command runs that can't live inside the command sandbox, or null. Unreadable text: null. */
export function macSandboxExempt(command: string): string | null {
  const p = parseShell(command, { cwd: null, home: "/" });
  if (p.opaque.length > 0) return null;
  for (const c of p.cmds) {
    const hit = exemptOne(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Bug 236: an exempt tool runs unwrapped only as ONE simple command, optionally after a leading `cd <dir> &&` — no `;`,
 * no further `&&`/`||`, no pipe, no substitution, no background, no env assignment (`PATH=…`), no wrapper (`env`,
 * `command` …), no `hash`, and no redirect but `2>&1`. Anything else stays in the sandbox (and a tool that needs its own
 * sandbox fails there with the nested-sandbox message). Returns the exempt tool's name when this command qualifies.
 */
export function macSandboxExemptSimple(command: string): string | null {
  const c = singleSimple(command);
  if (!c) return null;
  return exemptOne(c);
}

/** One simple command (optionally after `cd <dir> &&`): no chain, pipe, substitution, assignment, wrapper, hash,
 *  dynamic word or redirect but `2>&1`. */
function singleSimple(command: string): ShCmd | null {
  const m = /^\s*(?:cd\s+('[^']*'|"[^"$`\\]*"|[^\s;&|<>()$`'"\\]+)\s*&&\s*)?([\s\S]*)$/.exec(command);
  if (!m) return null;
  const rest = m[2]!;
  const p = parseShell(rest, { cwd: null, home: "/" });
  if (p.opaque.length > 0 || p.cmds.length !== 1 || p.compound || p.hasPipe || p.hasSubstitution || p.background) return null;
  const c = p.cmds[0]!;
  if (c.assigns.length > 0 || c.wrappers.length > 0 || c.argsUnknown || c.programFromInput || c.stdin !== null) return null;
  if (c.program === "hash" || c.program === "cd" || /(^|\s)PATH=/.test(rest)) return null;
  if (c.argv.some((w) => w.dynamic || w.procSubst !== null)) return null;
  if (c.redirects.some((r) => !(r.fd === 2 && r.op === ">&" && r.target?.text === "1"))) return null;
  return c;
}

/**
 * Bug 237 + bug 151's decision (a `git config --global` edit doesn't ask in Full auto): the sandbox now denies writing
 * ~/.gitconfig, so an ordinary global setting (name, email, default branch …) is set by ONE simple
 * `git config --global <safe key> <value>` run unwrapped (zsh -f, fixed PATH) with no card. A key that runs code
 * (core.fsmonitor, core.hooksPath, core.sshCommand, aliases, helpers, filters, includes …) is a hand-off and asks.
 */
const SAFE_GIT_KEYS = new Set(["user.name", "user.email", "init.defaultbranch", "pull.rebase", "pull.ff", "push.default", "push.autosetupremote", "color.ui", "fetch.prune", "rebase.autostash", "merge.conflictstyle", "core.autocrlf", "core.ignorecase", "core.quotepath", "advice.detachedhead", "branch.sort", "tag.sort", "column.ui", "help.autocorrect", "diff.algorithm", "diff.colormoved", "commit.verbose", "rerere.enabled"]);
export function macSafeGitConfigSet(command: string): boolean {
  const c = singleSimple(command);
  return !!c && c.argv[0]!.text === "git" && safeGitSet(c);
}
function safeGitSet(c: ShCmd): boolean {
  if (c.program !== "git") return false;
  const a = args(c);
  if (a[0] !== "config") return false;
  const rest = a.slice(1).filter((x) => x !== "--global" && x !== "--add" && x !== "--replace-all");
  if (!a.includes("--global") || rest.length !== 2 || rest.some((x) => x.startsWith("-"))) return false;
  return SAFE_GIT_KEYS.has(rest[0]!.toLowerCase());
}

/**
 * Bug 232/239: an exempt program runs outside the sandbox, so it may run ONE-SHOT only (its stdin is closed and nothing
 * can be sent to it later). Of the exempt tools only Swift has an interactive form (the REPL), which is refused.
 * (claude and codex are no longer exempt: their interactive modes run in the sandbox under the normal rules.)
 */
export function macSandboxInteractive(command: string): string | null {
  const p = parseShell(command, { cwd: null, home: "/" });
  for (const c of p.cmds) {
    if (c.program !== "swift" || !c.argv[0] || c.argv[0].dynamic) continue;
    const rest = args(c);
    const info = rest.some((a) => a === "--version" || a === "-version" || a === "--help" || a === "-h");
    const verbs = rest.filter((a) => a && !a.startsWith("-"));
    if (!info && (verbs.length === 0 || verbs[0] === "repl")) return "Swift";
  }
  return null;
}

/**
 * Bug 240 (ruling): a wrapped claude never uses the user's ~/.claude or ~/.claude.json (both stay protected for the
 * user's own Terminal). It gets a Synapse-owned config dir instead — writable inside the sandbox, never read by the
 * user's Terminal claude. Its settings/hooks/plugins there are write-denied like the user's own (MAC_TOOL_CONFIG_*).
 * synapse-public: the Bots' claude on the Mac signs in only with the Anthropic API key, as a per-run token for the
 * coordinator's loopback key proxy (never a Claude login, never the key itself).
 */
export const MAC_CLAUDE_CONFIG_DIR = ".synapse/claude-mac";
/** This Mac has no copy of the key (the box never sends it back). */
export const MAC_CLAUDE_API_KEY_MSG = "claude on this Mac needs the Anthropic API key. Ask the user to save it in Settings → Account.";
/** Review fix 3: the host couldn't answer (key saved? budget?), so claude wasn't run (never a guess). */
export const MAC_CLAUDE_AUTH_UNKNOWN_MSG = "Couldn't check with the Bots' computer how claude signs in, so claude wasn't run. Try again in a moment.";
/** What the host answers before each claude run on the Mac (macClaudeAuth). */
export interface MacClaudeAuth {
  keySaved: boolean;
  spend: { ok: boolean; message: string | null };
  /** Review round 3: the Savings "Keep conversations ready" setting, pinned on a granted run (absent from an older host: 1h). */
  promptCacheTtl?: "5m" | "1h";
}
/** The coordinator's key proxy couldn't start, so claude runs are refused (fail closed). */
export const MAC_CLAUDE_PROXY_DOWN_MSG = "Couldn't start the key proxy on this Mac, so claude wasn't run. Ask the user to restart Synapse.";

/** Bug 240: whether a wrapped command runs claude (and so gets CLAUDE_CONFIG_DIR and the claude prelude). */
export function macWrappedUsesClaude(command: string): boolean {
  const p = parseShell(command, { cwd: null, home: "/" });
  return p.cmds.some((c) => c.program === "claude") || /(^|[\s;&|(`$'"])claude([\s;&|)`'"]|$)/.test(command);
}

/**
 * mac-keychain-guard: whether a wrapped command invokes claude to do real work (so the app gates sign-in first). A
 * claude call that is only `--version`/`-v`/`--help`/`-h` or `auth …` needs no sign-in and no gate. A compound needs the
 * gate if ANY of its claude calls is real work; a claude call the parser can't read counts as real work (fail safe).
 */
export function macWrappedClaudeNeedsAuth(command: string): boolean {
  const p = parseShell(command, { cwd: null, home: "/" });
  const claudes = p.cmds.filter((c) => c.program === "claude");
  if (claudes.length === 0) return macWrappedUsesClaude(command); // parser missed it (subst/opaque): fail safe
  return claudes.some((c) => {
    const first = args(c).find((a) => a && !a.startsWith("-"));
    if (first === "auth") return false;
    const only = args(c).every((a) => ["--version", "-v", "--help", "-h"].includes(a) || a === "");
    return !only;
  });
}

/**
 * mac-keychain-guard (ruling, second): Bots never use the user's Mac credentials. Mac-side git push/fetch/pull/clone/
 * ls-remote and gh stay INSIDE the command sandbox (anonymous HTTPS works; the keychain doesn't), and Bots do their
 * GitHub work from their own computer with their own gh sign-in (bug 195). When a Mac-side git or gh needed the user's
 * credentials, the executor says so (STR5.macGithubFromBotComputer).
 */
export function macUsesGitNetworkOrGh(command: string): boolean {
  const p = parseShell(command, { cwd: null, home: "/" });
  return p.cmds.some((c) => c.program === "gh" || (c.program === "git" && ["push", "fetch", "pull", "clone", "ls-remote", "remote", "submodule"].includes(args(c).find((a) => !a.startsWith("-")) ?? "")));
}

/**
 * Bug 239: claude and codex run INSIDE the command sandbox. Their own sandboxes would nest there (and fail), and ours is
 * the boundary, so a wrapped run defines shell functions that turn them off: claude gets
 * `--settings '{"sandbox":{"enabled":false}}'` (its Bash-tool sandbox), codex gets `--sandbox danger-full-access` on
 * `codex exec` and the TUI unless the command already chose a sandbox mode. `function name { … }` so a user alias of the
 * same name is not expanded into the definition. Returns "" when neither tool is in the command.
 */
export function macWrappedToolPrelude(command: string): string {
  const p = parseShell(command, { cwd: null, home: "/" });
  const names = new Set(p.cmds.map((c) => c.program));
  let out = "";
  if (macWrappedUsesClaude(command)) {
    // Bug 240: wrapped claude uses its own config dir (CLAUDE_CONFIG_DIR, set by the executor). The executor has already
    // gated sign-in outside the sandbox (mac-keychain-guard), so here the function only turns claude's own Bash-tool
    // sandbox off — ours is the boundary. `auth` and the info flags are left alone.
    out += `function claude { case "$1" in auth|--version|-v|--help|-h) command claude "$@"; return;; esac; `
      + `command claude --settings '{"sandbox":{"enabled":false}}' "$@"; }; `;
  }
  const codexChoseSandbox = p.cmds.some((c) => c.program === "codex" && args(c).some((a) => /^(--sandbox|-s|--dangerously-bypass-approvals-and-sandbox|--yolo|--full-auto)(=|$)|^-s./.test(a)));
  if ((names.has("codex") || /(^|[\s;&|(`$'"])codex([\s;&|)`'"]|$)/.test(command)) && !codexChoseSandbox) {
    out += `function codex { case "$1" in exec|e) local s="$1"; shift; command codex "$s" --sandbox danger-full-access "$@";; login|logout|mcp|mcp-server|app-server|completion|debug|apply|a|help|sandbox|cloud|proto|resume|generate-ts) command codex "$@";; *) command codex --sandbox danger-full-access "$@";; esac; }; `;
  }
  return out;
}

const HANDOFF_EXT = /\.(command|sh|tool|app|terminal|workflow|scpt|scptd|applescript)\/?$/i;
/** Bug 232: osascript code that names or drives an app (the app acts outside the sandbox), or loads another script. */
const OSA_DRIVES_APP = /\b(tell|application|app\s+"|app\s+id|login\s+items?|run\s+script|load\s+script|do\s+shell\s+script)\b/i;
const TERMINALS = /\b(Terminal|iTerm2?)\b/i;
const TERMINAL_RUN = /\b(do script|doScript|write text|writeText|keystroke|create window with|createWindowWith)\b/i;
const LAUNCH_DIRS = ["Library/LaunchAgents", "Library/LaunchDaemons"];
const WRITERS = new Set(["cp", "mv", "ln", "tee", "install", "rsync", "ditto", "touch", "dd", "plutil", "defaults", "sed", "curl", "wget", "unzip", "tar"]);

function inLaunchDir(abs: string, home: string): boolean {
  const f = abs.toLowerCase();
  const h = home.replace(/\/+$/, "").toLowerCase();
  return LAUNCH_DIRS.some((d) => {
    for (const root of [`${h}/${d.toLowerCase()}`, `/${d.toLowerCase()}`]) if (f === root || f.startsWith(`${root}/`)) return true;
    return false;
  });
}

function handoffOne(c: ShCmd, home: string): string | null {
  if (c.program === "launchctl") return "launchctl starts a job that runs later, outside the command sandbox";
  if (c.program === "crontab") return "crontab schedules commands that run later, outside the command sandbox";
  for (const r of c.redirects) {
    if (!r.target || !/>/.test(r.op)) continue;
    const abs = shPath(r.target, c.cwd, home);
    if (abs && inLaunchDir(abs, home)) return "it writes a launch item that macOS runs later, outside the command sandbox";
  }
  if (WRITERS.has(c.program)) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = shPath(w, c.cwd, home);
      if (abs && inLaunchDir(abs, home)) return "it writes a launch item that macOS runs later, outside the command sandbox";
    }
  }
  if (c.program === "at" || c.program === "batch") return "it schedules commands that run later, outside the command sandbox";
  if (c.program === "open") {
    // Bug 232: any chosen app (-a/-b, alone or in a flag cluster like -na), any argument that can't be known ahead of
    // time (a variable, a substitution, a glob), and any script/app/workflow/terminal file asks.
    const words = c.argv.slice(1);
    const end = words.findIndex((w) => w.text === "--args");
    const own = end >= 0 ? words.slice(0, end) : words;
    if (own.some((w) => w.dynamic || w.glob || w.procSubst !== null)) return "it opens something that can't be known ahead of time, outside the command sandbox";
    if (own.some((w) => /^-[A-Za-z]*[ab]/.test(w.text))) return "it opens a chosen app, which runs outside the command sandbox";
    if (own.some((w) => !w.text.startsWith("-") && HANDOFF_EXT.test(w.text))) return "it opens a script, a workflow or an app, which runs outside the command sandbox";
    // Bug 233: anything but an http(s) URL — an extensionless executable, a .fileloc, a symlink to an app, a
    // (percent-encoded) file:// URL, another URL scheme — is a hand-off, whatever its extension.
    if (c.argsUnknown || own.some((w) => !w.text.startsWith("-") && !HTTP_URL.test(w.text))) return "it opens a local file or app, which runs outside the command sandbox";
  }
  if (c.program === "osascript") {
    // Bug 232: a script file, another language (-l), several lines, code from stdin or a variable, or code that names
    // an app asks. Bug 233: osascript is exec-denied inside the sandbox, so EVERY osascript is a hand-off (the card's
    // approval runs it unwrapped); the specific reasons are kept for the card.
    const w = c.argv.slice(1);
    const plain = w.length === 2 && w[0]!.text === "-e" && !w[0]!.dynamic && !w[1]!.dynamic && !c.programFromInput && c.stdin === null;
    if (!plain) return "osascript runs a script file, another language or code it reads elsewhere, which can drive apps outside the command sandbox";
    if (OSA_DRIVES_APP.test(w[1]!.text)) return "osascript drives an app, which acts outside the command sandbox";
    return "osascript runs outside the command sandbox";
  }
  if (c.program === "sfltool") return "sfltool manages login and background items, outside the command sandbox";
  // Bug 234: Shortcuts and Automator run workflows outside the command sandbox.
  if (c.program === "shortcuts") return "Shortcuts runs a shortcut, outside the command sandbox";
  if (c.program === "automator") return "Automator runs a workflow, outside the command sandbox";
  // Bug 234: a shell startup file is code the user's own Terminal runs later, outside the sandbox (which denies writing
  // them): a write is a hand-off, and the approved card runs it unwrapped for that call.
  for (const r of c.redirects) {
    if (!r.target || !/>/.test(r.op)) continue;
    const abs = shPath(r.target, c.cwd, home);
    if (abs && isStartupFile(abs, home)) return STARTUP_WHY;
  }
  if (WRITERS.has(c.program) || c.program === "sed" || c.program === "perl") {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = shPath(w, c.cwd, home);
      if (abs && isStartupFile(abs, home)) return STARTUP_WHY;
    }
  }
  if (c.inlineCode.some((code) => STARTUP_NAMES.test(code))) return STARTUP_WHY;
  // Bug 237: the config a tool run outside the sandbox reads (Claude's settings and hooks, Codex's config, git's global
  // config) — the same shape: the sandbox denies the write, and an approved card runs it unwrapped for that call.
  for (const r of c.redirects) {
    if (!r.target || !/>/.test(r.op)) continue;
    const abs = shPath(r.target, c.cwd, home);
    if (abs && isToolConfig(abs, home)) return TOOL_CONFIG_WHY;
  }
  if (WRITERS.has(c.program) || c.program === "sed" || c.program === "perl") {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = shPath(w, c.cwd, home);
      if (abs && isToolConfig(abs, home)) return TOOL_CONFIG_WHY;
    }
  }
  if (c.inlineCode.some((code) => TOOL_CONFIG_NAMES.test(code))) return TOOL_CONFIG_WHY;
  if (c.program === "git") {
    const a = args(c);
    const i = a.indexOf("config");
    const rest = i >= 0 ? a.slice(i + 1) : [];
    const global = rest.some((x) => x === "--global" || x === "--system" || x === "--file" || x === "-f");
    const reads = rest.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only)$/.test(x) || x === "get" || x === "list");
    if (i >= 0 && global && !reads && !safeGitSet(c)) return TOOL_CONFIG_WHY;
  }
  return null;
}

/** Bug 237: the tool config the sandbox denies writing (executor.ts adds them to the profile; perm-rules asks). */
export const MAC_TOOL_CONFIG_FILES = [".claude/settings.json", ".claude/settings.local.json", ".claude.json", ".gitconfig", ".synapse/claude-mac/settings.json", ".synapse/claude-mac/settings.local.json"] as const;
export const MAC_TOOL_CONFIG_DIRS = [".claude/hooks", ".claude/plugins", ".codex", ".config/git", ".config/gh", ".local/share/gh", ".synapse/claude-mac/hooks", ".synapse/claude-mac/plugins"] as const;
const TOOL_CONFIG_WHY = "it changes settings that a program run outside the command sandbox reads (Claude, Codex or git)";
const TOOL_CONFIG_NAMES = /(\.claude\/settings(\.local)?\.json|\.claude\.json|\.claude\/hooks|\.claude\/plugins|\.codex\/|\.gitconfig|\.config\/git|\.config\/gh\/|\.local\/share\/gh\/|\.synapse\/claude-mac\/(settings(\.local)?\.json|hooks|plugins))/;
export function macIsToolConfig(abs: string, home: string): boolean { return isToolConfig(abs, home); }
function isToolConfig(abs: string, home: string): boolean {
  const f = abs.toLowerCase();
  const h = home.replace(/\/+$/, "").toLowerCase();
  return MAC_TOOL_CONFIG_FILES.some((x) => f === `${h}/${x}`) || MAC_TOOL_CONFIG_DIRS.some((d) => f === `${h}/${d}` || f.startsWith(`${h}/${d}/`));
}

/** Bug 234: the shell startup files the sandbox denies writing (executor.ts STARTUP_FILES mirrors this list). */
export const MAC_STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".bash_profile", ".bashrc", ".profile", ".ssh/rc"] as const;
export const MAC_STARTUP_DIRS = [".config/fish"] as const;
const STARTUP_WHY = "it changes a shell startup file, which the user's own Terminal runs later, outside the command sandbox";
const STARTUP_NAMES = /(\.zshenv|\.zprofile|\.zshrc|\.zlogin|\.zlogout|\.bash_profile|\.bashrc|\.profile|\.ssh\/rc|\.config\/fish)\b/;
function isStartupFile(abs: string, home: string): boolean {
  const f = abs.toLowerCase();
  const h = home.replace(/\/+$/, "").toLowerCase();
  return MAC_STARTUP_FILES.some((x) => f === `${h}/${x}`) || MAC_STARTUP_DIRS.some((d) => f === `${h}/${d}` || f.startsWith(`${h}/${d}/`));
}

/** Bug 234: the program an exempt command runs (as written: a name or a path), for resolving and showing on the card. */
export function macExemptTool(command: string): string | null {
  const p = parseShell(command, { cwd: null, home: "/" });
  if (p.opaque.length > 0) return null;
  for (const c of p.cmds) if (exemptOne(c)) return c.argv[0]?.text ?? null;
  return null;
}

const RAW_HANDOFFS: Array<[RegExp, string]> = [
  [/(^|[^\w-])(launchctl|crontab)([^\w-]|$)/, "it may start or schedule a job that runs later, outside the command sandbox"],
  [/Library\/Launch(Agents|Daemons)/i, "it may write a launch item that macOS runs later, outside the command sandbox"],
  [/\b(LoginHook|LogoutHook)\b/, "it may set a login or logout hook, which runs outside the command sandbox"],
  [/\bSMAppService\b|\bloginitems?\b|\blogin\s+items?\b|\bsfltool\b/i, "it may add a login item, which runs outside the command sandbox"],
  [/(^|[\s;&|(`'"])(at\s+(-[a-zA-Z]|now\b|noon\b|midnight\b|teatime\b|tomorrow\b)|batch(\s|$|["']))/, "it may schedule commands that run later, outside the command sandbox"],
];

const HTTP_URL = /^https?:\/\/[^\s/]/i;

/**
 * Bug 233: /usr/bin/open is exec-denied inside the sandbox. A web page still opens when the WHOLE command is exactly
 * `open <http(s) URL…>` — one command, no flags, no redirects, nothing dynamic — which then runs unwrapped: nothing
 * else can run beside it, and the URLs go to the browser, never to a local file or app.
 */
export function macPlainUrlOpen(command: string): boolean {
  return macPlainUrlOpenArgs(command) !== null;
}

/** Bug 234: the URLs of a plain `open <http(s) URL…>`, which the executor hands to /usr/bin/open directly (no shell). */
export function macPlainUrlOpenArgs(command: string): string[] | null {
  const p = parseShell(command, { cwd: null, home: "/" });
  if (p.opaque.length > 0 || p.cmds.length !== 1 || p.compound || p.hasPipe || p.hasRedirect || p.hasSubstitution || p.background) return null;
  const c = p.cmds[0]!;
  if (c.program !== "open" || c.wrappers.length > 0 || c.argsUnknown || c.redirects.length > 0 || c.argv[0]?.text !== "open") return null;
  const urls = c.argv.slice(1);
  return urls.length > 0 && urls.every((w) => !w.dynamic && !w.glob && w.procSubst === null && HTTP_URL.test(w.text)) ? urls.map((w) => w.text) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Bug 258 (fullauto-frictionless): the Full-auto split of the hand-offs above.
//
// In Full auto an EVERYDAY hand-off runs with no card: AppleScript given as `-e` code whose whole text can be read,
// and `open` of a local file, a folder or an installed app. It runs as ONE simple command in a light sandbox (the
// executor keeps every file deny, the keychain block and the exec deny on launchctl/cron/at/Shortcuts/Automator, and
// only lets osascript and open themselves run). The HIGH-RISK forms keep their card in every mode: driving Terminal
// or iTerm (or any app that runs scripts), login items and startup agents, cron/at/launchctl, a shell run from
// AppleScript, and anything aimed at a private store or the app's own data. Code or a target that can't be read
// ahead of time is high risk too. No limits (per Bot, opt-in) lets a private store through; never the app's data.
// ---------------------------------------------------------------------------------------------------------------

export interface MacHandoffContext {
  home: string;
  cwd?: string | null;
  /** The app's own data folder (the permission key and the signed policy files). */
  userData?: string | null;
  /** A path's on-disk form (the Mac passes fs.realpathSync.native). */
  realpath?(p: string): string;
  /** Mac only: an executable regular file (opening one runs it in Terminal). Without it, an extensionless target asks. */
  isExecFile?(abs: string): boolean;
  /** The private-store test (the executor's list); default the real list. */
  isStore?(abs: string): boolean;
  /** The Bot is in No limits: a private store stops being a high-risk target. */
  noLimits?: boolean;
  /**
   * Fix round (review of bug 258): an app that existed before the Bot ran and the Bot can't have written — under
   * /System/Applications, or /Applications with a root-owned or Apple/Developer-ID-signed bundle and a verified
   * codesign. Takes the app as `open`/`tell` names it (a name, a path, or a bundle id). The Mac passes a cached
   * check; without it (shared tests) the caller's stub decides, and an app is refused when neither is present.
   */
  isAllowedApp?(nameOrPath: string): boolean;
  /** Mac only: a real folder (it opens in Finder). */
  isDir?(abs: string): boolean;
}

/**
 * Fix round: Synapse's own app, so a Bot can never drive it (click its own approval cards or the No limits confirm).
 * By product name, by the visible name, or by the bundle id. Matched on a word boundary so "Synapsew" doesn't hit.
 */
const SYNAPSE_APP = /(^|[^\w.])(Bots|Synapse|com\.nyfeblade\.synapse)([^\w.]|$)/i;
export function namesSynapseApp(text: string): boolean {
  return SYNAPSE_APP.test(text);
}

/** Apple's own system apps, trusted for `activate`/`quit`/`open location` and the read-only queries below without a
 *  codesign round-trip (they live under /System and can't be planted). */
const APPLE_SYSTEM_APPS = /^(System Events|Finder|Music|Safari|Mail|Notes|Reminders|Calendar|Contacts|Messages|Preview|TextEdit|Photos|Maps|Terminal|Console|System Settings|System Preferences)$/i;
function allowedAppName(app: string, ctx: MacHandoffContext): boolean {
  if (namesSynapseApp(app)) return false;
  const name = app.trim();
  if (ctx.isAllowedApp) return ctx.isAllowedApp(name);
  // No Mac check available (shared unit tests use their own stub): trust only the Apple system apps by name.
  return APPLE_SYSTEM_APPS.test(name) || /^com\.apple\./i.test(name);
}

const RUNS_COMMANDS_APP = /\b(Terminal|iTerm2?|Warp|Ghostty|WezTerm|Alacritty|com\.apple\.Terminal|com\.googlecode\.iterm2)\b/i;
const RUNS_SCRIPTS_APP = /\b(Script\s*Editor|Automator|Shortcuts|Installer|com\.apple\.ScriptEditor2?|com\.apple\.Automator|com\.apple\.shortcuts|com\.apple\.installer)\b/i;
/** Editors that run a folder's own tasks when they open it (VS Code's "runOn": "folderOpen" and its forks). */
const RUNS_FOLDER_TASKS_APP = /\b(Visual\s*Studio\s*Code|VSCodium|Cursor|Windsurf|com\.microsoft\.VSCode(Insiders)?|com\.vscodium|com\.todesktop\.[0-9a-z]+|com\.exafunction\.windsurf)\b/i;
const OSA_HIGH: Array<[RegExp, string]> = [
  [RUNS_COMMANDS_APP, "osascript drives a terminal app, which runs commands outside the command sandbox"],
  [RUNS_SCRIPTS_APP, "osascript drives an app that runs scripts or installs software, outside the command sandbox"],
  [/\bdo\s+shell\s+script\b|\bwith\s+administrator\s+privileges\b/i, "osascript runs a shell command outside the command sandbox"],
  [/\b(run|load|store)\s+script\b|\brun\s+document\b|\bdo\s+JavaScript\b/i, "osascript runs code it can't show"],
  [/\bkeystroke\b|\bkey\s+code\b/i, "osascript types into whatever app is in front, which may be a terminal"],
  [/«|»/, "osascript sends a raw Apple event"],
  [/\blogin\s+items?\b|\bSMAppService\b|\bLaunch(Agents|Daemons)\b|\blaunchctl\b|\bcrontab\b/i, "osascript adds a login item or a startup job"],
  [/\b(ASCII\s+character|character\s+id|text\s+item\s+delimiters|system\s+attribute|do\s+script)\b/i, "osascript builds text or runs a line the check can't read ahead of time"],
  [/\bpath\s+to\s+(application\s+support|library|preferences|keychain|launch|startup|scripting|system|shared|frontmost|me\b)/i, "osascript points into a protected folder"],
  [/local-policy/i, "osascript names the app's own permission files"],
];
/** Files whose opening runs code, installs something or points at something that does. */
const OPEN_RISKY_EXT = /\.(code-workspace|command|sh|bash|zsh|csh|tcsh|ksh|fish|py|rb|pl|tool|terminal|workflow|scpt|scptd|applescript|action|fileloc|inetloc|webloc|url|pkg|mpkg|mobileconfig|prefpane|saver|qlgenerator|mdimporter|kext|plugin|bundle|service|definition|shortcut|jar)\/?$/i;
const APP_DIRS = ["/applications/", "/system/applications/", "/system/library/coreservices/applications/"];
const OPEN_FLAGS_OK = /^--(new|hide|background|fresh|reveal|wait-apps|edit|text|header|url|default-text-editor|pointer)$/;

const foldP = (p: string): string => p.normalize("NFC").toLowerCase().replace(/\/+$/, "");
const underP = (p: string, dir: string): boolean => { const f = foldP(p); const d = foldP(dir); return d !== "" && (f === d || f.startsWith(`${d}/`)); };
const realForm = (abs: string, ctx: MacHandoffContext): string => {
  if (!ctx.realpath) return abs;
  const real = realOfDeepest(abs, ctx.realpath); // bug 433: linear on a deep hostile path
  return real === null ? abs : real.replace(/\/+/g, "/");
};

/** Why a path is a high-risk target for an opened file or an AppleScript string, or null. */
function targetRisk(abs0: string, ctx: MacHandoffContext): string | null {
  const home = ctx.home.replace(/\/+$/, "");
  for (const abs of new Set([abs0, realForm(abs0, ctx)])) {
    if (appDataWalls(ctx.userData).some((u) => underP(abs, u) || underP(abs, realForm(u, ctx)))) return "it reaches into the app's own data";
    if (/local-policy/i.test(abs)) return "it names the app's own permission files";
    if (inLaunchDir(abs, home)) return "it reaches a launch item that macOS runs outside the command sandbox";
    if (isStartupFile(abs, home) || isToolConfig(abs, home)) return "it reaches a file a program outside the command sandbox runs or reads";
    if (underP(abs, `${home}/Library/Keychains`) || underP(abs, "/Library/Keychains")) return "it reaches the keychain";
    if (!ctx.noLimits) {
      if (underP(abs, `${home}/.ssh`)) return "it reaches SSH keys";
      if ((ctx.isStore ?? ((p: string) => macPrivateStorePath(p, home)))(abs)) return "it reaches a private store (saved logins, cookies, mail or messages)";
      if (/\/library\/(mail|messages|safari|cookies)(\/|$)/i.test(abs) || /\/library\/containers\/com\.apple\.(safari|mail|imessage|mobilesms|ichat)(\/|$)/i.test(abs)) return "it reaches a private store (saved logins, cookies, mail or messages)";
    }
  }
  return null;
}

/** The `-e` code of a plain osascript, or null when any of it can't be read ahead of time. */
function osaCode(c: ShCmd): string | null {
  const w = c.argv.slice(1);
  if (c.programFromInput || c.stdin !== null || c.argsUnknown || w.length === 0 || w.length % 2 !== 0) return null;
  const code: string[] = [];
  for (let i = 0; i < w.length; i += 2) {
    if (w[i]!.text !== "-e" || w[i]!.dynamic || w[i + 1]!.dynamic || w[i + 1]!.procSubst !== null) return null;
    code.push(w[i + 1]!.text);
  }
  return code.join("\n");
}

/**
 * Fix round (review of bug 258): osascript quiet runs are an ALLOW-LIST, not a deny-list. Only a small, fully parsed
 * set may run with no card in Full auto; everything else (Finder/System Events file or UI actions, click, set value,
 * keystrokes, Mail/Messages/Notes/Contacts/Calendar scripting, any browser execute-javascript, object references to
 * files, `tell application "/path/…app"`, and anything the parser can't read) asks. Returns null when the WHOLE
 * script is on the allow-list, or a reason otherwise.
 */
const SE_WRITE = /\b(set|click|keystroke|key\s*code|key\s+down|key\s+up|make|delete|perform|do\s+shell|do\s+script|launch|quit|open|activate|press|select|check|value|attribute|POSIX\s+file|alias|«|»)\b/i;
const SE_READ = /\b(name|title|bundle\s+identifier|frontmost|visible|count|processes?|position)\b/i;
const MUSIC_ACT = /^(play|pause|playpause|play\s*pause|next\s+track|previous\s+track|stop)$/i;
function osaLineAllowed(line: string, ctx: MacHandoffContext): boolean {
  const s = line.trim().replace(/\s+/g, " ");
  if (!s) return true;
  if (namesSynapseApp(s)) return false;
  if (/^display (notification|dialog|alert)\b/i.test(s)) return !/«|»|\bdo\s+shell\b|\brun\s+script\b/i.test(s);
  if (/^beep(\s+\d+)?$/i.test(s)) return true;
  if (/^say\s+"(?:[^"\\]|\\.)*"/i.test(s)) return !/\bdo\s+shell\b/i.test(s);
  const m = /^tell application(?: id)? "([^"]+)" to (.+)$/i.exec(s);
  if (!m) return false; // only the one-liner `tell app … to …` form (no multi-line tell blocks)
  const app = m[1]!.trim();
  const act = m[2]!.trim();
  if (namesSynapseApp(app) || app.includes("/")) return false; // never a bundle path, never Synapse
  if (/^(activate|quit|launch)$/i.test(act)) return allowedAppName(app, ctx);
  // Re-check fix: the same plain-URL rule as the web-page bridge — no query string or fragment.
  if (/^open location "https?:\/\/[^"?#]+"$/i.test(act)) return allowedAppName(app, ctx);
  if (/^(Music|Spotify)$/i.test(app)) return MUSIC_ACT.test(act);
  if (/^System Events$/i.test(app)) return !SE_WRITE.test(act) && SE_READ.test(act);
  return false;
}
function osaRisk(c: ShCmd, ctx: MacHandoffContext): string | null {
  const code = osaCode(c);
  if (code === null) return "osascript runs a script file, another language or code it reads elsewhere, which the check can't see";
  if (namesSynapseApp(code)) return "osascript targets Synapse's own app, which is never allowed";
  for (const line of code.split("\n")) {
    if (!osaLineAllowed(line, ctx)) return "osascript runs an action that isn't on the small safe list (only notifications, dialogs, beep, say, app activate/quit/open-URL, read-only System Events queries and Music/Spotify play controls run without asking)";
  }
  return null;
}

function openRisk(c: ShCmd, ctx: MacHandoffContext): string | null {
  const words = c.argv.slice(1);
  if (c.argsUnknown || words.some((w) => w.dynamic || w.glob || w.procSubst !== null)) return "it opens something that can't be known ahead of time, outside the command sandbox";
  // Arguments passed to the app (`--args --load-extension=…`, `--user-data-dir=…`) steer it where the check can't see.
  if (words.some((w) => w.text === "--args")) return "it passes arguments to an app, which runs outside the command sandbox";
  const own = words;
  const targets: ShWord[] = [];
  for (let i = 0; i < own.length; i++) {
    const t = own[i]!.text;
    if (/^--(env|stdin|stdout|stderr)(=|$)/.test(t)) return "it points an app's input or output at a file";
    if (/^--/.test(t)) { if (!OPEN_FLAGS_OK.test(t)) return "it opens with an option the check doesn't know"; continue; }
    if (/^-[A-Za-z]+$/.test(t)) {
      const takesApp = /[ab]/.test(t);
      const takesUrl = t.includes("u");
      const takesHeader = t.includes("h");
      if ([takesApp, takesUrl, takesHeader].filter(Boolean).length > 1) return "it opens with options the check can't read";
      if (takesApp) {
        const app = own[++i]?.text ?? "";
        if (!app) return "it opens a chosen app, which runs outside the command sandbox";
        if (namesSynapseApp(app)) return "it opens Synapse's own app, which a Bot may never drive";
        if (RUNS_COMMANDS_APP.test(app) || RUNS_SCRIPTS_APP.test(app)) return "it opens a terminal or an app that runs scripts, outside the command sandbox";
        if (RUNS_FOLDER_TASKS_APP.test(app)) return "it opens an editor that can run the folder's own tasks, outside the command sandbox";
        // Fix round: the app the Bot chose must be one it can't have written (allowedApp: /System/Applications, or
        // /Applications root-owned or Apple/Developer-ID signed). Anything the Bot could have planted (~/Applications,
        // a user-writable bundle) asks.
        if (!allowedAppName(app, ctx)) return "it opens an app the check can't confirm was installed before the Bot ran";
      } else if (takesUrl) {
        const u = own[++i];
        if (u) targets.push(u);
      } else if (takesHeader) i++;
      continue;
    }
    targets.push(own[i]!);
  }
  for (const w of targets) {
    const txt = w.text;
    // Fix round: a plain web URL stays quiet; one with a query string asks (it can carry data outward).
    if (HTTP_URL.test(txt) || /^mailto:/i.test(txt)) { if (/[?]/.test(txt)) return "it opens a web URL with a query string, which can carry data outward"; continue; }
    let abs: string | null = null;
    if (/^file:\/\//i.test(txt)) {
      try { abs = decodeURIComponent(txt.replace(/^file:\/\/(localhost)?/i, "")); } catch { return "it opens a file URL the check can't read"; }
      if (!abs.startsWith("/")) return "it opens a file URL the check can't read";
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(txt)) return "it opens a link another app handles, which runs outside the command sandbox";
    else abs = shPath(w, c.cwd, ctx.home);
    if (!abs) return "it opens a path the check can't resolve";
    const why = targetRisk(abs, ctx);
    if (why) return why;
    const real = realForm(abs, ctx);
    for (const p of new Set([abs, real])) {
      if (namesSynapseApp(p.slice(p.lastIndexOf("/") + 1))) return "it opens Synapse's own app, which a Bot may never drive";
      if (RUNS_COMMANDS_APP.test(p.slice(p.lastIndexOf("/") + 1)) || RUNS_SCRIPTS_APP.test(p.slice(p.lastIndexOf("/") + 1))) return "it opens a terminal or an app that runs scripts, outside the command sandbox";
      if (OPEN_RISKY_EXT.test(p)) return "it opens a script, a workflow or an installer, which runs outside the command sandbox";
      // Fix round: opening a .app directly must pass the allowed-app check too, not just an Applications-folder prefix.
      if (/\.app\/?$/i.test(p) && !allowedAppName(abs, ctx)) return "it opens an app the check can't confirm was installed before the Bot ran";
    }
    if (/\.app\/?$/i.test(real)) continue; // an allowed app bundle (checked above)
    // Re-check fix: a file opens in its DEFAULT handler, which could be any app (a planted one included). Resolving
    // that handler needs LaunchServices, so instead only a common document type opens quietly (its handler is a
    // viewer or editor); a folder opens in Finder. Every other file asks.
    const isDir = ctx.isDir ? ctx.isDir(real) : isDirLike(abs, ctx);
    if (isDir) continue;
    const base = real.slice(real.lastIndexOf("/") + 1);
    if (!DOC_EXT.test(base)) return "it opens a file whose default app the check can't confirm";
    if (ctx.isExecFile?.(real)) return "it opens a program file, which runs in Terminal outside the command sandbox";
  }
  return null;
}
/** Common document types whose default handler is a viewer/editor (Preview, a browser, TextEdit, Office/iWork…). */
const DOC_EXT = /\.(pdf|txt|md|markdown|rtf|html?|png|jpe?g|gif|heic|webp|svg|tiff?|bmp|csv|tsv|json|xml|ya?ml|log|docx?|xlsx?|pptx?|pages|numbers|key|odt|ods|mp3|m4a|wav|aiff?|mp4|mov|m4v)$/i;
/** Without a disk check (shared tests): `.`/`..`-free home-relative folders and names with no extension count as folders. */
function isDirLike(abs: string, ctx: MacHandoffContext): boolean {
  const base = abs.slice(abs.lastIndexOf("/") + 1);
  return abs === ctx.home || abs === ctx.cwd || /^\.[^.]+$/.test(base) || (!/\.[A-Za-z0-9]+$/.test(base) && !ctx.isExecFile?.(abs));
}

/**
 * Bug 258: why a hand-off in this command still asks in Full auto (high risk, or not readable ahead of time), or null
 * when every hand-off in it is an everyday one (or there is none).
 */
export function macHandoffHighRisk(command: string, ctx: MacHandoffContext): string | null {
  const p = parseShell(command, { cwd: ctx.cwd ?? ctx.home, home: ctx.home });
  if (p.opaque.length > 0) return "it can't be read ahead of time";
  for (const c of p.cmds) {
    const hit = handoffOne(c, ctx.home);
    if (!hit) continue;
    const why = c.program === "osascript" ? osaRisk(c, ctx) : c.program === "open" ? openRisk(c, ctx) : hit;
    if (why) return why;
  }
  for (const [re, why] of RAW_HANDOFFS) if (re.test(command)) return why;
  if (/osascript/.test(command) && TERMINALS.test(command)) return "it may drive a terminal, outside the command sandbox";
  return null;
}

/**
 * Bug 258: the everyday hand-off this command is, when the WHOLE command is one simple `osascript -e …` or `open …`
 * (optionally after `cd <dir> &&`) with no high-risk part; null otherwise. Only such a command runs with no card in
 * Full auto (a chain around one keeps its card, so nothing else runs outside the full sandbox beside it).
 */
export function macQuietHandoff(command: string, ctx: MacHandoffContext): "osascript" | "open" | null {
  const c = singleSimple(command);
  if (!c || (c.program !== "osascript" && c.program !== "open")) return null;
  if (c.argv[0]!.text !== c.program && c.argv[0]!.text !== `/usr/bin/${c.program}`) return null;
  if (!macUnsandboxedHandoff(command, ctx) || macHandoffHighRisk(command, ctx)) return null;
  return c.program;
}

/**
 * Fix round (review of bug 258): a command that drives Synapse's own app through AppleScript/System Events — so a Bot
 * could click its own approval cards or the No limits confirm. A hard NEVER in every mode, No limits included. Any
 * osascript whose code names Synapse (the app, a process, or the bundle id) counts; over-refusing here is the safe side.
 */
export function macDrivesSynapseUi(command: string): boolean {
  if (!/(^|[\s;&|(`$'"/])osascript([\s;&|)`'"]|$)/.test(command)) return false;
  const p = parseShell(command, { cwd: null, home: "/" });
  if (p.opaque.length > 0) return namesSynapseApp(command);
  return p.cmds.some((c) => c.program === "osascript" && namesSynapseApp([...c.argv.map((w) => w.literal), ...c.inlineCode].join("\n")));
}

/** Why this command hands code to something that runs outside the command sandbox (always a card), or null. */
export function macUnsandboxedHandoff(command: string, ctx: { home: string; cwd?: string | null }): string | null {
  const p = parseShell(command, { cwd: ctx.cwd ?? ctx.home, home: ctx.home });
  for (const c of p.cmds) {
    const hit = handoffOne(c, ctx.home);
    if (hit) return hit;
  }
  // Bug 232: the raw text is scanned on EVERY command, not only unreadable ones, so a hand-off spelled inside an
  // interpreter's string (python -c, node -e, ruby -e, perl -e …) is caught too. Over-asking here is the safe side.
  for (const [re, why] of RAW_HANDOFFS) if (re.test(command)) return why;
  if (/osascript/.test(command) && TERMINALS.test(command) && TERMINAL_RUN.test(command)) return "it may tell the terminal to run a command, outside the command sandbox";
  return null;
}
