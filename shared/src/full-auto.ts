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
import { messagesSend } from "./mac-messages";
import { parseShell, shPath, type ShCmd, type ShRedirect, type ShWord } from "./shell-parse";

export type FullAutoCategory = "destruction" | "send" | "money" | "security" | "user-rule";

/** The five, in the order the settings line and the logs name them. */
export const FULL_AUTO_CATEGORIES: readonly FullAutoCategory[] = ["destruction", "send", "money", "security", "user-rule"];

/** One short factual line for the Full auto option in settings. No marketing copy. */
export const FULL_AUTO_SETTINGS_LINE =
  "Still asks before: deleting your files, sending or posting, spending money, and security or access changes.";

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
  | { kind: "tool"; action: string; args?: Record<string, unknown> }
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

function realOf(abs: string, realpath?: (p: string) => string): string {
  if (!realpath) return abs;
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return lexical([realpath(cur), ...tail].join("/"), "/"); } catch { /* missing: walk up */ }
    if (cur === "/") return abs;
    tail.unshift(cur.slice(cur.lastIndexOf("/") + 1));
    cur = cur.slice(0, cur.lastIndexOf("/")) || "/";
  }
}

/** True when the path is inside a root the Bot owns (its workspace, its scratch, a Mac project dir). */
function inWorkspace(abs: string, ctx: FullAutoContext): boolean {
  const roots = ctx.workspaces.filter((d) => typeof d === "string" && d.startsWith("/")).map((d) => fold(lexical(d, "/")));
  const check = (p: string) => roots.some((r) => within(fold(p), r));
  return check(abs) || check(realOf(abs, ctx.realpath));
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
  const h = fold(lexical(ctx.home, "/"));
  const tail = f.startsWith(`${h}/`) ? f.slice(h.length + 1) : "";
  if (SHELL_RC.some((n) => tail === n.toLowerCase())) return true;
  if (SECRET_DIRS.some((d) => within(f, `${h}/${d}`))) return true;
  if (SECRET_ABS.some((d) => within(f, d))) return true;
  if (SECRET_FILE.test(f)) return true;
  return APP_SECURITY_PATH.test(abs);
}
const securityPathHit = (abs: string, ctx: FullAutoContext): boolean =>
  isSecurityPath(abs, ctx) || isSecurityPath(realOf(abs, ctx.realpath), ctx);

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
    const h = fold(lexical(ctx.home, "/"));
    const name = f.slice(f.lastIndexOf("/") + 1);
    if (CREDENTIAL_DIRS.some((d) => within(f, `${h}/${d}`))) return true;
    if (FIREFOX_STORE.test(name)) return true;
    if (CHROMIUM_STORE.test(name) && within(f, `${h}/library/application support`)) return true;
    if (DOTENV.test(name) && !DOTENV_TEMPLATE.test(name) && !inWorkspace(p, ctx)) return true;
    // A recursive copy or archive of a folder that CONTAINS a store takes it along.
    if (recursive && f !== "/" && [...CREDENTIAL_DIRS, ...BROWSER_ROOTS, ".ssh", ".gnupg", ".aws", "library/keychains"].some((d) => within(`${h}/${d}`, f))) return true;
    return false;
  };
  return check(abs) || check(realOf(abs, ctx.realpath));
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
    if (ctx.noLimits && abs && SSH_CLIENTS.test(prog) && within(fold(abs), `${fold(lexical(ctx.home, "/"))}/.ssh`)) continue;
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

function sendForCommand(c: ShCmd, command: string, ctx: FullAutoContext): FullAutoResult | null {
  void ctx;
  const prog = c.program;
  if (MAILERS.test(prog)) return R("send", "email", "This sends an email.");
  if (SOCKET_TOOLS.test(prog)) return R("send", "network", `“${prog}” sends data to another machine.`);
  if (prog === "ssh" && c.argv.slice(1).some((w) => !w.text.startsWith("-"))) return R("send", "network", "This runs something on, or sends data to, another machine over ssh.");
  if (/^(scp|rsync)$/.test(prog) && c.argv.slice(1).some((w) => !w.text.startsWith("-") && REMOTE_OPERAND.test(w.literal))) return R("send", "network", `“${prog}” copies files to or from another machine.`);
  if (INTERPRETERS.test(prog) && c.inlineCode.some((code) => NET_CODE.test(code))) return R("send", "network-script", "This script opens a network connection.");
  // Bug 258: an email sent through the Mail app with AppleScript.
  if (prog === "osascript" && /\bapp(lication)?\s+"Mail"|Application\(\s*["']Mail["']\s*\)/i.test(command) && /\bsend\b/i.test(command.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
    return R("send", "email", "This sends an email as you from the Mail app.");
  }
  const sms = messagesSend(command);
  if (sms) return R("send", "message", `This sends a message as you to ${sms.recipient}: “${sms.text.slice(0, 200)}”.`);
  if (NET_SENDERS.test(prog)) {
    const args = c.argv.slice(1).map((w) => w.text);
    const method = args.find((a, i) => /^(-X|--request|--method)$/.test(args[i - 1] ?? "") || /^--request=/.test(a));
    const writes = args.some((a) => SEND_FLAGS.test(a) || /^(--data|--form|--upload-file|--json)=/.test(a)) || (!!method && WRITE_METHODS.test(method.replace(/^--request=/, "")));
    if (writes && urlsIn(c).some(thirdParty)) return R("send", "webhook", "This posts data to a third-party service.");
    // Bug 256 (review): data smuggled into a GET — a command substitution in the URL or a header, or a header file.
    const words = c.argv.slice(1);
    const smuggles = words.some((w, i) => {
      const raw = w.literal;
      if (/\$\(|`|<\(/.test(raw) || (w.dynamic && w.procSubst !== null)) return true;
      if (w.dynamic && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw) && /^https?:|^-H|^--header/.test(raw)) return true;
      const prev = words[i - 1]?.text ?? "";
      return (/^(-H|--header)$/.test(prev) && w.text.startsWith("@")) || /^--header=@/.test(w.text);
    }) || (c.argv.some((w) => w.dynamic) && /\$\(|`/.test(command));
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
const RAW: [RegExp, FullAutoCategory, string, string][] = [
  [/(^|[\s;&|(`])(sudo|doas|pkexec|run0)\s/, "security", "security.sudo", "This runs with administrator (sudo) privileges."],
  [/\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|c|tc|fi)?sh\b/, "security", "security.pipe-to-shell", "This pipes downloaded content straight into a shell."],
  [/\b(csrutil|spctl|socketfilterfw|pfctl|launchctl|crontab|ssh-keygen|ssh-copy-id|visudo|installer)\b/, "security", "security.system-control", "This changes credentials, permissions, startup items or a system protection."],
  [/(^|[\s/'"=:~])\.(ssh|gnupg|aws|netrc|kube)\b|Keychains|\.zshrc|\.zprofile|\.bash_profile/, "security", "security.protected-place", "This touches keys, credentials or startup files."],
  [/Library\/(Mail|Messages|Safari|Cookies)\b|\b(logins\.json|key[34]\.db|cookies\.sqlite)\b|Login Data|Web Data|\/Cookies\b/, "security", "security.read-credentials", "This reads saved logins, cookies, mail or messages."],
  [/(^|[\s;&|(`])(nc|ncat|netcat|socat|telnet|sftp)\s|\b(scp|rsync)\b[^\n]*\s[^\s/:]+:|\bssh\s+[^-\s]/, "send", "send.network", "This sends data to another machine."],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^\n]*\s-g\b|--global\b|\bbrew\s+(install|upgrade)\b/, "security", "security.system-install", "This installs software outside the project."],
  [/\brm\s+-[a-zA-Z]*[rRf]/, "destruction", "destruction.delete-unproven-target", "This deletes files at a path that can't be checked ahead of time."],
  [/\bgit\s+[^\n]*\bpush\b[^\n]*(--force|-f\b)|\breset\s+--hard\b|\bfilter-(branch|repo)\b|\bgit\s+clean\s+-[a-zA-Z]*f/, "destruction", "destruction.discard-work", "This overwrites or discards work that can't be recovered."],
  [/\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, "destruction", "destruction.drop-database", "This drops or empties a database."],
  [/\bdiskutil\s+(erase|apfs\s+deleteVolume)|\bmkfs\b|\bempty\s+(the\s+)?trash\b/i, "destruction", "destruction.wipe-disk", "This erases a disk, volume or the Trash."],
  [/\b(mail|sendmail|mutt|msmtp)\b|\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH)|--data|-d\s)|\bgh\s+(pr|issue|gist|release)\s+(create|comment)/i, "send", "send.post", "This sends something a person receives."],
  [/app(lication)?\s+"Messages"/i, "send", "send.message", "This sends a message as you."],
  [/\/(checkout|billing|payment|purchase)(\/|\?|$)|stripe\.com|paypal\.com/i, "money", "money.checkout-page", "This touches a checkout, payment or billing page."],
];

function rawScan(text: string): FullAutoResult | null {
  for (const [re, category, rule, reason] of RAW) {
    if (re.test(text)) return { ask: true, category, rule, reason };
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

function toolAsk(action: string, args: Record<string, unknown>): FullAutoResult | null {
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
  if (action === "mcp") {
    const tool = snake(String(args.tool ?? ""));
    const server = snake(String(args.server ?? ""));
    if (/(^|_)(delete|destroy|purge|wipe)(_|$)/.test(tool)) return R("destruction", "delete-record", `“${server} ${tool}” deletes something of yours.`);
    if (/(^|_)(pay|purchase|checkout|charge|subscribe|invoice|refund)(_|$)/.test(tool)) return R("money", "purchase", `“${server} ${tool}” spends money.`);
    if (SEND_TOOL.test(tool)) return R("send", "post", `“${server} ${tool}” is seen by other people.`);
    return null;
  }
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
const liftedByNoLimits = (r: FullAutoResult): boolean => r.category === "send" || r.rule === "security.read-credentials";

function fullAutoAskAll(action: FullAutoAction, ctx: FullAutoContext): FullAutoResult {
  if (action.kind === "tool") return toolAsk(action.action, action.args ?? {}) ?? OK;
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
  const parse = parseShell(command, { cwd: action.cwd ?? ctx.workspaces[0] ?? ctx.home, home: ctx.home, vars: ctx.vars });
  let hit: FullAutoResult | null = null;
  const fdSafe = fdAliasesSafe(parse.cmds, parse.opaque.length > 0);
  for (const c of parse.cmds) {
    hit = securityForCommand(c, ctx) ?? destructionForCommand(c, ctx, fdSafe) ?? sendForCommand(c, command, ctx) ?? moneyForCommand(c);
    if (hit) return hit;
  }
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
