/**
 * FULL AUTO — one policy, one module (full-auto-quiet).
 *
 * The user's words: "If I give the bot full auto, it should not give me approval cards for anything except
 * deletion, sending, spending money or things like that."
 *
 * So in Full auto a Bot raises a card for exactly five things and nothing else:
 *   1. destruction  deleting or overwriting the user's data outside the Bot's own workspace or scratch,
 *                   rm -rf on a user path, emptying the Trash, dropping a database, git push --force,
 *                   resetting or discarding uncommitted work, deleting Bots/chats/memories/backups, wiping a disk
 *   2. send         anything a person receives or the public sees: email, iMessage/SMS, chat or social posts,
 *                   comments, calendar invites to other people, third-party webhooks, publishing or sharing a
 *                   document, making a repo public
 *   3. money        purchases, payment forms, card entry, subscriptions, checkout/billing pages (budget asks
 *                   are raised elsewhere and are unchanged)
 *   4. security     sudo/admin, credentials, SSH keys, permissions, firewall, turning off a protection,
 *                   system-level installs, giving another Bot or person access
 *   5. user-rule    the user's OWN written always-ask rules. Their rules always win. This module never returns
 *                   it — the reviewer layer owns natural-language rules — but the category exists so the log,
 *                   the card and the settings copy can name it.
 *
 * Bug 410: a SEND on the user's connected accounts (Google, Composio, MCP) that the owner directly asked for in
 * their own latest message runs with no card; the host decides that after this module (host/review/full-auto-intent.ts).
 *
 * Everything else runs silently: reading, writing and editing files in a workspace, running commands and tests,
 * installing packages in a project, browsing and reading the web, filling non-payment forms, searching mail or
 * files, scheduling its own work.
 *
 * NOT decided here and deliberately unchanged: the fixed NEVER wall (perm-rules.ts) is a hard BLOCK, not a card;
 * Ask and Auto-accept-edits keep today's behaviour; Auto Review keeps running and can still refuse a bad command.
 *
 * Pure string code (no node imports): the tool guard (host/approvals), the Mac coordinator
 * (app/src/coordinator/local-exec/policy.ts) and the Browser classifier (app/src/main/browser) all call this one
 * function, so the three cannot drift apart.
 */
import { MAC_COMMAND_MAX, inOrder, realOfDeepest } from "./linear-text";
import { blankDoubleQuoted, messagesSend } from "./mac-messages";
import { parseShell, shPath, type ShCmd, type ShRedirect, type ShWord } from "./shell-parse";

export type FullAutoCategory = "destruction" | "send" | "money" | "security" | "user-rule";

/** The five, in the order the settings line and the logs name them. */
export const FULL_AUTO_CATEGORIES: readonly FullAutoCategory[] = ["destruction", "send", "money", "security", "user-rule"];

/** One short factual line for the Full auto option in settings. No marketing copy. */
export const FULL_AUTO_SETTINGS_LINE =
  "Your rules decide what still asks. With Balanced, the default: deleting, spending money, security or access changes, and sending anything you didn't ask for.";

/**
 * Bug 258: the token the app's own No limits confirm sends. The Mac's coordinator (and the host) refuse to turn No
 * limits on without it, so no other path — a host claim, the adoption card, the restore prompt — can set it.
 */
export const NO_LIMITS_CONFIRM = "no-limits:user-confirmed-risk";

export interface FullAutoResult {
  ask: boolean;
  category: FullAutoCategory | null;
  /** A stable id, "<category>.<what>", for the card's why, the activity log and the tests. */
  rule: string;
  /** One plain line for the card. */
  reason: string;
}

export type FullAutoAction =
  | { kind: "command"; side: "mac" | "box"; command: string; cwd?: string | null }
  /** Bug 256: "read" is a Mac read tool (read, list, glob, grep, copy-to-box); it asks only for a credential store. */
  | { kind: "file"; side: "mac" | "box"; op: "write" | "edit" | "delete" | "read"; path: string; cwd?: string | null }
  /** A control-plane / connector call, named by the host classifier's target action. */
  | { kind: "tool"; action: string; args?: Record<string, unknown>; mcp?: McpToolMeta }
  /** One browser action, judged against the live page by the Mac's Browser classifier. */
  | { kind: "browser"; action: string; url?: string; label?: string | null; field?: "password" | "card" | null; submit?: boolean };

export interface FullAutoContext {
  /** The Mac user's home. */
  home: string;
  /** Roots the Bot owns: its box workspace, its scratch dirs, and the Mac's auto-run (project) roots. */
  workspaces: readonly string[];
  /** A path's on-disk form. The Mac passes fs.realpathSync.native; the host may omit it. */
  realpath?(p: string): string;
  /** Whether a path exists, so OVERWRITING the user's data is told apart from creating a new file. */
  exists?(p: string): boolean;
  /** Known shell variables ($HOME, $PWD, …). */
  vars?: Record<string, string>;
  /**
   * Bug 258: the Bot is in No limits (per Bot, opt-in, confirmed in the app). Sending outward and reading private
   * files (saved logins, cookies, mail, messages, SSH and GitHub credentials) no longer ask; destruction, money and
   * the other security asks still do.
   */
  noLimits?: boolean;
}

const OK: FullAutoResult = { ask: false, category: null, rule: "full-auto.quiet", reason: "" };
const R = (category: FullAutoCategory, rule: string, reason: string): FullAutoResult => ({ ask: true, category, rule: `${category}.${rule}`, reason });

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------
function fold(p: string): string {
  return p.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}
function lexical(p: string, base: string): string {
  const abs = p.startsWith("/") ? p : `${base.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
const within = (p: string, dir: string): boolean => dir !== "/" && (p === dir || p.startsWith(`${dir}/`));
/** Bug 433: the folded home, worked out once per home instead of once per path checked (a command with thousands of
 *  arguments folded it thousands of times). */
let lastHome: { home: string; h: string } | null = null;
function foldedHome(home: string): string {
  if (lastHome?.home !== home) lastHome = { home, h: fold(lexical(home, "/")) };
  return lastHome.h;
}

function realOf(abs: string, realpath?: (p: string) => string): string {
  if (!realpath) return abs;
  const real = realOfDeepest(abs, realpath); // bug 433: linear on a deep hostile path
  return real === null ? abs : lexical(real, "/");
}

/**
 * True when the path is inside a root the Bot owns (its workspace, its scratch, a Mac project dir). Bug 441: judged by
 * where the path REALLY is (symlinks in the file and in every parent folder resolved), so a link inside the workspace
 * to a file outside it is outside. A root is matched as written and as resolved (/tmp is /private/tmp on a Mac).
 */
function inWorkspace(abs: string, ctx: FullAutoContext): boolean {
  const lex = ctx.workspaces.filter((d) => typeof d === "string" && d.startsWith("/")).map((d) => lexical(d, "/"));
  const roots = new Set([...lex, ...(ctx.realpath ? lex.map((d) => realOf(d, ctx.realpath)) : [])].map(fold));
  const real = fold(realOf(abs, ctx.realpath));
  return [...roots].some((r) => within(real, r));
}

const expandHome = (p: string, home: string) => p.replace(/^~(?=$|\/)/, home);

/** The absolute path a word names, or null when the text can't prove it. */
function wordPath(w: ShWord, c: ShCmd, ctx: FullAutoContext): string | null {
  if (w.dynamic || w.glob) return null;
  return shPath(w, c.cwd, ctx.home);
}
/** The fixed prefix of an unprovable word (`~/*` → `~/`), so a glob under home is still seen as under home. */
function wordPrefix(w: ShWord, c: ShCmd, ctx: FullAutoContext): string | null {
  const lit = w.literal.split(/[*?[\]{}$`]/)[0] ?? "";
  const cut = lit.slice(0, lit.lastIndexOf("/") + 1);
  if (!cut) return null;
  return lexical(expandHome(cut, ctx.home), c.cwd ?? ctx.home);
}

// ---------------------------------------------------------------------------------------------------------------
// 4. SECURITY AND ACCESS
// ---------------------------------------------------------------------------------------------------------------
const SUDO = /^(sudo|doas|sudoedit|run0|pkexec|su)$/;
const SHELL_RC = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".inputrc", ".bash_logout"];
/** Folders whose contents are keys, credentials, startup items or the app's own security settings. */
const SHELL_RC_FOLDED: ReadonlySet<string> = new Set(SHELL_RC.map((n) => n.toLowerCase()));
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".config/gh", ".docker", ".kube", ".password-store", "library/keychains", "library/launchagents", "library/launchdaemons"];
const SECRET_ABS = ["/library/keychains", "/library/launchagents", "/library/launchdaemons", "/etc", "/system/library/keychains", "/private/etc"];
const SECRET_FILE = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519|xmss)|[^/]*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ppk|jks)|\.netrc|credentials|secring\.gpg)$/i;
/** The app's own security controls, and the git hooks that make git run a program. */
const APP_SECURITY_PATH = /\.claude\/(settings|hooks)|(^|\/)\.git\/hooks(\/|$)|autoReview|\/home\/box\/\.host/;
/**
 * Git's own config files. `git config --global user.email …` asked for approval in the transcripts (it is an F8
 * git-control write to the reviewer); under this policy it is ordinary tooling setup, not the user's data and not
 * a security control — git HOOKS, which make git run a program, stay in APP_SECURITY_PATH above.
 */
const TOOL_CONFIG_PATH = /(^|\/)\.gitconfig$|(^|\/)\.git\/config(\.worktree)?$|(^|\/)\.git(attributes|modules)$|(^|\/)\.config\/git\/(config|attributes)$/;
/** Programs that change the machine's security posture, credentials or startup. */
const SECURITY_PROGRAMS = /^(ssh-keygen|ssh-copy-id|ssh-add|security|csrutil|spctl|socketfilterfw|pfctl|networksetup|systemsetup|scutil|nvram|pmset|launchctl|crontab|installer|softwareupdate|dscl|visudo|chflags|codesign|xattr|firewall-cmd|ufw|iptables|authopen|diskutil_unused)$/;
const SSH_CLIENTS = /^(ssh|scp|sftp|rsync|mosh|autossh|git)$/;
const READERS = /^(cat|bat|less|more|head|tail|nl|od|xxd|hexdump|strings|cp|scp|rsync|ditto|tar|base64|openssl|pbcopy|dd|gpg2?|plutil|defaults|sqlite3|gzip|zip|shasum|md5)$/;
/** Package managers whose "install" is system-wide rather than inside the project. */
const SYSTEM_INSTALLERS = /^(brew|port|mas|apt|apt-get|yum|dnf|pacman|snap|choco|gem)$/;
/** Logging in to, or reconfiguring, a service's stored credentials. */
const CREDENTIAL_CLI: Record<string, RegExp> = { gh: /^auth$/, aws: /^configure$/, docker: /^login$/, gcloud: /^auth$/, az: /^login$/, heroku: /^login$/, npm: /^(login|adduser|token)$/, vercel: /^login$/, kubectl: /^config$/ };

function isSecurityPath(abs: string, ctx: FullAutoContext): boolean {
  const f = fold(abs);
  const h = foldedHome(ctx.home);
  const tail = f.startsWith(`${h}/`) ? f.slice(h.length + 1) : "";
  if (tail && SHELL_RC_FOLDED.has(tail)) return true;
  if (SECRET_DIRS.some((d) => within(f, `${h}/${d}`))) return true;
  if (SECRET_ABS.some((d) => within(f, d))) return true;
  if (SECRET_FILE.test(f)) return true;
  return APP_SECURITY_PATH.test(abs);
}
const securityPathHit = (abs: string, ctx: FullAutoContext): boolean => {
  if (isSecurityPath(abs, ctx)) return true;
  const real = realOf(abs, ctx.realpath);
  return real !== abs && isSecurityPath(real, ctx); // bug 433: the same path isn't checked twice
};

/**
 * Bug 256 (review): places whose CONTENTS are the user's logins, cookies, mail or messages. Reading one is the
 * SECURITY category in Full auto (the old Mac floor F7 carded it; the classifier must now name it itself). The
 * folders around them (a browser profile's Bookmarks, an app's data under ~/Library/Application Support) are not.
 */
const CREDENTIAL_DIRS = ["library/safari", "library/cookies", "library/mail", "library/messages", "library/containers/com.apple.safari", "library/containers/com.apple.mail", "library/containers/com.apple.imessage"];
/** Where the browsers keep their profiles: a recursive copy/archive of one of these (or a parent) takes the stores too. */
const BROWSER_ROOTS = ["library/application support/google", "library/application support/chromium", "library/application support/microsoft edge", "library/application support/bravesoftware", "library/application support/arc", "library/application support/vivaldi", "library/application support/com.operasoftware.opera", "library/application support/firefox", "library/application support/librewolf", "library/application support/zen", "library/application support/waterfox"];
/** Firefox-family stores, wherever the profile lives. */
const FIREFOX_STORE = /^(logins\.json|logins-backup\.json|key[34]\.db|cookies\.sqlite(-wal|-shm)?|signons\.sqlite|cert9\.db)$/;
/** Chromium-family stores (Chrome, Edge, Brave, Arc, Vivaldi, Opera …), under ~/Library/Application Support. */
const CHROMIUM_STORE = /^(cookies|login data|login data for account|web data|safe browsing cookies|extension cookies)(-journal|-wal)?$/;
/** A dotenv file (not its checked-in template). */
const DOTENV = /^\.env(\.[^/]+)?$/;
const DOTENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;

function credentialStore(abs: string, ctx: FullAutoContext, recursive = false): boolean {
  const check = (p: string): boolean => {
    const f = fold(p);
    const h = foldedHome(ctx.home);
    const name = f.slice(f.lastIndexOf("/") + 1);
    if (CREDENTIAL_DIRS.some((d) => within(f, `${h}/${d}`))) return true;
    if (FIREFOX_STORE.test(name)) return true;
    if (CHROMIUM_STORE.test(name) && within(f, `${h}/library/application support`)) return true;
    if (DOTENV.test(name) && !DOTENV_TEMPLATE.test(name) && !inWorkspace(p, ctx)) return true;
    // A recursive copy or archive of a folder that CONTAINS a store takes it along.
    if (recursive && f !== "/" && [...CREDENTIAL_DIRS, ...BROWSER_ROOTS, ".ssh", ".gnupg", ".aws", "library/keychains"].some((d) => within(`${h}/${d}`, f))) return true;
    return false;
  };
  if (check(abs)) return true;
  const real = realOf(abs, ctx.realpath);
  return real !== abs && check(real); // bug 433: the same path isn't checked twice
}
/** Bug 256 (review): the Mac's grep/glob walk skips these (a search of ~ must not read a browser's saved logins). */
export function macCredentialStore(abs: string, home: string): boolean {
  return credentialStore(abs, { home, workspaces: [] });
}
/** Programs that copy or pack a whole folder (for cp only with -r/-R/-a). */
const RECURSIVE_COPIERS = /^(rsync|ditto|tar|gtar|bsdtar|zip|7z|7za|scp)$/;
const recursiveCopy = (c: ShCmd): boolean => RECURSIVE_COPIERS.test(c.program) || (c.program === "cp" && hasFlag(c, /^-[a-zA-Z]*[rRa]/)) || (/^(grep|egrep|rg|ag)$/.test(c.program) && (c.program !== "grep" && c.program !== "egrep" || hasFlag(c, /^(-[a-zA-Z]*[rR]|--recursive)/)));

/** The first non-flag argument (a subcommand). */
function sub(c: ShCmd, from = 1): string {
  return c.argv.slice(from).find((w) => !w.text.startsWith("-"))?.text ?? "";
}
const hasFlag = (c: ShCmd, re: RegExp): boolean => c.argv.slice(1).some((w) => w.text.startsWith("-") && re.test(w.text));
const allText = (c: ShCmd): string => [...c.argv.map((w) => w.text), ...c.inlineCode].join(" ");

function securityForCommand(c: ShCmd, ctx: FullAutoContext): FullAutoResult | null {
  const prog = c.program;
  if (SUDO.test(prog) || c.wrappers.some((w) => SUDO.test(w))) return R("security", "sudo", "This runs with administrator (sudo) privileges.");
  if (c.programFromInput && (c.stdin === "pipe" || c.stdin === "procsubst")) {
    return R("security", "pipe-to-shell", "This pipes downloaded content straight into a shell.");
  }
  if (SECURITY_PROGRAMS.test(prog)) return R("security", "system-control", `“${prog}” changes credentials, permissions, startup items or a system protection.`);
  if (prog === "diskutil" && /^(enableJournal|disableJournal|enableOwnership|disableOwnership)$/.test(sub(c))) return R("security", "system-control", "This changes a disk's settings.");
  if (SYSTEM_INSTALLERS.test(prog) && /^(install|upgrade|reinstall|cask|tap)$/.test(sub(c))) {
    return R("security", "system-install", `“${prog} ${sub(c)}” installs software for the whole machine, not just this project.`);
  }
  if (/^(npm|pnpm|yarn|bun|pip|pip3|gem|cargo|go)$/.test(prog) && /^(install|i|add|global)$/.test(sub(c)) && hasFlag(c, /^(-g|--global|--location=global)$/)) {
    return R("security", "system-install", "This installs a package globally, outside the project.");
  }
  const cred = CREDENTIAL_CLI[prog];
  if (cred && cred.test(sub(c))) return R("security", "credentials", `“${prog} ${sub(c)}” changes stored credentials.`);
  if (/^(chmod|chown|chgrp)$/.test(prog)) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = wordPath(w, c, ctx) ?? wordPrefix(w, c, ctx);
      if (!abs) continue;
      if (!inWorkspace(abs, ctx)) return R("security", "permissions", "This changes file permissions or ownership outside your project folders.");
    }
  }
  // Bug 258: in No limits a READ of keys or credentials runs, but a copy that WRITES into a protected place still asks.
  if (ctx.noLimits) {
    const dests = [...(OVERWRITERS.test(prog) || /^(sed|perl)$/.test(prog) ? overwriteTargets(c) : []), ...c.redirects.filter(writeRedirect).map((r) => r.target).filter((t): t is ShWord => !!t)];
    for (const w of dests) {
      const abs = wordPath(w, c, ctx) ?? wordPrefix(w, c, ctx);
      if (abs && securityPathHit(abs, ctx)) return R("security", "protected-place", "This touches keys, credentials, startup items or a security setting.");
    }
  }
  // Any word that names a key store, a credential file, a shell startup file or a security control.
  for (const w of [...c.argv.slice(1), ...c.redirects.map((r) => r.target).filter((t): t is ShWord => !!t)]) {
    if (w.text.startsWith("-")) continue;
    const abs = wordPath(w, c, ctx) ?? wordPrefix(w, c, ctx);
    // Bug 258: No limits lets ssh and its copiers use the user's SSH keys and config.
    if (ctx.noLimits && abs && SSH_CLIENTS.test(prog) && within(fold(abs), `${foldedHome(ctx.home)}/.ssh`)) continue;
    if (abs && securityPathHit(abs, ctx)) {
      return READERS.test(prog)
        ? R("security", "read-credentials", "This reads keys or credentials.")
        : R("security", "protected-place", "This touches keys, credentials, startup items or a security setting.");
    }
    // Bug 256 (review): a browser's saved logins or cookies, Mail, Messages, a .env — any program that names one.
    if (abs && credentialStore(abs, ctx, recursiveCopy(c))) return R("security", "read-credentials", "This reads saved logins, cookies, mail, messages or secrets.");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. DESTRUCTION of the user's data
// ---------------------------------------------------------------------------------------------------------------
const DELETERS = /^(rm|rmdir|unlink|shred|srm|trash|rip)$/;
/** Programs that replace a file's contents at a destination. */
const OVERWRITERS = /^(cp|mv|ditto|rsync|install|tee|dd|truncate|patch|gunzip|unzip)$/;
const DB_CLIENTS = /^(psql|mysql|mysqladmin|mariadb|sqlite3|mongo|mongosh|redis-cli|clickhouse-client|cockroach|dropdb|dropuser|prisma|sequelize)$/;
const DB_DESTROY = /\b(drop\s+(database|schema|table|index|collection|view)|truncate\s+table|flushall|flushdb|db\.dropDatabase)\b/i;
const DISK_WIPE = /^(mkfs(\..+)?|newfs(_.+)?|fdisk|parted|sgdisk|wipefs|blkdiscard|format)$/;
const TRASH_TEXT = /\bempty\s+(the\s+)?trash\b/i;
/** Device files a write to destroys nothing, whatever the script did. Anchored, so /dev/nullb0 is a disk. */
const SAFE_DEV = /^\/dev\/(null|zero|tty)$/;
/**
 * The fd aliases: they reopen whatever the descriptor has open, and `>` reopens it with O_TRUNC — so
 * `cat <~/important >/dev/stdin` or `exec 3<~/important; echo x >/dev/fd/3` empties the user's file. Safe only
 * when nothing in the script points a descriptor at a file for reading (see fdAliasesSafe).
 */
const FD_ALIAS_DEV = /^\/dev\/(stdin|stdout|stderr|fd\/\d+)$/;
/** Redirect operators that can change a file's contents. `>&` counts only with a file target (`>&2` is a dup). */
const WRITE_REDIRECT = /^(>|>\||>>|&>|&>>|<>)$/;
const writeRedirect = (r: ShRedirect): boolean =>
  !!r.target && (WRITE_REDIRECT.test(r.op) || (r.op === ">&" && !/^(\d+|-)$/.test(r.target.text)));
/** A path as a device check sees it: case folded (macOS is case-insensitive) and /private/dev → /dev. */
const devForm = (abs: string): string => fold(abs).replace(/^\/private\/dev(?=\/|$)/, "/dev");

/**
 * Fail closed: the fd aliases are safe only when the whole script opens no descriptor on a file for reading
 * (`<`, `n<`, `<>`, `n<>`, `<&`) and uses no `exec` redirect, and the parser saw every command.
 */
function fdAliasesSafe(cmds: readonly ShCmd[], opaque: boolean): boolean {
  if (opaque) return false;
  return !cmds.some((c) => c.redirects.some((r) => /^(<|<>|<&)$/.test(r.op)) || ((c.program === "exec" || c.wrappers.includes("exec")) && c.redirects.length > 0));
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "production", "prod", "release", "HEAD"]);

function gitInvocation(c: ShCmd): { sub: string; args: string[] } | null {
  if (c.program !== "git" && c.program !== "hub") return null;
  const rest = c.argv.slice(1).map((w) => w.text);
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("-")) {
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(rest[i]!)) i += 2;
    else i++;
  }
  return i >= rest.length ? null : { sub: rest[i]!, args: rest.slice(i + 1) };
}

/** The destination words an overwriting program writes to. */
function overwriteTargets(c: ShCmd): ShWord[] {
  const prog = c.program;
  const args = c.argv.slice(1).filter((w) => !w.text.startsWith("-"));
  if (prog === "dd") {
    const of = c.argv.find((w) => w.text.startsWith("of="));
    return of ? [{ ...of, text: of.text.slice(3), literal: of.literal.replace(/^of=/, "") }] : [];
  }
  if (/^(cp|mv|ditto|rsync|install)$/.test(prog)) return args.length > 1 ? [args[args.length - 1]!] : [];
  if (/^(sed|perl)$/.test(prog)) return hasFlag(c, /^-i/) ? args.slice(1) : [];
  return args;
}

function destructionForCommand(c: ShCmd, ctx: FullAutoContext, fdSafe = false): FullAutoResult | null {
  const prog = c.program;
  const text = allText(c);

  if (TRASH_TEXT.test(text)) return R("destruction", "empty-trash", "This empties the Trash, which can't be undone.");
  if (DISK_WIPE.test(prog)) return R("destruction", "wipe-disk", `“${prog}” erases a disk or volume.`);
  if (prog === "diskutil" && /erase|deleteVolume|zeroDisk|secureErase|reformat/i.test(text)) return R("destruction", "wipe-disk", "This erases a disk or volume.");
  if (prog === "dropdb" || prog === "dropuser") return R("destruction", "drop-database", "This drops a database.");
  if (DB_CLIENTS.test(prog) && DB_DESTROY.test(text)) return R("destruction", "drop-database", "This drops or empties a database table.");

  const git = gitInvocation(c);
  if (git) {
    if (git.sub === "push" && git.args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
      return R("destruction", "force-push", "A force push overwrites history on the remote.");
    }
    if (git.sub === "reset" && git.args.includes("--hard")) return R("destruction", "discard-work", "A hard reset discards uncommitted work.");
    if (git.sub === "clean" && git.args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) return R("destruction", "discard-work", "git clean deletes untracked files.");
    if (git.sub === "checkout" && git.args.includes("--")) return R("destruction", "discard-work", "This throws away uncommitted changes.");
    if (git.sub === "restore" && !git.args.includes("--staged")) return R("destruction", "discard-work", "This throws away uncommitted changes.");
    if (git.sub === "stash" && /^(drop|clear|pop)$/.test(git.args[0] ?? "")) return R("destruction", "discard-work", "This drops stashed work.");
    if (/^(filter-branch|filter-repo)$/.test(git.sub)) return R("destruction", "rewrite-history", "Rewriting history can destroy commits.");
    if (git.sub === "branch" && git.args.some((a) => a === "-D") && git.args.some((a) => DEFAULT_BRANCHES.has(a))) {
      return R("destruction", "discard-work", "This force-deletes a default branch.");
    }
    return null; // every other git command, push to main included, is ordinary work
  }

  if (DELETERS.test(prog)) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = wordPath(w, c, ctx);
      if (abs) {
        if (!inWorkspace(abs, ctx)) return R("destruction", "delete-outside-workspace", "This deletes files outside the Bot's own workspace.");
        continue;
      }
      const prefix = wordPrefix(w, c, ctx);
      if (prefix ? !inWorkspace(prefix, ctx) : !(c.cwd && inWorkspace(c.cwd, ctx))) {
        return R("destruction", "delete-unproven-target", "This deletes files at a path that can't be checked ahead of time.");
      }
    }
    return null;
  }

  // Every write-capable redirect, appends included: appending to the user's file changes it just as surely.
  const redirectTargets = c.redirects.filter(writeRedirect).map((r) => r.target).filter((t): t is ShWord => !!t);
  const targets = [...(OVERWRITERS.test(prog) || /^(sed|perl)$/.test(prog) ? overwriteTargets(c) : []), ...redirectTargets];
  for (const w of targets) {
    const abs = wordPath(w, c, ctx) ?? wordPrefix(w, c, ctx);
    if (!abs) continue;
    // Bug 194: the null sink (`2>/dev/null`, `| tee /dev/null`) destroys nothing. It used to fall through to the
    // exists() check below — /dev/null exists — and card as an overwrite of the user's data. The fd aliases are
    // safe only when no descriptor in the script was pointed at a file (fdAliasesSafe); any other device is a disk.
    const dev = devForm(abs);
    if (dev === "/dev" || dev.startsWith("/dev/")) {
      if (SAFE_DEV.test(dev) || (FD_ALIAS_DEV.test(dev) && fdSafe)) continue;
      if (FD_ALIAS_DEV.test(dev)) return R("destruction", "overwrite-outside-workspace", "This writes through a descriptor that may point at one of your files.");
      return R("destruction", "wipe-disk", "This writes straight to a disk device.");
    }
    if (TOOL_CONFIG_PATH.test(abs) || inWorkspace(abs, ctx)) continue;
    if (ctx.exists && !ctx.exists(abs)) continue; // a new file destroys nothing
    return R("destruction", "overwrite-outside-workspace", "This overwrites a file outside the Bot's own workspace.");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. SENDING OUTWARD
// ---------------------------------------------------------------------------------------------------------------
const MAILERS = /^(mail|mailx|sendmail|mutt|msmtp|neomutt|swaks|postfix)$/;
const NET_SENDERS = /^(curl|wget|http|httpie|xh)$/;
const SEND_FLAGS = /^(-X|--request|-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|-T|--upload-file|--json|--post-data|--post-file|--method)$/;
const WRITE_METHODS = /^(POST|PUT|PATCH|DELETE)$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.local)$/i;
/** gh/glab subcommands that other people see. */
const FORGE_SEND: Record<string, RegExp> = { pr: /^(create|comment|review|merge|ready)$/, issue: /^(create|comment|close|reopen)$/, gist: /^create$/, release: /^(create|upload|edit)$/, repo: /^(create|edit|deploy-key)$/, api: /.*/ };
/** A connector tool whose name says somebody receives it. Matched on snake_case AND camelCase. */
const SEND_TOOL = /(^|_)(send|post|publish|share|tweet|toot|invite|comment|reply|forward|notify|broadcast|announce|email|dm|sms|message)(_|$)/i;

const urlsIn = (c: ShCmd): string[] => c.argv.map((w) => w.text).filter((t) => /^https?:\/\//i.test(t));
function hostOf(u: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(u);
  return (m?.[1] ?? "").replace(/^[^@]*@/, "").replace(/:\d+$/, "");
}
const thirdParty = (u: string) => !!u && !LOCAL_HOST.test(hostOf(u));

/** Bug 256 (review): raw sockets and remote copies. Any use of them sends to (or opens a channel with) another machine. */
const SOCKET_TOOLS = /^(nc|ncat|netcat|socat|telnet|sftp|ftp|lftp|tftp|smbclient)$/;
/** A remote rsync/scp operand: host:path, user@host:path, rsync://… (a local path with a colon has a / before it). */
const REMOTE_OPERAND = /^(rsync:\/\/|[^/\s:]+:)/;
/** Interpreters whose one-liner can open a connection, and the words that do it. */
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|osascript|lua|Rscript)$/;
const NET_CODE = /\b(socket|requests|urllib[0-9]*|http\.client|httpx|aiohttp|urlopen|ftplib|smtplib|telnetlib|paramiko|fetch|XMLHttpRequest|WebSocket|require\(\s*["'`](node:)?(https?|net|tls|dgram|http2)["'`]\s*\)|from\s+["'`](node:)?(https?|net|tls|dgram)["'`]|Net::|open-uri|TCPSocket|IO::Socket|LWP|HTTP::Tiny|curl_init|fsockopen|stream_socket_client|file_get_contents\(\s*["']https?:|do shell script)/;

/**
 * Bug 433: facts about the whole command text, worked out once per command (lazily) instead of once per parsed
 * command: a long command splits into many, and re-scanning all of it for each one was quadratic.
 */
interface WholeText { mailSend(): boolean; sms(): ReturnType<typeof messagesSend>; hasSubst(): boolean }
function wholeText(command: string): WholeText {
  const once = <T>(f: () => T): (() => T) => { let done = false; let v: T; return () => { if (!done) { v = f(); done = true; } return v; }; };
  return {
    mailSend: once(() => /\bapp(lication)?\s+"Mail"|Application\(\s*["']Mail["']\s*\)/i.test(command) && /\bsend\b/i.test(blankDoubleQuoted(command))),
    sms: once(() => messagesSend(command)),
    hasSubst: once(() => /\$\(|`/.test(command)),
  };
}

/**
 * Bug 439: how curl, wget and httpie/xh are told to send a body, and every host a request goes to. The option walk
 * follows the programs' own rules: a short-option cluster ends at the first letter that takes a value (`-sLo out`
 * writes `out`, `-sF f=@x` posts a form), and an option's value is skipped, so what is left are the URLs. A host
 * that can't be read (a variable) is null: not provably this machine.
 */
const CURL_SHORT_VALUE = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz".split(""));
const CURL_SHORT_SEND = new Set(["d", "F", "T"]);
const CURL_LONG_SEND = /^--(data|data-ascii|data-binary|data-raw|data-urlencode|form|form-string|upload-file|json)$/;
const CURL_LONG_VALUE = /^--(data|data-ascii|data-binary|data-raw|data-urlencode|form|form-string|upload-file|json|output|output-dir|header|proxy-header|user|proxy-user|user-agent|referer|cookie|cookie-jar|request|max-time|connect-timeout|retry|retry-delay|retry-max-time|proxy|preproxy|noproxy|cacert|capath|cert|key|cert-type|key-type|pass|config|write-out|range|limit-rate|resolve|connect-to|dump-header|url|interface|netrc-file|proto|proto-redir|oauth2-bearer|aws-sigv4|variable|max-filesize|max-redirs|ciphers|local-port|dns-servers|doh-url|speed-limit|speed-time|time-cond|trace|trace-ascii|stderr|unix-socket|abstract-unix-socket|mail-from|mail-rcpt|mail-auth|quote|socks4|socks4a|socks5|socks5-hostname|url-query|request-target|crlfile|pinnedpubkey|alt-svc|hsts|etag-save|etag-compare|rate|expect100-timeout|keepalive-time|happy-eyeballs-timeout-ms|parallel-max|create-file-mode|ftp-port|ftp-account|krb|delegation|service-name|sasl-authzid|login-options|tlsuser|tlspassword|telnet-option|hostpubmd5|hostpubsha256)$/;
const WGET_SHORT_VALUE = new Set("OoaeiBtTwPUlARDIXQ".split(""));
const WGET_LONG_SEND = /^--(post-data|post-file|body-data|body-file)$/;
const WGET_LONG_VALUE = /^--(post-data|post-file|body-data|body-file|method|output-document|output-file|append-output|header|user|password|http-user|http-password|proxy-user|proxy-password|user-agent|referer|tries|timeout|dns-timeout|connect-timeout|read-timeout|wait|waitretry|directory-prefix|level|accept|reject|accept-regex|reject-regex|domains|exclude-domains|include-directories|exclude-directories|execute|input-file|base|load-cookies|save-cookies|ca-certificate|ca-directory|certificate|certificate-type|private-key|private-key-type|bind-address|limit-rate|quota|config|restrict-file-names|local-encoding|remote-encoding|default-page|backups|secure-protocol|ciphers|max-redirect)$/;
const HTTPIE_SHORT_VALUE = new Set("aAoPp".split(""));
const HTTPIE_LONG_VALUE = /^--(auth|auth-type|output|session|session-read-only|verify|cert|cert-key|cert-key-pass|proxy|timeout|max-redirects|print|history-print|pretty|style|format-options|boundary|response-charset|response-mime|ssl|ciphers|default-scheme|max-headers)$/;
/** An httpie request item that carries data (`k=v`, `k:=json`, `k@file`, `k=@file`), not a header (`H:v`) or a query (`k==v`). */
const HTTPIE_DATA_ITEM = /^[^\s=:@]*(:=@|=@|:=|@|=(?!=))/;

function hostOfOperand(t: string, dynamic: boolean): string | null {
  if (dynamic || !t) return null;
  if (/^:\d*(\/|$)/.test(t)) return "localhost"; // httpie's :3000/path
  const rest = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = (rest.split(/[/?#]/)[0] ?? "").replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host ? host.toLowerCase() : null;
}

/** Bug 439: whether a curl/wget/httpie/xh command sends a body, and the hosts it talks to (null = can't be read). */
export function netRequest(c: ShCmd): { writes: boolean; hosts: (string | null)[] } {
  const curl = c.program === "curl";
  const wget = c.program === "wget";
  const words = c.argv.slice(1);
  const hosts: (string | null)[] = [];
  let writes = false;
  const shortValue = curl ? CURL_SHORT_VALUE : wget ? WGET_SHORT_VALUE : HTTPIE_SHORT_VALUE;
  const longValue = curl ? CURL_LONG_VALUE : wget ? WGET_LONG_VALUE : HTTPIE_LONG_VALUE;
  let positional = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (t === "--") continue;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const value = eq >= 0 ? t.slice(eq + 1) : longValue.test(name) ? (words[++i]?.text ?? "") : null;
      if (curl && CURL_LONG_SEND.test(name)) writes = true;
      if (wget && WGET_LONG_SEND.test(name)) writes = true;
      if ((name === "--request" || name === "--method") && value !== null && WRITE_METHODS.test(value)) writes = true;
      if (!curl && !wget && /^--(form|multipart|raw)$/.test(name)) writes = true;
      if (curl && name === "--url" && value !== null) hosts.push(hostOfOperand(value, false));
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k]!;
        if (curl && CURL_SHORT_SEND.has(ch)) writes = true;
        if (!shortValue.has(ch)) continue;
        const value = k + 1 < t.length ? t.slice(k + 1) : (words[++i]?.text ?? "");
        if (ch === "X" && curl && WRITE_METHODS.test(value)) writes = true;
        break;
      }
      continue;
    }
    if (!curl && !wget) {
      // httpie/xh: [METHOD] URL [items…]
      if (positional === 0 && !w.dynamic && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/i.test(t)) {
        if (WRITE_METHODS.test(t)) writes = true;
        continue;
      }
      positional++;
      if (positional === 1) hosts.push(hostOfOperand(t, w.dynamic));
      else if (w.dynamic || HTTPIE_DATA_ITEM.test(t)) writes = true;
      continue;
    }
    hosts.push(hostOfOperand(t, w.dynamic));
  }
  // httpie/xh send what arrives on standard input as the body; curl/wget only with a flag (counted above).
  if (!curl && !wget && c.stdin !== null) writes = true;
  return { writes, hosts };
}

/**
 * Bug 439: FETCH AND RUN. Code downloaded from the network and run in the same command, in any of its spellings:
 * piped into a shell (above, `security.pipe-to-shell`), run from a substitution (`bash <(curl …)`, `source <(…)`,
 * `sh -c "$(curl …)"`, `eval "$(wget -O- …)"`), or saved to a file that is then run (`curl -o i.sh … && bash i.sh`,
 * `wget …/tool && chmod +x tool && ./tool`). Downloading a file, or piping JSON to jq, is ordinary work.
 */
const FETCHERS = /^(curl|wget|http|https|xh|xhs|aria2c)$/;
const SH_RUNNERS = /^(sh|bash|zsh|dash|ksh|mksh|ash|fish|busybox|source|\.)$/;
const LANG_RUNNERS = /^(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|pwsh)$/;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The words a runner takes its program from: the script operand, or the code after -c/-e; every word of eval. */
function codeWords(c: ShCmd): ShWord[] {
  if (c.program === "eval") return c.argv.slice(1);
  if (!SH_RUNNERS.test(c.program) && !LANG_RUNNERS.test(c.program)) return [];
  const words = c.argv.slice(1);
  for (let i = 0; i < words.length; i++) {
    const t = words[i]!.text;
    if (/^-[a-zA-Z]*[ce]$/.test(t) || t === "--eval" || t === "--command") return words[i + 1] ? [words[i + 1]!] : [];
    if (t.startsWith("-") && t !== "-") continue;
    return [words[i]!];
  }
  return [];
}

/** The file names a fetcher saves to: -o/-O/--output/--output-document, wget's and -O's remote name, a `>` redirect. */
function savedNames(c: ShCmd): string[] {
  const out: string[] = [];
  const words = c.argv.slice(1).map((w) => w.text);
  const urls = words.filter((t) => /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[\w.-]+\.[a-z]{2,}\//i.test(t));
  const remote = () => urls.forEach((u) => out.push(base(u.replace(/[?#].*$/, "")) || "index.html"));
  let named = false;
  for (let i = 0; i < words.length; i++) {
    const t = words[i]!;
    const long = /^--(output|output-document)(=(.*))?$/.exec(t);
    if (long) { out.push(long[3] ?? words[++i] ?? ""); named = true; continue; }
    if (t === "--remote-name" || t === "--remote-name-all") { remote(); named = true; continue; }
    if (/^-[a-zA-Z]+/.test(t) && !t.startsWith("--")) {
      const m = /^-[a-zA-NP-Za-np-z]*([oO])(.*)$/.exec(t);
      if (!m) continue;
      if (c.program === "curl" && m[1] === "O") { remote(); named = true; continue; }
      const value = m[2] || words[++i] || "";
      if (c.program === "wget" && m[1] === "o") continue; // wget -o is its log file
      out.push(value);
      named = true;
    }
  }
  if (!named && (c.program === "wget" || c.program === "aria2c")) remote();
  for (const r of c.redirects) if (r.target && /^(>|>\||>>|&>|&>>)$/.test(r.op)) out.push(r.target.text);
  return out.map(base).filter((n) => n && n !== "-" && n !== "stdout");
}

/** Bug 440: a command that unpacks an archive or a compressed file (tar x, unzip, ditto -x, 7z x, gunzip …). */
function unpacks(c: ShCmd): boolean {
  const args = c.argv.slice(1).map((w) => w.text);
  switch (c.program) {
    case "tar": case "gtar": case "bsdtar":
      return args.some((t, i) => t === "--extract" || t === "--get" || (/^-[A-Za-z]+$/.test(t) && t.includes("x")) || (i === 0 && /^[A-Za-z]+$/.test(t) && t.includes("x")));
    case "unzip": return !args.some((t) => /^-[a-zA-Z]*[ltvZ]/.test(t)); // -l/-t/-v/-Z only list or test
    case "unar": case "gunzip": case "bunzip2": case "unxz": case "unzstd": case "uncompress": case "funzip": case "cpio": return true;
    case "ditto": return args.some((t) => /^-[a-zA-Z]*x/.test(t));
    case "7z": case "7za": case "7zz": case "7zr": return /^[xe]$/.test(args[0] ?? "");
    case "xz": case "zstd": case "gzip": case "bzip2": return args.some((t) => /^-[a-zA-Z]*d/.test(t) || t === "--decompress");
    default: return false;
  }
}

/** Bug 440: a command that runs code from files on disk: a program named by a path, a runner's script, a build. */
const BUILD_RUNNERS = /^(make|gmake|cmake|ninja|meson|scons|rake)$/;
function runsLocalCode(c: ShCmd): boolean {
  const prog = c.argv[0]?.text ?? "";
  if (prog.includes("/") || c.argv[0]?.dynamic) return true;
  if (codeWords(c).length) return true;
  if (BUILD_RUNNERS.test(c.program)) return true;
  const sub = c.argv[1]?.text ?? "";
  if (/^(npm|pnpm|yarn|bun)$/.test(c.program) && (c.argv.length === 1 || /^(i|install|ci|add|run|run-script|start|test|exec|x|rebuild)$/.test(sub))) return true;
  if (/^(pip[0-9.]*|uv|pipx)$/.test(c.program) && c.argv.slice(1).some((w) => /^\.{1,2}$/.test(w.text) || (w.text.includes("/") && !w.text.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w.text)))) return true;
  return false;
}

export function fetchAndRun(cmds: readonly ShCmd[]): FullAutoResult | null {
  const fetchers = cmds.filter((c) => FETCHERS.test(c.program));
  if (!fetchers.length) return null;
  const hit = R("security", "fetch-and-run", "This downloads code and runs it.");
  // 1. A download inside a substitution, and a runner that takes its program from a substitution.
  if (fetchers.some((c) => c.origin === "subst" || c.origin === "procsubst")) {
    for (const c of cmds) {
      if (FETCHERS.test(c.program) || c.origin === "subst" || c.origin === "procsubst") continue;
      if (c.programFromInput || codeWords(c).some((w) => w.dynamic || w.procSubst !== null)) return hit;
    }
  }
  // 2. A file a fetcher saved (a tee in its pipeline too), then run as a program or a runner's script.
  const saved = new Set<string>();
  const fetchPipes = new Set<string>();
  for (const f of fetchers) {
    for (const n of savedNames(f)) saved.add(n);
    fetchPipes.add(`${f.origin}:${f.group}:${f.pipeline}`);
  }
  // Linear (bug 433): one pass over the tees, matched to a fetcher's pipeline by key.
  for (const t of cmds) if (t.program === "tee" && fetchPipes.has(`${t.origin}:${t.group}:${t.pipeline}`)) for (const w of t.argv.slice(1)) if (!w.text.startsWith("-")) saved.add(base(w.text));
  // 3. Bug 440: an archive unpacked after a download in the same command, then something run from what it unpacked:
  // a program named by a path, a runner's script, or the archive's own build (make, npm install …). Which files the
  // archive held can't be known ahead of time, so any such run after the unpack counts. Unpacking alone is fine.
  const firstFetch = cmds.findIndex((c) => FETCHERS.test(c.program));
  const unpack = cmds.findIndex((c, i) => i > firstFetch && unpacks(c));
  if (unpack >= 0 && cmds.some((c, i) => i > unpack && runsLocalCode(c))) return hit;
  if (!saved.size) return null;
  for (const c of cmds) {
    if (FETCHERS.test(c.program)) continue;
    const prog = c.argv[0]?.text ?? "";
    if (prog.includes("/") && saved.has(base(prog))) return hit;
    if (codeWords(c).some((w) => !w.dynamic && saved.has(base(w.text)))) return hit;
  }
  return null;
}

/**
 * Bug 440: cloud storage CLIs. A copy, sync or move whose destination is a bucket or a remote sends files off this
 * machine, like scp. Only a plain download (the first operand is the bucket, nothing else is remote or unknown) runs
 * without asking; a copy between two buckets, a source read from stdin, or a destination in a variable asks.
 */
const AWS_VALUE = /^--(profile|region|endpoint-url|output|query|ca-bundle|cli-read-timeout|cli-connect-timeout|color|cli-binary-format|acl|grants|storage-class|sse|sse-c|sse-c-key|sse-kms-key-id|sse-c-copy-source|sse-c-copy-source-key|exclude|include|cache-control|content-type|content-disposition|content-encoding|content-language|expires|metadata|metadata-directive|website-redirect|page-size|expected-size|request-payer|source-region|checksum-algorithm|checksum-mode|copy-props|tagging|tagging-directive)$/;
const GSUTIL_VALUE = new Set("hoiuazjLsxy".split(""));
const GCLOUD_VALUE = /^--(project|billing-project|account|configuration|impersonate-service-account|verbosity|format|flatten|content-type|content-encoding|content-disposition|content-language|cache-control|canned-acl|predefined-acl|storage-class|exclude|manifest-path|encryption-key|decryption-keys|custom-metadata|custom-time|log-http|trace-token|user-output-enabled)$/;
const RCLONE_VALUE = /^--(config|transfers|checkers|include|exclude|filter|filter-from|include-from|exclude-from|files-from|files-from-raw|bwlimit|max-age|min-age|max-size|min-size|log-file|log-level|backup-dir|compare-dest|copy-dest|suffix|retries|retries-sleep|low-level-retries|contimeout|timeout|max-transfer|max-depth|order-by|stats|stats-log-level|user-agent|cache-dir|temp-dir|max-backlog|multi-thread-streams|multi-thread-cutoff|buffer-size|tpslimit|tpslimit-burst|header|header-upload|header-download|metadata-set|workdir)$/;
const B2_VALUE = /^--(threads|compare-versions|compare-threshold|exclude-regex|include-regex|exclude-dir-regex|exclude-if-modified-after|keep-days|replace-newer|skip-newer|destination-server-side-encryption|destination-server-side-encryption-algorithm)$/;
/** An rclone remote: `name:path` or an on-the-fly backend `:s3:bucket` (a local path has a / or . before any colon). */
const RCLONE_REMOTE = /^(:[\w-]+[:,]|\w[\w .-]*:)(?!\/\/)/;
const NO_VALUE = /^$/;

/** The operands of a transfer (flags and their values skipped), and whether a skipped flag value named a remote. */
function transferOperands(words: readonly ShWord[], o: { longValue: RegExp; shortValue?: ReadonlySet<string>; stopAtOperand?: boolean; remote: RegExp }): { ops: ShWord[]; remoteValue: boolean } {
  const ops: ShWord[] = [];
  let remoteValue = false;
  let flags = true;
  const isRemote = (w: ShWord | undefined) => !!w && !w.dynamic && o.remote.test(w.text);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (!flags || w.dynamic || t === "-" || !t.startsWith("-")) {
      ops.push(w);
      if (o.stopAtOperand) flags = false;
      continue;
    }
    if (t === "--") { flags = false; continue; }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq >= 0) { if (o.remote.test(t.slice(eq + 1))) remoteValue = true; continue; }
      if (o.longValue.test(t)) { if (isRemote(words[i + 1])) remoteValue = true; i++; }
      continue;
    }
    for (let k = 1; k < t.length; k++) {
      if (!o.shortValue?.has(t[k]!)) continue;
      if (k + 1 === t.length) { if (isRemote(words[i + 1])) remoteValue = true; i++; }
      break;
    }
  }
  return { ops, remoteValue };
}

/** A transfer sends data out unless it is provably a download: the first operand remote, no other remote or unknown. */
function sendsOut(t: { ops: ShWord[]; remoteValue: boolean }, remote: RegExp): boolean {
  const isRemote = (w: ShWord) => !w.dynamic && remote.test(w.text);
  if (t.remoteValue) return true;
  if (!t.ops.some((w) => isRemote(w) || w.dynamic)) return false; // a local copy: not a transfer at all
  const [first, ...rest] = t.ops;
  return !(first && isRemote(first) && rest.every((w) => !isRemote(w) && !w.dynamic));
}

function cloudUpload(c: ShCmd): FullAutoResult | null {
  const prog = c.program;
  const words = c.argv.slice(1);
  const texts = words.map((w) => w.text);
  const hit = (what: string) => R("send", "cloud-upload", `This uploads files to ${what} on another machine.`);
  if (prog === "aws") {
    const at = texts.findIndex((t) => t === "s3" || t === "s3api");
    if (at < 0) return null;
    const verb = texts[at + 1] ?? "";
    if (texts[at] === "s3api") return /^(put-object|upload-part|upload-part-copy|copy-object|create-multipart-upload|complete-multipart-upload)$/.test(verb) ? hit("cloud storage (S3)") : null;
    if (!/^(cp|sync|mv)$/.test(verb)) return null;
    const remote = /^(s3:\/\/|arn:)/i;
    return sendsOut(transferOperands(words.slice(at + 2), { longValue: AWS_VALUE, remote }), remote) ? hit("cloud storage (S3)") : null;
  }
  if (prog === "gsutil") {
    const remote = /^(gs|s3):\/\//i;
    // Global options come before the command, and gsutil stops reading options at the first operand.
    let i = 0;
    for (; i < words.length && texts[i]!.startsWith("-"); i++) if (/^-[hoiu]$/.test(texts[i]!)) i++;
    if (!/^(cp|mv|rsync)$/.test(texts[i] ?? "")) return null;
    return sendsOut(transferOperands(words.slice(i + 1), { longValue: NO_VALUE, shortValue: GSUTIL_VALUE, stopAtOperand: true, remote }), remote) ? hit("cloud storage (Google Cloud)") : null;
  }
  if (prog === "gcloud") {
    const at = texts.indexOf("storage");
    if (at < 0 || !/^(cp|mv|rsync)$/.test(texts[at + 1] ?? "")) return null;
    const remote = /^(gs|s3):\/\//i;
    return sendsOut(transferOperands(words.slice(at + 2), { longValue: GCLOUD_VALUE, remote }), remote) ? hit("cloud storage (Google Cloud)") : null;
  }
  if (prog === "rclone") {
    const t = transferOperands(words, { longValue: RCLONE_VALUE, remote: RCLONE_REMOTE });
    const verb = t.ops[0]?.text ?? "";
    if (/^(rcat|copyurl)$/.test(verb)) return hit("a remote storage service");
    if (!/^(copy|copyto|sync|move|moveto|bisync)$/.test(verb)) return null;
    return sendsOut({ ops: t.ops.slice(1), remoteValue: t.remoteValue }, RCLONE_REMOTE) ? hit("a remote storage service") : null;
  }
  if (prog === "az") {
    const at = texts.indexOf("storage");
    if (at < 0) return null;
    // az storage blob upload / upload-batch / sync, file upload, fs file upload, azcopy blob upload, blob copy start …
    const rest = texts.slice(at + 1).filter((x) => !x.startsWith("-")).slice(0, 4);
    return rest.some((x) => /^(upload|upload-batch|sync|copy|start|start-batch)$/.test(x)) ? hit("cloud storage (Azure)") : null;
  }
  if (prog === "azcopy") {
    if (!/^(copy|cp|sync)$/.test(texts[0] ?? "")) return null;
    const remote = /^https?:\/\//i;
    return sendsOut(transferOperands(words.slice(1), { longValue: NO_VALUE, remote }), remote) ? hit("cloud storage (Azure)") : null;
  }
  if (prog === "b2") {
    const ops = texts.filter((x) => !x.startsWith("-"));
    const verb = ops[0] ?? "";
    if (/^(upload-file|upload_file|upload-unbound-stream|upload_unbound_stream|copy-file-by-id|copy_file_by_id)$/.test(verb)) return hit("cloud storage (Backblaze B2)");
    if (verb === "file" && /^(upload|copy-by-id|server-side-copy)$/.test(ops[1] ?? "")) return hit("cloud storage (Backblaze B2)");
    if (verb !== "sync") return null;
    const remote = /^b2:\/\//i;
    return sendsOut(transferOperands(words.slice(texts.indexOf("sync") + 1), { longValue: B2_VALUE, remote }), remote) ? hit("cloud storage (Backblaze B2)") : null;
  }
  return null;
}

function sendForCommand(c: ShCmd, whole: WholeText, ctx: FullAutoContext): FullAutoResult | null {
  void ctx;
  const prog = c.program;
  if (MAILERS.test(prog)) return R("send", "email", "This sends an email.");
  const cloud = cloudUpload(c);
  if (cloud) return cloud;
  if (SOCKET_TOOLS.test(prog)) return R("send", "network", `“${prog}” sends data to another machine.`);
  if (prog === "ssh" && c.argv.slice(1).some((w) => !w.text.startsWith("-"))) return R("send", "network", "This runs something on, or sends data to, another machine over ssh.");
  if (/^(scp|rsync)$/.test(prog) && c.argv.slice(1).some((w) => !w.text.startsWith("-") && REMOTE_OPERAND.test(w.literal))) return R("send", "network", `“${prog}” copies files to or from another machine.`);
  if (INTERPRETERS.test(prog) && c.inlineCode.some((code) => NET_CODE.test(code))) return R("send", "network-script", "This script opens a network connection.");
  // Bug 258: an email sent through the Mail app with AppleScript.
  if (prog === "osascript" && whole.mailSend()) {
    return R("send", "email", "This sends an email as you from the Mail app.");
  }
  const sms = whole.sms();
  if (sms) return R("send", "message", `This sends a message as you to ${sms.recipient}: “${sms.text.slice(0, 200)}”.`);
  if (NET_SENDERS.test(prog)) {
    const args = c.argv.slice(1).map((w) => w.text);
    const method = args.find((a, i) => /^(-X|--request|--method)$/.test(args[i - 1] ?? "") || /^--request=/.test(a));
    const writes = args.some((a) => SEND_FLAGS.test(a) || /^(--data|--form|--upload-file|--json)=/.test(a)) || (!!method && WRITE_METHODS.test(method.replace(/^--request=/, "")));
    if (writes && urlsIn(c).some(thirdParty)) return R("send", "webhook", "This posts data to a third-party service.");
    // Bug 439: the same upload in every spelling the program accepts (`-d@file`, `-sF f=@x`, `--post-file=x`, an
    // httpie `POST … @file`), and to a host written without https://. Anything but this machine asks.
    const req = netRequest(c);
    if (req.writes && (req.hosts.length === 0 || req.hosts.some((h) => h === null || !LOCAL_HOST.test(h)))) return R("send", "webhook", "This posts data to a third-party service.");
    // Bug 256 (review): data smuggled into a GET — a command substitution in the URL or a header, or a header file.
    const words = c.argv.slice(1);
    const smuggles = words.some((w, i) => {
      const raw = w.literal;
      if (/\$\(|`|<\(/.test(raw) || (w.dynamic && w.procSubst !== null)) return true;
      if (w.dynamic && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw) && /^https?:|^-H|^--header/.test(raw)) return true;
      const prev = words[i - 1]?.text ?? "";
      return (/^(-H|--header)$/.test(prev) && w.text.startsWith("@")) || /^--header=@/.test(w.text);
    }) || (c.argv.some((w) => w.dynamic) && whole.hasSubst());
    if (smuggles) return R("send", "exfil", "This puts the output of a command or a file into a web request.");
  }
  if (/^(gh|glab)$/.test(prog)) {
    const topic = sub(c);
    const verb = sub(c, c.argv.findIndex((w) => w.text === topic) + 1);
    const re = FORGE_SEND[topic];
    if (re && re.test(verb)) {
      const visibility = c.argv.some((w) => /^(--public|--visibility[= ]?public)$/.test(w.text)) || c.argv.some((w) => w.text === "public");
      if (topic === "repo" && verb === "edit" && visibility) return R("send", "repo-public", "This makes a repository public.");
      if (topic === "repo" && verb !== "create") return visibility ? R("send", "repo-public", "This makes a repository public.") : null;
      return R("send", "post", `“${prog} ${topic} ${verb}” is seen by other people.`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. MONEY
// ---------------------------------------------------------------------------------------------------------------
const PAYMENT_HOST = /(^|\.)(stripe\.com|paypal\.com|braintreegateway\.com|adyen\.com|checkout\.com|squareup\.com|square\.link|klarna\.com|affirm\.com|authorize\.net|payments\.amazon\.com|pay\.google\.com)$/i;
const MONEY_PATH = /\/(checkout|checkouts|payment|payments|billing|purchase|buy|cart|order|orders|subscribe|subscription|upgrade)(s)?(\/|$|\?)/i;
const MONEY_WORDS = /\b(pay|pay now|buy|buy now|purchase|place (?:your )?order|order now|complete (?:order|purchase)|check ?out|checkout|subscribe|upgrade plan|add card|donate|renew|confirm (?:payment|order)|start (?:trial|subscription))\b/i;

function moneyUrl(u: string | undefined): boolean {
  if (!u) return false;
  if (PAYMENT_HOST.test(hostOf(u))) return true;
  const p = u.replace(/^https?:\/\/[^/]*/i, "");
  return MONEY_PATH.test(p.split("#")[0] ?? p);
}

function moneyForCommand(c: ShCmd): FullAutoResult | null {
  if (!/^(open|xdg-open|start)$/.test(c.program)) return null;
  if (urlsIn(c).some(moneyUrl)) return R("money", "checkout-page", "This opens a checkout, payment or billing page.");
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands the parser cannot see through: a plain text scan for the five categories.
// ---------------------------------------------------------------------------------------------------------------
/** Bug 433: a raw-scan pattern, or a linear-time test for what a backtracking `a[^\n]*b` regex used to find. */
type RawTest = RegExp | ((text: string) => boolean);
const either = (...ts: RawTest[]) => (text: string): boolean => ts.some((t) => (typeof t === "function" ? t(text) : t.test(text)));
const onLine = (...parts: RegExp[]) => (text: string): boolean => inOrder(text, parts, /\n/);
const RAW: [RawTest, FullAutoCategory, string, string][] = [
  [/(\$\(|`|<\()\s*(curl|wget|xh|http)\s/, "security", "security.fetch-and-run", "This downloads code and runs it."],
  [/(^|[\s;&|(`])(sudo|doas|pkexec|run0)\s/, "security", "security.sudo", "This runs with administrator (sudo) privileges."],
  [/\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|c|tc|fi)?sh\b/, "security", "security.pipe-to-shell", "This pipes downloaded content straight into a shell."],
  [/\b(csrutil|spctl|socketfilterfw|pfctl|launchctl|crontab|ssh-keygen|ssh-copy-id|visudo|installer)\b/, "security", "security.system-control", "This changes credentials, permissions, startup items or a system protection."],
  [/(^|[\s/'"=:~])\.(ssh|gnupg|aws|netrc|kube)\b|Keychains|\.zshrc|\.zprofile|\.bash_profile/, "security", "security.protected-place", "This touches keys, credentials or startup files."],
  [/Library\/(Mail|Messages|Safari|Cookies)\b|\b(logins\.json|key[34]\.db|cookies\.sqlite)\b|Login Data|Web Data|\/Cookies\b/, "security", "security.read-credentials", "This reads saved logins, cookies, mail or messages."],
  [either(/(^|[\s;&|(`])(nc|ncat|netcat|socat|telnet|sftp)\s|\bssh\s+[^-\s]/, onLine(/\b(scp|rsync)\b/, /\s[^\s/:]+:/)), "send", "send.network", "This sends data to another machine."],
  // Bug 440: a cloud storage copy the parser couldn't read: its direction can't be proven, so it asks.
  [either(/\bgcloud\s+storage\s+(cp|mv|rsync)\s|\brclone\s+(copy|copyto|sync|move|moveto|bisync|rcat|copyurl)\s|\bazcopy\s+(copy|cp|sync)\s|\bb2\s+(upload[-_]\w+|file\s+upload|sync)\b/,
    onLine(/\baws\b/, /\ss3\s+(cp|sync|mv)\s|\ss3api\s+(put-object|upload-part|copy-object)\b/), onLine(/\bgsutil\b/, /\s(cp|mv|rsync)\s/), onLine(/\baz\s+storage\b/, /\s(upload|upload-batch|sync|copy)\b/)),
  "send", "send.cloud-upload", "This uploads files to cloud storage on another machine."],
  [either(/--global\b|\bbrew\s+(install|upgrade)\b/, onLine(/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/, /\s-g\b/)), "security", "security.system-install", "This installs software outside the project."],
  [/\brm\s+-[a-zA-Z]*[rRf]/, "destruction", "destruction.delete-unproven-target", "This deletes files at a path that can't be checked ahead of time."],
  [either(/\breset\s+--hard\b|\bfilter-(branch|repo)\b|\bgit\s+clean\s+-[a-zA-Z]*f/, onLine(/\bgit\s+/, /\bpush\b/, /--force|-f\b/)), "destruction", "destruction.discard-work", "This overwrites or discards work that can't be recovered."],
  [/\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, "destruction", "destruction.drop-database", "This drops or empties a database."],
  [/\bdiskutil\s+(erase|apfs\s+deleteVolume)|\bmkfs\b|\bempty\s+(the\s+)?trash\b/i, "destruction", "destruction.wipe-disk", "This erases a disk, volume or the Trash."],
  [either(/\b(mail|sendmail|mutt|msmtp)\b|\bgh\s+(pr|issue|gist|release)\s+(create|comment)/i, onLine(/\bcurl\b/i, /-X\s*(POST|PUT|PATCH)|--data|-d\s/i)), "send", "send.post", "This sends something a person receives."],
  [/app(lication)?\s+"Messages"/i, "send", "send.message", "This sends a message as you."],
  [/\/(checkout|billing|payment|purchase)(\/|\?|$)|stripe\.com|paypal\.com/i, "money", "money.checkout-page", "This touches a checkout, payment or billing page."],
];

function rawScan(text: string): FullAutoResult | null {
  for (const [re, category, rule, reason] of RAW) {
    if (typeof re === "function" ? re(text) : re.test(text)) return { ask: true, category, rule, reason };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tool calls (the host classifier's target actions)
// ---------------------------------------------------------------------------------------------------------------
/** Actions that hand another Bot or person access, or change what other Bots are told. */
const ACCESS_ACTIONS = new Set(["update_agent", "create_agent", "add_mcp_server", "install_plugin", "install_local_mcp_server", "enable_mcp_tool", "set_mcp_instructions", "template_other_bot"]);
const GOOGLE_READS = new Set(["gmail_search", "gmail_read", "calendar_list", "drive_search", "drive_read", "drive_list"]);

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Bug 275: what the host knows about an MCP tool from a registry server. `known` = a server Synapse ships and
 * knows (curated); anything else is unknown. `description` = the tool's own description, when the host has it.
 */
export interface McpToolMeta { known: boolean; description?: string | null }

/** A tool name's words: split on separators and case changes (createPaymentIntent → create, payment, intent). */
function wordsOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** Bug 275: deleting words, whole words only (list_removed_items is a read, below). */
const DESTROY_WORD = /^(delete[ds]?|deleting|destroy(s|ed|ing)?|purge[ds]?|purging|wipe[ds]?|wiping|trash(es|ed|ing)?|remove[ds]?|removing|erase[ds]?|erasing|drop(s|ped|ping)?|truncate[ds]?|bulkdelete)$/;
/** Bug 275: money words — the old list matched "pay" but not "payment", "charge", "invoice", "transfer", "payout" … */
const MONEY_WORD = /^(pay|pays|paid|paying|payment|payments|payout|payouts|purchase[ds]?|purchasing|checkout|charge[ds]?|charging|subscribe[ds]?|subscribing|subscription|subscriptions|invoice[ds]?|invoicing|refund(s|ed|ing)?|transfer(s|red|ring)?|withdraw(s|al|als|ing)?|deposit(s|ed|ing)?|billing|bill|buy(s|ing)?|order|orders|donate[ds]?|donation|donations|tip|tips|remit|remittance|sell|spend|topup|money|funds)$/;
/** Bug 275: somebody else receives it. */
const SEND_WORD = /^(send[s]?|sending|sendmail|post(s|ed|ing)?|publish(es|ed|ing)?|share[ds]?|sharing|tweet[s]?|toot[s]?|invite[ds]?|inviting|invitation[s]?|comment[s]?|reply|replies|respond|forward(s|ed|ing)?|notify|notification[s]?|broadcast[s]?|announce|email[s]?|mail|dm[s]?|sms|message[s]?|attendee[s]?|guest[s]?|invitee[s]?|rsvp|mention[s]?|dial)$/;
/** Send words that are also plain nouns, so list_messages / get_comment stay reads. */
const SEND_NOUN = /^(message[s]?|email[s]?|mail|comment[s]?|attendee[s]?|guest[s]?|invitee[s]?|invitation[s]?|notification[s]?|mention[s]?|post[s]?|tweet[s]?|dm[s]?|sms|replies)$/;
/** A plain read by its first word (get_…, list_…, search_…). */
const READ_LEAD = /^(get|list|search|read|fetch|find|query|lookup|describe|retrieve|count|view|show|check|browse|download|preview|inspect|peek|validate|verify)$/;
/** Words that make a tool a change even when it starts like a read (get_or_create, fetch_and_send). */
const CHANGE_WORD = /^(create|make|add|new|set|update|upsert|insert|write|edit|patch|put|issue|execute|run|trigger|invoke|schedule|book|and|or|then)$/;

/** Input keys whose value says who receives it (snake_case; camelCase is folded first). */
const RECIPIENT_FIELD = /^(to|cc|bcc|recipient|recipients|recipient_email|recipient_emails|recipient_list|extra_recipients|to_email|to_emails|to_address|to_addresses|email|emails|email_address|email_addresses|attendee|attendees|guest|guests|invitee|invitees|participant|participants|channel|channels|channel_id|channel_name|chat_id|conversation_id|phone|phone_number|phone_numbers|to_number|mobile|share_with|shared_with|user_email|user_emails|webhook|webhook_url|audience|followers|subscribers|mentions)$/;
/** Input keys whose value is money moving (a currency alone is not: a list can filter by it). */
const MONEY_FIELD = /^(amount|amounts|amount_cents|amount_in_cents|amount_minor|unit_amount|price|price_id|payment_method|payment_method_id|payment_method_types|payment_intent|card_number|cvc|iban|account_number|routing_number|sort_code|bank_account|destination_account|payee|tip_amount)$/;
/** Message text, not who receives it. */
const BODY_FIELD = /^(body|text|message|content|html|markdown|subject|comment|caption)$/;

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Every key/value pair of an input, nested objects and arrays included (depth-capped). */
function eachField(v: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) eachField(x, visit, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    visit(snake(k), x);
    eachField(x, visit, depth + 1);
  }
}
function fieldIn(input: Record<string, unknown>, re: RegExp): boolean {
  let hit = false;
  eachField(input, (k, v) => { if (!hit && re.test(k) && present(v)) hit = true; });
  return hit;
}
const moneyFieldIn = (input: Record<string, unknown>): boolean => fieldIn(input, MONEY_FIELD);
/** A Composio meta tool's inner slugs (tool_slug: "GMAIL_SEND_EMAIL", tools: [{ tool_slug … }]). */
function innerSlugs(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  eachField(input, (k, v) => { if (/^(tool_slug|slug|action|tool|tool_name|action_name)$/.test(k) && typeof v === "string" && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(v)) out.push(v); });
  return out;
}

/** What a tool description says it does, verbs only ("Lists payments" is a read; "Charges a card" is not). */
const DESC_DESTROY = /\b(delet(e|es|ing)|remov(e|es|ing)|trash(es|ing)?|destroy(s|ing)?|eras(e|es|ing)|purg(e|es|ing))\b/i;
const DESC_MONEY = /\b(pay(s|ing)?|charg(e|es|ing)|refund(s|ing)?|transfer(s|ring)?|payout|purchas(e|es|ing)|buy(s|ing)?|withdraw(s|ing)?|(creates?|issues?|sends?) (an? |the )?(payment|invoice|charge|subscription|order|transfer|payout|refund)s?)\b/i;
const DESC_SEND = /\b(send(s|ing)?|publish(es|ing)?|invit(e|es|ing)|shar(e|es|ing) (it |this |the \w+ |\w+ )?with|forward(s|ing)?|notif(y|ies|ying)|repl(y|ies|ying) to|post(s|ing)? (a |an |the )?(message|tweet|comment|update|reply|status|to|in|on)|e-?mail(s|ing)? (to|a|an|the)|messag(e|es|ing) (to|a|an|the))\b/i;

/**
 * Bug 275 — Full auto: a tool from a generic or custom MCP server. It cards whenever it could delete, pay, send,
 * post, invite or share, judged by its name, its description, and the recipient-like or money-like fields in its
 * input. A plain read (get_…, list_…) carrying no message text stays quiet. On a server Synapse doesn't
 * specifically know, a change it can't judge (no description to go on) is a card too: unknown means card.
 */
function connectorAsk(server: string, tool: string, input: Record<string, unknown>, meta: McpToolMeta | undefined): FullAutoResult | null {
  const name = `“${snake(server)} ${snake(tool)}”`;
  const words = [...wordsOf(tool), ...innerSlugs(input).flatMap(wordsOf)];
  const desc = meta?.description?.trim() ?? "";
  const hasBody = fieldIn(input, BODY_FIELD);
  // A read: get_/list_/search_… with no change or send verb after it, and no message text in its input.
  // One leading app name is allowed (googlecalendar_list_events), as long as it isn't itself a verb.
  const verb = (w: string) => CHANGE_WORD.test(w) || DESTROY_WORD.test(w) || MONEY_WORD.test(w) || SEND_WORD.test(w);
  const lead = READ_LEAD.test(words[0] ?? "") ? 0 : READ_LEAD.test(words[1] ?? "") && !verb(words[0] ?? "") ? 1 : -1;
  const read = lead >= 0 && !hasBody
    && !words.slice(lead + 1).some((w) => CHANGE_WORD.test(w) || /^(delete|destroy|purge|wipe|trash|remove|erase|drop|truncate)$/.test(w) || (SEND_WORD.test(w) && !SEND_NOUN.test(w)));
  if (read) return readLies(name, desc.split(/(?<=[.!?])\s|\n/)[0] ?? "");
  if (words.some((w) => DESTROY_WORD.test(w)) || DESC_DESTROY.test(desc)) return R("destruction", "delete-record", `${name} deletes something of yours.`);
  if (words.some((w) => MONEY_WORD.test(w)) || DESC_MONEY.test(desc) || moneyFieldIn(input)) return R("money", "purchase", `${name} spends or moves money.`);
  if (words.some((w) => SEND_WORD.test(w)) || DESC_SEND.test(desc) || fieldIn(input, RECIPIENT_FIELD)) return R("send", "post", `${name} reaches other people.`);
  if (meta?.known !== true && !desc) return R("send", "unknown-tool", `${name} is from a server Synapse doesn't know, so it needs your OK.`);
  return null;
}
/** A tool named like a read whose own description (its first sentence) says it deletes, pays or sends: believe that. */
function readLies(name: string, first: string): FullAutoResult | null {
  if (DESC_DESTROY.test(first)) return R("destruction", "delete-record", `${name} deletes something of yours.`);
  if (DESC_MONEY.test(first)) return R("money", "purchase", `${name} spends or moves money.`);
  if (DESC_SEND.test(first)) return R("send", "post", `${name} reaches other people.`);
  return null;
}

function toolAsk(action: string, args: Record<string, unknown>, meta?: McpToolMeta): FullAutoResult | null {
  if (ACCESS_ACTIONS.has(action)) return R("security", "grant-access", "This changes what another Bot is told or what it can reach.");
  if (/^delete_/.test(action)) return R("destruction", "delete-record", "This deletes something of yours that can't be brought back.");
  if (action === "google_write") {
    const tool = String(args.tool ?? "");
    if (GOOGLE_READS.has(tool)) return null;
    if (tool === "gmail_send") return R("send", "email", "This sends an email from your account.");
    if (tool === "calendar_delete") return R("destruction", "delete-record", "This deletes an event from your calendar.");
    if (/^calendar_(create|update)$/.test(tool)) {
      const guests = args.attendees ?? args.guests ?? args.invitees;
      return Array.isArray(guests) && guests.length > 0 ? R("send", "invite", "This invites other people to a calendar event.") : null;
    }
    return null; // a draft, a Drive upload: nothing leaves and nothing is destroyed
  }
  if (action === "composio_write") {
    // Apps through Composio: the host only classifies a call as a write when it isn't a plain read, and a write
    // in the user's own connected account asks in Full auto too (the owner's rule: every send or change asks).
    // Bug 275: a meta tool (COMPOSIO_MULTI_EXECUTE_TOOL …) names the real slugs inside its input; they count too.
    const tool = snake(String(args.tool ?? ""));
    const input = (args.arguments ?? {}) as Record<string, unknown>;
    const words = [...wordsOf(tool), ...innerSlugs(input).flatMap(wordsOf)];
    if (words.some((w) => DESTROY_WORD.test(w))) return R("destruction", "delete-record", "This deletes something in your connected app.");
    if (words.some((w) => MONEY_WORD.test(w)) || moneyFieldIn(input)) return R("money", "purchase", "This spends or moves money in your connected app.");
    return R("send", "connected-app", "This sends or changes something in your connected app.");
  }
  if (action === "mcp") return connectorAsk(String(args.server ?? ""), String(args.tool ?? ""), (args.arguments ?? {}) as Record<string, unknown>, meta);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Browser actions (judged against the live element by app/src/main/browser)
// ---------------------------------------------------------------------------------------------------------------
const BROWSER_SEND = /\b(send|post|publish|tweet|share|submit for review|invite|comment|reply|email)\b/i;
const BROWSER_DESTROY = /\b(delete|remove|erase|destroy|deactivate|close account|wipe|discard)\b/i;
const BROWSER_SECURITY = /\b(change password|reset password|revoke|add (?:an? )?key|api key|two-factor|2fa|add member|grant access|disable (?:security|protection))\b/i;

function browserAsk(a: Extract<FullAutoAction, { kind: "browser" }>): FullAutoResult | null {
  const label = (a.label ?? "").trim();
  if (a.field === "card") return R("money", "card-field", "This types into a payment-card field.");
  if (a.field === "password") return R("security", "password-field", "This types into a password field.");
  if (moneyUrl(a.url) || MONEY_WORDS.test(label)) return R("money", "checkout-page", `${label ? `“${label}”` : "This"} is on a checkout, payment or billing page.`);
  if (BROWSER_DESTROY.test(label)) return R("destruction", "delete-record", `“${label}” deletes something.`);
  if (BROWSER_SEND.test(label)) return R("send", "post", `“${label}” is seen by other people.`);
  if (BROWSER_SECURITY.test(label)) return R("security", "grant-access", `“${label}” changes credentials or access.`);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The one entry point.
// ---------------------------------------------------------------------------------------------------------------
/**
 * Does this action need the user's OK in Full auto? Precedence inside one command is
 * security → destruction → send → money, so `sudo rm /etc/hosts` is named as the security change it is.
 */
export function fullAutoAsk(action: FullAutoAction, ctx: FullAutoContext): FullAutoResult {
  const r = fullAutoAskAll(action, ctx);
  // Bug 258: No limits lifts sending outward and the reads of private files and credentials, nothing else.
  return ctx.noLimits && r.ask && liftedByNoLimits(r) ? OK : r;
}
// Bug 275: a tool Synapse can't judge (send.unknown-tool) may spend or delete, so No limits doesn't lift it.
const liftedByNoLimits = (r: FullAutoResult): boolean => (r.category === "send" && r.rule !== "send.unknown-tool") || r.rule === "security.read-credentials";

function fullAutoAskAll(action: FullAutoAction, ctx: FullAutoContext): FullAutoResult {
  if (action.kind === "tool") return toolAsk(action.action, action.args ?? {}, action.mcp) ?? OK;
  if (action.kind === "browser") return browserAsk(action) ?? OK;

  if (action.kind === "file") {
    const base = action.cwd ?? ctx.workspaces[0] ?? ctx.home;
    const abs = lexical(expandHome(action.path, ctx.home), base);
    if (action.op === "read") {
      return securityPathHit(abs, ctx) || credentialStore(abs, ctx)
        ? R("security", "read-credentials", "This reads keys, saved logins, cookies, mail, messages or secrets.")
        : OK;
    }
    if (securityPathHit(abs, ctx)) return R("security", "protected-place", "This touches keys, credentials, startup items or a security setting.");
    if (TOOL_CONFIG_PATH.test(abs)) return OK; // git's own config: tooling setup, not the user's data
    if (inWorkspace(abs, ctx)) return OK;
    if (action.op === "delete") return R("destruction", "delete-outside-workspace", "This deletes a file outside the Bot's own workspace.");
    if (ctx.exists && !ctx.exists(abs)) return OK; // creating a new file destroys nothing
    return R("destruction", "overwrite-outside-workspace", "This overwrites a file outside the Bot's own workspace.");
  }

  const command = action.command ?? "";
  // Bug 433: a Mac command too long to check ahead of time asks (see MAC_COMMAND_MAX); No limits doesn't lift it.
  if (action.side === "mac" && command.length > MAC_COMMAND_MAX) return R("security", "too-long", "This command is too long to check ahead of time.");
  const parse = parseShell(command, { cwd: action.cwd ?? ctx.workspaces[0] ?? ctx.home, home: ctx.home, vars: ctx.vars });
  let hit: FullAutoResult | null = null;
  const fdSafe = fdAliasesSafe(parse.cmds, parse.opaque.length > 0);
  const whole = wholeText(command);
  for (const c of parse.cmds) {
    hit = securityForCommand(c, ctx) ?? destructionForCommand(c, ctx, fdSafe) ?? sendForCommand(c, whole, ctx) ?? moneyForCommand(c);
    if (hit) return hit;
  }
  hit = fetchAndRun(parse.cmds);
  if (hit) return hit;
  // Nothing the parser could see is one of the five. If it could not see everything, scan the raw text too:
  // Full auto is the user's own trust, so unreadable-but-ordinary text runs — unreadable-and-loaded text asks.
  if (parse.opaque.length > 0) return rawScan(command) ?? OK;
  return OK;
}

/**
 * The Mac coordinator's own adapter: one LocalExecRequest as the Full-auto classifier sees it. It lives here, next
 * to the policy, so the Mac and the host cannot describe the same request differently.
 */
export function localFullAutoAction(
  r: { op: string; command?: string; path?: string; cwd?: string; browser?: { action?: string; url?: string; value?: string; submit?: boolean } },
  base: string,
  home: string,
): FullAutoAction | null {
  const at = (p: string | undefined): string => {
    if (p === "~" || p?.startsWith("~/")) return `${home.replace(/\/$/, "")}${p.slice(1)}`;
    if (p?.startsWith("/")) return p;
    const rel = (p ?? "").replace(/^\.\/?/, "");
    return rel ? `${base.replace(/\/$/, "")}/${rel}` : base;
  };
  switch (r.op) {
    case "run-command": case "send-input": return { kind: "command", side: "mac", command: r.command ?? "", cwd: r.cwd ? at(r.cwd) : base };
    case "write-file": case "copy-from-box": return { kind: "file", side: "mac", op: "write", path: at(r.path), cwd: base };
    case "edit-file": return { kind: "file", side: "mac", op: "edit", path: at(r.path), cwd: base };
    case "browser": return { kind: "browser", action: r.browser?.action ?? "", url: r.browser?.url, label: r.browser?.value, submit: r.browser?.submit === true };
    // Bug 256 (review): the read tools ask only for a credential store (keys, saved logins, cookies, mail, messages).
    case "read-file": case "list-directory": case "glob": case "grep": case "copy-to-box": return { kind: "file", side: "mac", op: "read", path: r.path ?? base, cwd: base };
    default: return null;
  }
}
