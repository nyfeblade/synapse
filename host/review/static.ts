import { createHash } from "node:crypto";
import { scrubTokenShapes } from "../secrets/token-shapes";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "shell-quote";
import { fastSegmentOk, fastValueOptions } from "./fast-flags";
import type { RiskTarget, StaticResult } from "./types";
import { optionWrites, tarAbsoluteExtract, writeTargets } from "./write-targets";

function loadCouriers(): Set<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "couriers.txt"), path.join(process.env.PROMPTS_DIR ?? here, "couriers.txt")]) {
    if (fs.existsSync(p)) return new Set(fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return new Set();
}
const COURIERS = loadCouriers();
const isCourier = (host: string) => [...COURIERS].some((c) => host === c || host.endsWith(`.${c}`));


/** Programs the analyzer models as reading (the fast path itself checks flags per program, fast-flags.ts). */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "echo", "printf", "date", "which", "type", "df", "du", "ps", "stat", "file", "jq", "yq", "tree", "env", "uname", "true", "cd", "id", "whoami", "groups"]);
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "remote"]);
/** git subcommands the analyzer models; any other one is not understood, so its words get the deleter scan. */
const GIT_KNOWN = new Set([...GIT_READ, "push", "fetch", "pull", "clone", "clean", "reset", "add", "commit", "init"]);
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "ftp", "sftp", "telnet", "http", "https"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "python", "python3", "node", "perl", "ruby", "deno", "bun"]);
export const SECRET_PATH = /(^|[\s@=/])(~?\/?[^\s]*\/)?(\.ssh\/|\.env(\.[\w-]+)?$|\.env\b|\.claude\/\.credentials|\/proc\/[^/\s]+\/environ|Cookies\b|Login Data\b|\/home\/box\/\.host\b)/;
/** Character/block devices whose reads are harmless. Any other /dev/* read exposes the raw disk or kernel memory. */
const BENIGN_DEVICE = new Set(["/dev/null", "/dev/zero", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/random", "/dev/urandom", "/dev/full"]);
const isSensitiveDevice = (a: string) => a.startsWith("/dev/") && !BENIGN_DEVICE.has(a) && !a.startsWith("/dev/fd/");

/**
 * speed-fastpath (#5, the user's ruling 2026-09-24): credential stores and secret files. Naming one in a command
 * (outside a search pattern or a printed word) is a credential read: never the fast path, and the gate always asks
 * (every permission mode). Mirrors the Full-auto classifier's lists (shared/src/full-auto.ts SECRET_DIRS/SECRET_FILE).
 */
export const CREDENTIAL_PATH = new RegExp([
  String.raw`(^|/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config/(gh|gcloud|hub|op|doctl|git/credentials)|Library/Keychains|\.local/share/keyrings)(/|$)`,
  String.raw`(^|/)(id_(rsa|dsa|ecdsa|ed25519|xmss)(\.pub)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|\.s3cfg|\.boto|credentials(\.json)?|secring\.gpg|[^/]*\.(pem|key|p12|pfx|keychain|keychain-db|kdbx|ppk|jks))$`,
  String.raw`(^|/)\.env(\.(?!(example|sample|template|dist)$)[\w-]+)?$`,
  String.raw`^/etc/(shadow|gshadow|sudoers)`, String.raw`^/proc/[^/]+/environ$`, String.raw`\.claude/\.credentials`,
  // Fix round 1: the system folders a fast read may open hold host keys and service tokens too.
  String.raw`^/etc/ssh(/|$)`, String.raw`^/(etc|opt)/.*(key|token|secret|passw|credential)[^/]*$`, String.raw`^/etc/ssl/private(/|$)`,
].join("|"), "i");
/** An environment variable whose name says it holds a secret (`echo $GITHUB_TOKEN`). */
const CREDENTIAL_VAR = /TOKEN|SECRET|PASSW|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION/i;
/** Commands that print or hand out stored credentials, or the whole environment. */
function credentialCommand(prog: string, args: string[]): boolean {
  const pos = args.filter((a) => !a.startsWith("-"));
  if (prog === "env" || prog === "printenv") return true; // a bare env (a wrapped command was unwrapped before this)
  if (["set", "export", "declare", "typeset"].includes(prog) && pos.length === 0 && (prog !== "set" || args.length === 0)) return true;
  if (prog === "gh" && args[0] === "auth") return true;
  if (prog === "git" && gitSub(args).sub === "credential") return true;
  if (prog === "security" && /^(find|dump|export)-/.test(args[0] ?? "")) return true;
  if (["secret-tool", "pass", "op", "keyring"].includes(prog) && /^(lookup|show|read|get|item)$/.test(args[0] ?? "")) return true;
  if (prog === "gcloud" && args[0] === "auth" && /print-(access|identity)-token/.test(args[1] ?? "")) return true;
  if (prog === "aws" && args[0] === "configure" && /^(get|list|export-credentials)$/.test(args[1] ?? "")) return true;
  if (prog === "npm" && args[0] === "token") return true;
  return false;
}

/**
 * Variable expansions outside single quotes (`$X`, `${X}`, `$1`, `$'…'`): the value is not bound to the review, so a
 * command with one is never the fast path.
 */
function expansions(command: string): boolean {
  let any = false;
  let q: "" | "'" | '"' = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (q === "'") { if (c === "'") q = ""; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "'" && q === "") { if (command[i - 1] === "$") any = true; q = "'"; continue; }
    if (c === '"') { q = q === '"' ? "" : '"'; continue; }
    if (c !== "$") continue;
    const rest = command.slice(i + 1);
    if (/^[A-Za-z_{(0-9@*#?!$-]/.test(rest)) any = true;
  }
  return any;
}

/** Programs whose arguments are printed or looked up, never opened as files. */
const NO_PATH_ARGS = new Set(["echo", "printf", "which", "type", "date", "uname", "id", "whoami", "groups", "pwd", "true", "cd", "ps", "false", ":"]);
/** find primaries whose value is a name pattern, a format or a number, not a file find opens. */
const FIND_NON_PATH = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-regextype", "-type", "-xtype", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-user", "-group", "-uid", "-gid", "-perm", "-links", "-inum", "-lname", "-ilname", "-used", "-printf"]);

/** Long options whose value is a FILE the program reads; every other option value is a pattern, format or number. */
const FILE_VALUE_LONG = new Set(["--file", "--exclude-from", "--ignore-file", "--files0-from", "--from-file", "--reference"]);
/** Short options whose value is a file the program reads (attached `-f/x` or separate `-f /x`). */
const FILE_VALUE_SHORT: Record<string, string> = { grep: "f", rg: "f" };

/**
 * The words of a read segment that may be opened as a file or folder: every positional word and every file-valued
 * option value (`--file=x`, `-f x`, `-f/x`), less the search pattern (grep/rg without -e/-f), the jq/yq filter and
 * find's name patterns. Option values are told apart by the fast path's own flag lists (fast-flags.ts); a value this
 * cannot place is kept as an operand. Over-inclusion only costs a model review; a word left out would be a read the
 * fast path never checked.
 */
function readOperands(prog: string, args: string[]): string[] {
  if (NO_PATH_ARGS.has(prog)) return [];
  const spec = fastValueOptions(prog);
  const fileShort = FILE_VALUE_SHORT[prog] ?? "";
  const searcher = prog === "grep" || prog === "rg";
  const out: string[] = [];
  const positionals: string[] = [];
  let patternGiven = false;
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (endOpts || a === "-" || !a.startsWith("-")) { positionals.push(a); continue; }
    if (a === "--") { endOpts = true; continue; }
    if (prog === "find" && FIND_NON_PATH.has(a)) { i++; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (searcher && (name === "--regexp" || name === "--file")) patternGiven = true;
      const takesNext = eq === -1 && !!spec && spec.longValue.includes(name) && !spec.long.includes(name);
      const v = eq !== -1 ? a.slice(eq + 1) : takesNext ? args[++i] : undefined;
      if (v !== undefined && FILE_VALUE_LONG.has(name)) out.push(v);
      continue;
    }
    if (spec?.numeric && /^-\d+$/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const c = a[k] as string;
      if (!spec?.shortValue.includes(c)) continue;
      const attached = a.slice(k + 1);
      const v = attached || args[++i];
      if (searcher && (c === "e" || c === "f")) patternGiven = true;
      if (v !== undefined && fileShort.includes(c)) out.push(v);
      break;
    }
  }
  const skip = (searcher && !patternGiven) || prog === "jq" || prog === "yq" ? 1 : 0;
  return [...out, ...positionals.slice(skip)];
}

/** `git show` / `git log -p` with no pathspec: the content of every committed file (secrets included). */
function gitHistoryContent(args: string[]): boolean {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const dash = rest.indexOf("--");
  const opts = dash === -1 ? rest : rest.slice(0, dash);
  const specs = dash === -1 ? [] : rest.slice(dash + 1);
  // Fix round 2: a pathspec that covers the whole repo (`.`, `:/`, `*`, a magic `:(…)` one, a glob) is no pathspec.
  const specific = specs.length > 0 && specs.every((p) => p !== "" && !/^(\.\/?|\/|:.*|\*.*)$/.test(p) && !/[*?[\]]/.test(p));
  if (specific || opts.some((a) => /^[^-][^:]*:./.test(a))) return false; // a path, or <rev>:<path> (checked for secrets)
  // Fix round 2: `git diff <rev>` prints the content of every file changed since that revision.
  if (sub === "diff") return opts.some((a) => !a.startsWith("-"));
  if (sub === "show") return !opts.some((a) => ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--no-patch", "--summary", "-s"].includes(a));
  if (sub === "log") return opts.some((a) => /^(-p|--patch|--patch-with-stat|--word-diff(=.*)?|-U\d*|--unified(=.*)?)$/.test(a) || (/^-[A-Za-z]*p/.test(a) && !a.startsWith("--")));
  return false;
}

/** Programs `xargs` may run on the fast path: they print or list the words they get, never open them as files. */
const XARGS_FAST = new Set(["echo", "printf", "ls"]);
/** Folders outside the workspace whose files are plain system reads (credential files among them are caught first). */
export const BENIGN_READ_ROOTS = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/opt/", "/etc/"];
export const BENIGN_READ_FILES = new Set(["/proc/cpuinfo", "/proc/meminfo", "/proc/version", "/proc/loadavg", "/proc/uptime"]);
export const SECURITY_PATH = /\/home\/box\/\.host|\.claude\/settings|\.claude\/hooks|autoReview/;
/**
 * Security re-review item 1c (ruling): git control files. A repo's config, hooks, attributes and submodule map
 * decide which programs git runs (fsmonitor, gpg.program, textconv/filter drivers, hooks), so a write to one is
 * security-control tampering (F8), never an ordinary workspace write. Also the user-level git config and a
 * `.git` file (a gitdir pointer to another config).
 * Fix round 1 (speed-fastpath): anything under `.git/`, a project `.npmrc`, `.husky/` and lint-staged configs too —
 * they decide what a fast `npm test` or `git commit` runs, so editing one is never an unreviewed edit.
 */
export const GIT_CONTROL_PATH = /(^|\/)\.git(\/.*)?$|(^|\/)\.git(attributes|modules)$|(^|\/)\.gitconfig$|(^|\/)\.config\/git\/(config|attributes)$|^\/etc\/gitconfig$|(^|\/)\.npmrc$|(^|\/)\.husky(\/.*)?$|(^|\/)(\.lintstagedrc(\..*)?|lint-staged\.config\.[cm]?[jt]s)$/;
const OPAQUE = /\$\(|`|\beval\b|(^|[;&|]\s*)(source|\.)\s|<<-?\s*['"]?\w+|[<>]\(/;
/** Control characters (tab aside) and Unicode spaces: bash and the parser may split words differently. */
const ODD_CHARS = /[\x00-\x08\x0a-\x1f\x7f\u0085\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/** §01.3 fail-closed parsing: shell grammar the analyzer does not model. */
const RESERVED = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "time", "coproc", "{", "}", "!", "[[", "(("]);

const TEMP_SEGMENT = new Set(["tmp", "temp", ".tmp"]);
const isTempPath = (p: string) => p.startsWith("/tmp/") || p.startsWith("/var/tmp/") || p.split("/").some((seg) => TEMP_SEGMENT.has(seg));
/** A root the analyzer can't resolve statically: a variable, ~, a glob or a brace expansion. */
const UNKNOWN_ROOT = /[$~*?[\]{}`]/;
const DELETERS = new Set(["rm", "shred", "dd", "truncate", "unlink", "rmdir"]);
const isDeleter = (prog: string) => DELETERS.has(prog) || /^mkfs(\.|$)/.test(prog);
/** Deleter options that take a separate value (so the value is not a root). */
const DELETER_VALUE_OPTS: Record<string, { short: string; long: string[] }> = {
  shred: { short: "ns", long: ["--iterations", "--size", "--random-source"] },
  truncate: { short: "sro", long: ["--size", "--reference", "--io-blocks"] },
};
/** Words that name a delete; any of them in a command the analyzer doesn't fully understand raises F4 (§01.3). */
const DELETER_WORDS = new Set(["rm", "rmdir", "shred", "unlink", "dd", "truncate", "rmtree", "rmSync", "rmdirSync", "unlinkSync", "rm_rf", "rm_r", "--remove-files"]);
/** Stands for targets that arrive on stdin (xargs): unknown, so never temp and never inside /workspace. */
const STDIN_TARGET = "$XARGS";
/** Stands for find's current file (`{}`) inside -exec: it expands to the find roots. */
const FIND_FILE = "{}";

/** The deleter-word scan: quote and escape removal, then any word (split on non-word characters) naming a delete. */
function namesDeleter(text: string): boolean {
  const words = text.replace(/[\\'"]/g, "").split(/[^A-Za-z0-9_+-]+/).filter(Boolean);
  const has = (w: string) => words.includes(w);
  return words.some((w) => DELETER_WORDS.has(w) || /^mkfs/.test(w)) ||
    (has("find") && words.some((w) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(w))) ||
    (has("git") && has("clean")) ||
    (has("rsync") && words.some((w) => /^--del/.test(w) || w === "--remove-source-files"));
}

interface WrapSpec { short: string; long: string[]; positional?: number }
/** Wrappers that run their argument as a command: value-taking short letters and long options, and fixed positionals. */
const WRAPPERS: Record<string, WrapSpec> = {
  sudo: { short: "ugphCUrtDRT", long: ["--user", "--group", "--host", "--prompt", "--close-from", "--other-user", "--role", "--type", "--chdir", "--chroot", "--command-timeout"] },
  doas: { short: "uC", long: [] },
  command: { short: "", long: [] }, busybox: { short: "", long: [] }, nohup: { short: "", long: [] }, setsid: { short: "", long: [] },
  unbuffer: { short: "", long: [] }, exec: { short: "a", long: [] }, time: { short: "fo", long: ["--format", "--output"] },
  env: { short: "uCS", long: ["--unset", "--chdir", "--split-string"] }, nice: { short: "n", long: ["--adjustment"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], positional: 1 },
  xargs: { short: "nIPLdEsa", long: ["--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace", "--max-lines", "--max-chars", "--eof"] },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  ionice: { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] },
  chrt: { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], positional: 1 },
  taskset: { short: "", long: [], positional: 1 },
  unshare: { short: "SGRwt", long: ["--setuid", "--setgid", "--root", "--wd", "--map-user", "--map-group", "--propagation", "--time", "--monotonic", "--boottime", "--setgroups"] },
  flock: { short: "wEc", long: ["--timeout", "--conflict-exit-code", "--command"], positional: 1 },
  chroot: { short: "", long: ["--userspec", "--groups"], positional: 1 },
};

interface Unwrapped { s: string[]; privilege: boolean; xargs: boolean; opaque: boolean; chdir?: string | null; jail: boolean; assign: boolean }

/**
 * Strips leading assignments, reserved words (§01.3 fail-closed: they make the command opaque) and wrappers
 * (`sudo`, `env`, `stdbuf`, `flock`, …) so the real program is analyzed. In a short-option cluster, the first
 * value-taking letter takes the rest of the cluster as its value, or the next argument when it is last.
 */
function unwrap(seg: string[]): Unwrapped {
  const u: Unwrapped = { s: seg, privilege: false, xargs: false, opaque: false, jail: false, assign: false };
  for (let n = 0; n < 16; n++) {
    while (/^\w+=/.test(u.s[0] ?? "")) { u.s = u.s.slice(1); u.assign = true; }
    const first = u.s[0] ?? "";
    if (RESERVED.has(first) && first !== "time") {
      u.opaque = true;
      u.s = u.s.slice(first === "function" ? 2 : 1);
      continue;
    }
    if (first === "time") u.opaque = true;
    const w = path.basename(first);
    const spec = WRAPPERS[w];
    if (!spec) break;
    const opt = (name: string, value?: string) => {
      if (w === "env" && (name === "-S" || name === "--split-string")) u.opaque = true;
      if (w === "flock" && (name === "-c" || name === "--command")) u.opaque = true;
      if ((w === "env" && (name === "-C" || name === "--chdir")) || (w === "sudo" && (name === "-D" || name === "--chdir")) || (w === "unshare" && (name === "-w" || name === "--wd"))) u.chdir = value ?? null;
      if ((w === "sudo" && (name === "-R" || name === "--chroot")) || (w === "unshare" && (name === "-R" || name === "--root"))) u.jail = true;
    };
    let i = 1;
    while (i < u.s.length) {
      const a = u.s[i] as string;
      if (a === "--") { i++; break; }
      if (!a.startsWith("-") || a === "-") break;
      if (w === "command" && (a === "-v" || a === "-V")) return u;
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        const name = eq === -1 ? a : a.slice(0, eq);
        if (eq === -1 && spec.long.includes(name)) { opt(name, u.s[i + 1]); i += 2; } else { opt(name, eq === -1 ? undefined : a.slice(eq + 1)); i++; }
        continue;
      }
      let step = 1;
      for (let k = 1; k < a.length; k++) {
        const c = a[k] as string;
        if (spec.short.includes(c)) {
          const attached = a.slice(k + 1);
          if (!attached) step = 2;
          opt(`-${c}`, attached || u.s[i + 1]);
          break;
        }
        opt(`-${c}`);
      }
      i += step;
    }
    if (w === "env") while (u.s[i] === "-" || /^\w+=/.test(u.s[i] ?? "")) { i++; u.assign = true; }
    if (w === "chroot" && u.s[i] !== undefined && u.s[i] !== "/") u.jail = true;
    i += spec.positional ?? 0;
    if (i >= u.s.length) break; // bare wrapper (`env`, `xargs`): analyze the wrapper itself
    if (w === "sudo" || w === "doas") u.privilege = true;
    if (w === "xargs") u.xargs = true;
    u.s = u.s.slice(i);
  }
  return u;
}

/** find's roots are every argument before the first expression token; leading -H/-L/-P are options. */
function findParts(args: string[]): { roots: string[]; follow: boolean; deletes: boolean; or: boolean; execs: { inner: string[]; dir: boolean }[] } {
  let i = 0;
  let follow = false;
  while (["-H", "-L", "-P"].includes(args[i] ?? "")) { if (args[i] === "-L") follow = true; i++; }
  const roots: string[] = [];
  while (i < args.length && !/^[-(!]/.test(args[i] as string)) roots.push(args[i++] as string);
  const expr = args.slice(i);
  if (expr.includes("-L") || expr.includes("-follow")) follow = true;
  const execs: { inner: string[]; dir: boolean }[] = [];
  expr.forEach((a, j) => {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(a)) return;
    const end = expr.findIndex((x, k) => k > j && (x === ";" || x === "+"));
    execs.push({ inner: expr.slice(j + 1, end === -1 ? undefined : end), dir: a.endsWith("dir") });
  });
  const or = expr.some((a) => a === "-o" || a === "-or" || a === ",");
  return { roots: roots.length ? roots : ["."], follow, deletes: expr.includes("-delete"), or, execs };
}

/** git's subcommand after global options (`-C dir`, `-c k=v`, `--git-dir x`, …). */
/** Item 1c: the config file a `git config` invocation writes, or null when it only reads. */
function gitConfigWriteTarget(rest: string[]): string | null {
  const VALUE_OPTS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);
  const WRITE_OPTS = /^--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)$|^-e$/;
  const READ_OPTS = /^--(get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list)$|^-l$/;
  let file = ".git/config";
  let write = false;
  let read = false;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--global") file = "~/.gitconfig";
    else if (a === "--system") file = "/etc/gitconfig";
    else if (a === "-f" || a === "--file") file = rest[++i] ?? file;
    else if (a.startsWith("--file=")) file = a.slice(7);
    else if (VALUE_OPTS.has(a)) i++;
    else if (WRITE_OPTS.test(a)) write = true;
    else if (READ_OPTS.test(a)) read = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  const sub = positionals[0] ?? "";
  if (["set", "unset", "rename-section", "remove-section", "edit"].includes(sub)) write = true;
  else if (["get", "list"].includes(sub)) read = true;
  else if (positionals.length >= 2 && !read) write = true;
  return write ? file : null;
}

function gitSub(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i] as string) ? 2 : 1;
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/** git clean deletes untracked dirs (-d) or ignored files (-x/-X) unless it is a dry run; -e/--exclude take a value. */
function gitCleanDestructive(rest: string[]): boolean {
  let dry = false;
  let dx = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") break;
    if (a === "--dry-run") dry = true;
    else if (a === "-e" || a === "--exclude") i++;
    else if (a.startsWith("--") || !a.startsWith("-")) continue;
    else for (let k = 1; k < a.length; k++) {
      const c = a[k] as string;
      if (c === "e") { if (k === a.length - 1) i++; break; }
      if (c === "n") dry = true;
      if (/[dx]/i.test(c)) dx = true;
    }
  }
  return dx && !dry;
}

/** Operands and the recursive flag of a deleter; operands after `--` are roots even when they start with `-`. */
function deleterOperands(prog: string, args: string[]): { roots: string[]; recursive: boolean } {
  if (prog === "dd") return { roots: args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)), recursive: false };
  const vals = DELETER_VALUE_OPTS[prog] ?? { short: "", long: [] };
  const roots: string[] = [];
  let recursive = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!opts || a === "-" || !a.startsWith("-")) { roots.push(a); continue; }
    if (a === "--") { opts = false; continue; }
    if (a.startsWith("--")) {
      if (prog === "rm" && a === "--recursive") recursive = true;
      if (!a.includes("=") && vals.long.includes(a)) i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k] as string;
      if (vals.short.includes(c)) { if (k === a.length - 1) i++; break; }
      if (prog === "rm" && (c === "r" || c === "R")) recursive = true;
    }
  }
  return { roots, recursive };
}

type Tok = string | { op: string; pattern?: string } | { comment: string };

/**
 * Splits the raw command on unquoted newlines and CRs (each is a command separator in bash), dropping `#` comments
 * the way bash does (only at the start of a word). A `#` inside a word is reported: shell-quote would read it as a
 * comment and hide the rest of the line.
 */
function splitLines(command: string): { lines: string[]; midHash: boolean } {
  const lines: string[] = [];
  let cur = "";
  let q: "" | "'" | '"' | "$'" = "";
  let midHash = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (q === "'") { cur += c; if (c === "'") q = ""; continue; }
    if (q) {
      if (c === "\\") { cur += c + (command[i + 1] ?? ""); i++; continue; }
      cur += c;
      if ((q === '"' && c === '"') || (q === "$'" && c === "'")) q = "";
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") { i++; continue; } // line continuation
      cur += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") { lines.push(cur); cur = ""; continue; }
    if (c === "#") {
      if (cur === "" || /[\s;&|()<>]$/.test(cur)) { while (i + 1 < command.length && command[i + 1] !== "\n" && command[i + 1] !== "\r") i++; continue; }
      midHash = true;
    }
    if (c === "'") q = cur.endsWith("$") ? "$'" : "'";
    if (c === '"') q = '"';
    cur += c;
  }
  lines.push(cur);
  return { lines, midHash };
}

function hostsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:https?|ftp|ssh|git):\/\/([^/\s:'"]+)/g)) out.push((m[1] as string).toLowerCase());
  for (const m of text.matchAll(/\b[\w.-]+@([\w.-]+\.[a-z]{2,}):/g)) out.push((m[1] as string).toLowerCase());
  return out;
}

/** Programs whose arguments the analyzer models; any other program's words get the deleter scan. */
const MODELED = new Set([...READ_ONLY, ...DELETERS, ...NETWORK, "find", "git", "cp", "mv", "tee", "sed", "touch", "mkdir", "chmod", "chown", "npm", "pnpm", "yarn", "npx", "pip", "pip3", "apt", "apt-get", "brew", "vercel", "gh", "mail", "sendmail", "mutt", "printenv", "[", "test", ":", "false", "pushd", "popd", "xargs"]);

/**
 * `scopeReads` (speed-fastpath; the box gate passes true): a read is fast only when every file or folder it opens is
 * inside the workspace or a plain system folder (BENIGN_READ_ROOTS), resolved against a known cwd. The Mac floor
 * (mac-floor.ts) runs this analyzer on a stand-in workspace and keeps its own read rules, so it is off by default.
 */
export function analyzeShell(command: string, o: { workspace: string; cwd?: string; scopeReads?: boolean; readPaths?: string[]; gitReads?: string[] }): StaticResult {
  const ws = o.workspace;
  const signals = new Set<string>();
  const floor = new Set<string>();
  // §01.3 fail-closed parsing: structural opacity makes the whole raw command subject to the deleter-word scan.
  let opaque = OPAQUE.test(command) || ODD_CHARS.test(command);
  // speed-fastpath: a variable's value is not bound to the review, so a command that expands one is never fast.
  if (expansions(command)) signals.add("expands_var");
  let unresolvedWrite = false;
  const { lines, midHash } = splitLines(command);
  if (midHash) opaque = true;
  const tokens: Tok[] = [];
  for (const [n, line] of lines.entries()) {
    if (n > 0) tokens.push({ op: ";" });
    try {
      tokens.push(...(parse(line, (k) => `$${k}`) as Tok[]));
    } catch {
      opaque = true;
    }
  }
  const segments: string[][] = [[]];
  const ops: string[] = [];
  let redirectNext = false;
  const redirects: { seg: number; target: string }[] = [];
  let prevOp = "";
  for (const t of tokens) {
    const cur = segments[segments.length - 1] as string[];
    if (typeof t === "object" && "op" in t && t.op === "glob") {
      // shell-quote returns an unquoted glob as {op:"glob", pattern}; it is an argument, not a separator.
      cur.push(t.pattern ?? "*");
      prevOp = "";
      continue;
    }
    if (typeof t === "object" && "op" in t) {
      const op = t.op;
      if (op === "|" && prevOp === ">") { prevOp = ""; continue; } // `>|` is one redirect
      if (op === "(" && (cur.length > 0 || prevOp === "(")) opaque = true; // function definition or `((`
      if (op === "<(" || op === ">(") opaque = true;
      prevOp = op;
      if (op === ">" || op === ">>" || op === ">&" || op === "<" || op === "<<<") {
        if (op !== "<" && op !== "<<<") redirectNext = true;
        continue;
      }
      ops.push(op);
      segments.push([]);
      continue;
    }
    prevOp = "";
    if (typeof t !== "string") continue;
    if (redirectNext) {
      redirectNext = false;
      if (!/^\d$/.test(t) && t !== "/dev/null") {
        signals.add(`writes:${t}`);
        redirects.push({ seg: segments.length - 1, target: t });
      }
      continue;
    }
    cur.push(t);
  }

  /** texts: the textual directories the segment may run in (`~/.claude`, `/workspace/x`), kept even when cwd is unknown (item 2). */
  type Ctx = { cwd: string | null; jail: boolean; findRoots?: string[]; follow?: boolean; texts?: string[] };
  /** Item 2: every write/delete with the directory it happens in, judged for F8 after the walk. */
  const writeChecks: { p: string; cwd: string | null; texts: string[]; jail: boolean }[] = [];
  const noteWrite = (kind: "writes" | "deletes", p: string, c: Ctx) => {
    signals.add(`${kind}:${p}`);
    writeChecks.push({ p, cwd: c.cwd, texts: c.texts ?? [], jail: c.jail });
  };
  const joinText = (base: string, rel: string) => path.posix.normalize(rel.startsWith("/") || rel.startsWith("~") ? rel : `${base}/${rel}`);
  let lastCdArg: string | undefined;
  /** Resolves a root against the cwd; null when it can't be known statically (a variable, ~, unknown cwd, chroot). */
  const resolveRoot = (p: string, c: Ctx): string | null => {
    if (c.jail || p.startsWith("~") || p.includes("$") || p.includes("`")) return null;
    if (!p.startsWith("/") && c.cwd === null) return null;
    return path.resolve(c.cwd ?? ws, p);
  };
  // `~`, variables and an unknown cwd never resolve under /workspace: they point wherever the shell says.
  const insideWs = (p: string, c: Ctx) => {
    const r = resolveRoot(p, c);
    return r !== null && (r === ws || r.startsWith(`${ws}/`));
  };
  /** §01.3 F4 temp exemption. Unknown roots are never temp, nor is a root ending in `/` or `/.` (symlink follow). */
  const isTempRoot = (p: string, c: Ctx) => {
    const r = resolveRoot(p, c);
    return r !== null && !UNKNOWN_ROOT.test(p) && !/\/\.?$/.test(p) && isTempPath(r);
  };

  /** speed-fastpath: where a fast read may open files — the workspace or a plain system folder, from a known cwd. */
  const scopeOk = (abs: string) => abs === ws || abs.startsWith(`${ws}/`) || BENIGN_READ_FILES.has(abs) || BENIGN_DEVICE.has(abs) || (BENIGN_READ_ROOTS.some((r) => abs.startsWith(r)) && !/[*?[\]{}]/.test(abs));
  const readScopeOk = (prog: string, args: string[], c: Ctx): boolean => {
    if (c.jail) return false;
    // Recursive reads that follow symlinks can leave the workspace through a link the path check never sees.
    if ((prog === "grep" && args.some((a) => /^-[A-Za-z]*R/.test(a) || a === "--dereference-recursive"))
      || (prog === "rg" && args.some((a) => /^-[A-Za-z]*L/.test(a) || a === "--follow"))
      || (prog === "find" && args.some((a) => a === "-L" || a === "-follow"))
      || ((prog === "ls" || prog === "du") && args.some((a) => /^-[A-Za-z]*L/.test(a) || a === "--dereference"))
      || (prog === "tree" && args.some((a) => /^-[A-Za-z]*l/.test(a)))) return false;
    if (NO_PATH_ARGS.has(prog)) return true;
    if (c.cwd === null || !scopeOk(c.cwd)) return false; // the program may read its cwd
    const operands = readOperands(prog, args);
    // With no operand (ls, grep -r, find, du, tree) or for git (the whole repo), the cwd itself is what is read.
    if (!operands.length || prog === "git") o.readPaths?.push(c.cwd);
    // Fix round 2: a git read runs the repo's config (fsmonitor, textconv…) and hooks; the gate checks that repo.
    if (prog === "git") o.gitReads?.push(c.cwd);
    // Fix round 1: git's whole-history content (`git show`, `git log -p` with no pathspec) prints every file that
    // was ever committed, secrets included: not fast (`git show HEAD:src/a.ts`, `git log -p -- src/a.ts` still are).
    if (prog === "git" && gitHistoryContent(args)) return false;
    for (const v of operands) {
      if (v === "-" || BENIGN_DEVICE.has(v)) continue;
      if (v.startsWith("~")) return false;
      // Fix round 1: the kernel resolves `link/../x` through the link, so no `..` in a read operand; and a glob could
      // match a link out of the workspace, so none of those either (the model reviews them).
      if (v.split("/").includes("..") || /[*?[\]{}]/.test(v)) return false;
      const abs = path.resolve(c.cwd, v);
      if (!scopeOk(abs)) return false;
      o.readPaths?.push(abs);
    }
    return true;
  };

  let allReadOnly = true;
  let sawNetwork = false;
  let prevWasNetworkOrEnv = false;
  let segCount = 0;
  let scanSegments: string[][] = [];

  const analyzeSeg = (seg: string[], i: number, ctx: Ctx): string | null | undefined => {
    const u = unwrap(seg);
    if (u.privilege) signals.add("privilege");
    if (u.opaque) opaque = true;
    const c: Ctx = { ...ctx, jail: ctx.jail || u.jail };
    if (u.chdir !== undefined) {
      c.cwd = u.chdir === null || UNKNOWN_ROOT.test(u.chdir) ? null : resolveRoot(u.chdir, ctx);
      c.texts = u.chdir === null ? [] : (ctx.texts ?? []).map((t) => joinText(t, u.chdir as string));
    }
    // Redirects are opened by the shell in the segment's starting directory.
    if (i >= 0) for (const r of redirects) if (r.seg === i) writeChecks.push({ p: r.target, cwd: ctx.cwd, texts: ctx.texts ?? [], jail: ctx.jail });
    const s = u.s;
    const raw = s[0] ?? "";
    if (!raw) return undefined;
    // A program name the shell computes ($, backtick, glob, brace) is opaque (§01.3 fail-closed parsing).
    if (/[$`*?{}]/.test(raw) || (raw.includes("[") && raw !== "[")) opaque = true;
    const prog = path.basename(raw);
    const args = s.slice(1);
    const joined = s.join(" ");
    const pipedFrom = i > 0 ? ops[i - 1] : undefined;
    const git = prog === "git" ? gitSub(args) : { sub: "", rest: [] };
    if (!MODELED.has(prog) && !isDeleter(prog) || (prog === "git" && !GIT_KNOWN.has(git.sub))) scanSegments.push(s);
    if (INTERPRETERS.has(prog) && args.some((a) => /^-[a-zA-Z]*[ceErp]$/.test(a) || a === "--eval" || a === "--print")) opaque = true;
    if (NETWORK.has(prog) || (prog === "git" && ["push", "fetch", "pull", "clone"].includes(git.sub))) {
      sawNetwork = true;
      const hosts = hostsIn(joined);
      for (const h of hosts) signals.add(`network_egress:${h}`);
      if (!hosts.length) signals.add(`network_egress:${prog === "git" ? "git-remote" : "unknown"}`);
      for (const h of hosts) if (isCourier(h)) {
        signals.add(`courier:${h}`);
        floor.add("F9");
      }
      if (pipedFrom === "|" && prevWasNetworkOrEnv) floor.add("F7");
    }
    if ((prog === "env" || prog === "printenv") && ops[i] === "|") prevWasNetworkOrEnv = true;
    if (INTERPRETERS.has(prog) && pipedFrom === "|") signals.add("pipe_to_shell");
    if (SECRET_PATH.test(` ${joined}`)) signals.add("reads_secret_path");
    // speed-fastpath #5: a credential store or secret file named anywhere a program may open it, or a command that
    // prints stored credentials or the environment. Printed words (echo) and search patterns are not opened.
    const credWords = NO_PATH_ARGS.has(prog) ? [] : ["grep", "rg", "jq", "yq", "find"].includes(prog) ? readOperands(prog, args) : args.flatMap((a) => (a.startsWith("--") && a.includes("=") ? [a, a.slice(a.indexOf("=") + 1)] : [a]));
    // Fix round 1: git's `<rev>:<path>` (show, cat-file, archive) reads that path from history.
    if (prog === "git") credWords.push(...args.filter((a) => /^[^-][^:]*:./.test(a)).map((a) => a.slice(a.indexOf(":") + 1)));
    const credHit = (a: string) => CREDENTIAL_PATH.test(a) || (!a.startsWith("-") && [c.cwd ?? ".", ...(c.texts ?? [])].some((base) => CREDENTIAL_PATH.test(joinText(base, a))));
    const inCredDir = !NO_PATH_ARGS.has(prog) && [c.cwd, ...(c.texts ?? [])].some((b) => !!b && CREDENTIAL_PATH.test(b));
    // Printing a variable named like a secret (`echo $GITHUB_TOKEN`) shows it; USING one (`curl -H "…$TOKEN" …`) is the
    // network review's business, not a read.
    const printsSecretVar = (prog === "echo" || prog === "printf") && args.some((a) => [...a.matchAll(/\$\{?#?([A-Za-z_]\w*)/g)].some((m) => CREDENTIAL_VAR.test(m[1] as string)));
    if (credWords.some(credHit) || inCredDir || printsSecretVar || credentialCommand(prog, args)) signals.add("reads_credentials");
    // Reading a raw device (cat /dev/sda, head -c /dev/mem) bypasses the workspace read model; treat it as a secret read.
    if (s.some((a) => isSensitiveDevice(a))) signals.add("reads_secret_path");
    const find = prog === "find" ? findParts(args) : null;
    /** §01.3 F4: a delete outside /workspace, or a recursive delete of a non-temp folder even inside it. */
    const checkDelete = (roots: string[], recursive: boolean, forceNonTemp: boolean) => {
      for (const a of roots) noteWrite("deletes", a, c);
      if (roots.some((a) => !insideWs(a, c))) floor.add("F4");
      if (recursive && (forceNonTemp || roots.some((a) => !isTempRoot(a, c)))) floor.add("F4");
    };
    if (isDeleter(prog)) {
      const d = deleterOperands(prog, args);
      // Inside find -exec, `{}` is each found file: the delete covers the find roots, recursively.
      const roots = d.roots.flatMap((a) => (ctx.findRoots && a.includes(FIND_FILE) ? ctx.findRoots : [a]));
      if (u.xargs) roots.push(STDIN_TARGET);
      const viaFind = !!ctx.findRoots && d.roots.some((a) => a.includes(FIND_FILE));
      if (roots.length) checkDelete(roots, d.recursive || viaFind, viaFind && !!ctx.follow);
    }
    if (find) {
      const deleting = find.deletes || find.execs.length > 0;
      if (find.deletes) checkDelete(find.roots, true, find.follow || find.or);
      else if (deleting && find.or) floor.add("F4");
      // Each -exec/-execdir/-ok command is analyzed as its own segment; -execdir runs in an unknown directory.
      for (const e of find.execs) analyzeSeg(e.inner, -1, { cwd: e.dir ? null : c.cwd, jail: c.jail, findRoots: find.roots, follow: find.follow || find.or });
    }
    if (prog === "git" && git.sub === "clean" && gitCleanDestructive(git.rest)) floor.add("F4");
    if (prog === "rsync" && args.some((a) => /^--del(ete[\w-]*)?$/.test(a) || a === "--remove-source-files")) floor.add("F4");
    if (prog === "tee" || (prog === "sed" && args.some((a) => a.startsWith("-i") || a.startsWith("--in-place"))) || ["cp", "mv", "touch", "mkdir", "ln", "install"].includes(prog)) {
      const pos = args.filter((a) => !a.startsWith("-"));
      // speed-fastpath (security probe): tee, touch and mkdir write EVERY operand, sed -i every file after its
      // script; cp/mv/ln/install write their last operand (option-carried targets come from writeTargets below).
      const script = prog === "sed" && !args.some((a) => /^-[A-Za-z]*[ef]/.test(a) || /^--(expression|file)(=|$)/.test(a));
      const dests = prog === "tee" || prog === "touch" || prog === "mkdir" ? pos : prog === "sed" ? pos.slice(script ? 1 : 0) : prog === "ln" && pos.length === 1 ? ["."] : pos.slice(-1);
      for (const d of dests) noteWrite("writes", d, c);
    }
    if (optionWrites(prog, args).unresolved || (prog === "tar" && tarAbsoluteExtract(args))) {
      signals.add("unresolved_write_target");
      unresolvedWrite = true;
    }
    if ((prog === "chmod" || prog === "chown") && args.some((a) => !a.startsWith("-") && a.startsWith("/") && !insideWs(a, c))) signals.add("privilege");
    if ((prog === "npm" || prog === "pnpm" || prog === "yarn") && ["i", "install", "add"].includes(args[0] ?? "")) signals.add("package_install");
    if ((prog === "pip" || prog === "pip3") && args[0] === "install") signals.add("package_install");
    if ((prog === "apt" || prog === "apt-get" || prog === "brew") && args[0] === "install") signals.add("package_install");
    if (prog === "npm" && args[0] === "publish") floor.add("F2");
    if (prog === "vercel" && args.includes("--prod")) floor.add("F2");
    if (prog === "gh" && args[0] === "repo" && args[1] === "edit" && args.includes("public")) floor.add("F2");
    if (prog === "git" && git.sub === "push" && args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force")) && args.some((a) => /^(main|master)$/.test(a))) floor.add("F4");
    if (prog === "git" && git.sub === "reset" && args.includes("--hard")) floor.add("F4");
    if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i.test(joined)) floor.add("F4");
    if (["mail", "sendmail", "mutt"].includes(prog)) floor.add("F1");
    // Writes a program makes through its own options; outside /workspace they get the overwrite floor (F4).
    if (prog === "git" && git.sub === "config") {
      const target = gitConfigWriteTarget(git.rest);
      if (target) noteWrite("writes", target, c);
    }
    for (const t of writeTargets(prog, args)) {
      noteWrite("writes", t, c);
      if (!insideWs(t, c)) floor.add("F4");
    }
    // Fast path: a per-program FLAG allowlist, and no leading assignment (LESSOPEN, GIT_EXTERNAL_DIFF, … run programs).
    let readOnly = !u.assign && (fastSegmentOk(prog, args) ||
      ((prog === "node" || prog === "python3") && args.length === 1 && /^--?(v|version)$/.test(args[0] ?? "")));
    // speed-fastpath: xargs feeds unknown words from stdin; only programs that print or list them stay fast
    // (`xargs cat` would open whatever a find printed: `find ~ -name id_rsa | xargs cat`).
    if (readOnly && u.xargs && !XARGS_FAST.has(prog)) readOnly = false;
    if (readOnly && o.scopeReads && !readScopeOk(prog, args, c)) {
      signals.add("reads_outside_workspace");
      readOnly = false;
    }
    if (!readOnly) allReadOnly = false;
    // cd/pushd: the new directory, null when not a literal path (`cd`, `cd ~`, `cd $X`, `cd -`).
    if (prog === "cd" || prog === "pushd") {
      const t = args.find((a) => !/^-[LPe@]+$/.test(a));
      lastCdArg = t === undefined ? "~" : t;
      return t === undefined || t === "-" || UNKNOWN_ROOT.test(t) ? null : resolveRoot(t, c);
    }
    if (prog === "popd") { lastCdArg = "-"; return null; }
    return undefined;
  };

  let cwd: string | null = o.cwd ?? ws; // I2: relative paths resolve against the Shell's real cwd
  let texts: string[] = [cwd];
  segments.forEach((seg, i) => {
    if (seg.length) segCount++;
    lastCdArg = undefined;
    const next = analyzeSeg(seg, i, { cwd, jail: false, texts });
    // A cd applies to what follows only through `&&`; after `;`, `||` or `|` it may or may not have happened.
    if (next !== undefined) {
      cwd = ops[i] === "&&" || next === cwd ? next : null;
      // Item 2: the textual candidates (`cd ~/.claude` stays "~/.claude"); `cd -`/`popd` add none.
      const arg = lastCdArg as string | undefined;
      const moved = arg === undefined || arg === "-" || arg.includes("$") || arg.includes("`") ? [] : texts.map((t) => joinText(t, arg)).filter((t, k, all) => all.indexOf(t) === k);
      texts = ops[i] === "&&" ? moved : [...new Set([...texts, ...moved])];
    }
  });
  if (opaque) {
    signals.add("opaque");
    scanSegments = [];
    if (namesDeleter(command)) floor.add("F4");
  }
  for (const s of scanSegments) if (namesDeleter(s.join(" "))) floor.add("F4");
  // I2 + item 2: a relative path is judged where that segment really runs (`cd ~/.claude && touch settings.json`),
  // against the resolved cwd and every textual candidate. A relative write in a directory the analyzer can't
  // know is at least tier 2, so the model reviewer always sees it.
  let unknownRelWrite = false;
  for (const w of writeChecks) {
    const relative = !w.p.startsWith("/") && !w.p.startsWith("~");
    const cands = [w.p];
    if (relative && w.cwd && !w.jail) cands.push(path.resolve(w.cwd, w.p));
    if (relative) cands.push(...w.texts.map((t) => joinText(t, w.p)));
    if (relative && (w.cwd === null || w.jail)) unknownRelWrite = true;
    if (cands.some((x) => SECURITY_PATH.test(x) || GIT_CONTROL_PATH.test(x))) floor.add("F8");
  }
  if (o.cwd && SECRET_PATH.test(` ${o.cwd}/`)) signals.add("reads_secret_path"); // running inside a secret dir (e.g. ~/.ssh)
  if ((signals.has("reads_secret_path") || signals.has("reads_credentials")) && (sawNetwork || /\/home\/box\/\.host/.test(command))) floor.add("F7");
  if (/\/home\/box\/\.host/.test(command)) floor.add("F7");
  const mutating = [...signals].some((s) => /^(writes|deletes|network_egress|courier):/.test(s) || ["opaque", "reads_secret_path", "privilege", "package_install", "pipe_to_shell",
    "reads_credentials", "expands_var", "reads_outside_workspace", "unresolved_write_target"].includes(s));
  const readOnly = allReadOnly && !mutating;
  const hits = [...floor];
  let tier: StaticResult["tierHint"] = readOnly ? 0 : 1;
  if (sawNetwork || signals.has("privilege") || unknownRelWrite || unresolvedWrite) tier = 2;
  if (hits.some((f) => ["F1", "F2", "F3", "F4", "F5", "F6", "F10"].includes(f)) || signals.has("pipe_to_shell")) tier = 3;
  if (hits.some((f) => ["F7", "F8", "F9"].includes(f))) tier = 4;
  return { tierHint: tier, signals: [...signals], floorHits: hits, readOnly, segments: segCount };
}


/** APR-06: bind the executable content a command will run, so a changed script invalidates the review. */
/** Bug 231 round 3: `scrub` (the Bot's redaction + credential shapes) runs on the FULL text before its head is cut, so a
 *  secret split at the cut is never half-shown; the hash still pins the raw text. Default: the credential shapes. */
export function enrichShell(command: string, o: { cwd: string; readFile(p: string): string | null; scrub?(text: string): string }): { enrichment: RiskTarget["enrichment"]; unbound: boolean; extraSignals: string[] } {
  // Bug 71 security review: the full sha256 of each body (never a 64-bit prefix).
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const scrub = o.scrub ?? scrubTokenShapes;
  const signalsFor = (text: string) => {
    const out = hostsIn(text).map((h) => `network_egress:${h}`);
    for (const m of text.matchAll(/https?:\/\/(\d+\.\d+\.\d+\.\d+)/g)) out.push(`network_egress:${m[1]}`);
    if (SECRET_PATH.test(` ${text}`)) out.push("reads_secret_path");
    return [...new Set(out)];
  };
  /** Bug 71 security review: each script's head is cut on its own, visibly, so one padded script can't push another
   *  out of the reviewer's view. The full text is scrubbed before the cut (bug 231 round 3); signals come from all of it. */
  const headOf = (text: string) => {
    const clean = scrub(text);
    return clean.length > HEAD_MAX ? `${clean.slice(0, HEAD_MAX)}\n[cut: ${clean.length - HEAD_MAX} more chars]` : clean;
  };
  const UNBOUND = { enrichment: null, unbound: true, extraSignals: [] };
  const NONE = { enrichment: null, unbound: false, extraSignals: [] };
  // Bug 71: every command of a chain or pipeline is bound, not only the first (`pwd && npm test`, `npm test 2>&1 | tail`).
  const parts = scriptCommands(command, o.cwd);
  // Fail closed: a command the splitter can't read that names a script anywhere is unbound (the reviewer can't see it).
  if (parts === null) return SCRIPTISH.test(command) || RUNNERISH.test(command) ? UNBOUND : NONE;
  // Command substitution or a construct the static pass can't follow, around anything that runs code: its inner
  // script is invisible here, so it is unbound rather than "nothing to bind".
  if ((/\$\(|`|[<>]\(/.test(command) || parts.some((p) => p.opaque)) && RUNNERISH.test(command)) return UNBOUND;
  // npm reads npm_config_* (any case) as settings, prefix and workspace included.
  if (NPM_CONFIG_ENV.test(command)) return UNBOUND;
  const bound: { file: string; hash: string; head: string; signals: string[]; label: string }[] = [];
  for (const { words, cwd, opaque } of parts) {
    if (opaque) return UNBOUND; // bash -c / sh -c / eval / source / env -S: the script it runs is a string, not a file
    const prog = path.basename(words[0] ?? "");
    if (prog === "make" || prog === "gmake") return UNBOUND; // a Makefile target runs recipes (and includes) the pass can't bind
    if (nodeRunsPkgCli(words)) return UNBOUND; // `node …/node_modules/npm/bin/npm-cli.js run x`: a package manager by another name
    const pm = pkgManager(words);
    if (pm === "unfollowed") return UNBOUND; // pnpx, bunx, bun, deno, corepack <other>: not followed exactly
    if (prog === "npx") {
      // Only a dev tool the work tree already has (the dev fast path checks the local binary and its config), with its
      // default config; anything else npx runs is a package or config the reviewer can't see.
      if (npxDevOk(words)) continue;
      return UNBOUND;
    }
    if (pm) {
      const args = pm.args;
      const dd = args.indexOf("--");
      // A location or workspace flag anywhere before `--` moves which package.json (or how many) runs.
      if ((dd === -1 ? args : args.slice(0, dd)).some((a) => PKG_LOCATION_FLAG.test(a))) return UNBOUND;
      if (args[0] === "workspace" || args[0] === "workspaces") return UNBOUND;
      if ((args[0] ?? "").startsWith("-")) {
        if (args.every((w) => w.startsWith("-"))) continue; // `npm --version`: no script
        return UNBOUND; // a flag before the script name: fail closed
      }
      const isRun = args[0] === "run" || args[0] === "run-script";
      // Only the verb itself is an install: an explicit `npm run install` (or i, ci, add, publish) runs that script.
      if (!isRun && ["install", "i", "add", "publish", "ci"].includes(args[0] ?? "")) continue;
      if (!isRun && PKG_NOT_A_SCRIPT.has(args[0] ?? "")) return UNBOUND; // exec, dlx, r, t, …: not bound exactly
      const name = isRun ? args[1] : args[0];
      if (name === undefined) continue; // `npm run` lists the scripts
      if (!/^[\w:.-]+$/.test(name)) return UNBOUND;
      if (cwd === null) return UNBOUND; // a cd that may or may not have happened: which package.json runs is unknown
      const pkgFile = path.join(cwd, "package.json");
      let scripts: Record<string, unknown> | undefined;
      try { const raw = o.readFile(pkgFile); scripts = raw ? (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts : undefined; } catch { scripts = undefined; }
      const found = scripts ? packageScripts(scripts, name) : null;
      if (!found) return UNBOUND;
      for (const b of found.bodies) bound.push({ file: pkgFile, label: `${pkgFile} scripts.${b.name}`, hash: hash(`${b.name}\0${b.body}`), head: headOf(b.body), signals: signalsFor(b.body) });
      // Round 3: the script files those bodies run are bound and pinned like a top-level script (npm runs them in the
      // package's folder); one that can't be read is unbound.
      for (const rel of found.files) {
        const file = path.resolve(cwd, rel);
        const text = o.readFile(file);
        if (text === null) return UNBOUND;
        bound.push({ file, label: file, hash: hash(text), head: headOf(text), signals: signalsFor(scrub(text)) });
      }
      continue;
    }
    const rel = scriptFileOf(words);
    if (rel !== null) {
      if (cwd === null && !rel.startsWith("/")) return UNBOUND;
      const file = path.resolve(cwd ?? "/", rel);
      const text = o.readFile(file);
      if (text === null) return UNBOUND;
      bound.push({ file, label: file, hash: hash(text), head: headOf(text), signals: signalsFor(scrub(text)) });
    }
  }
  if (bound.length === 0) return NONE;
  if (bound.length === 1) {
    const b = bound[0] as (typeof bound)[number];
    return { enrichment: { file: b.file, hash: b.hash, head: b.head }, unbound: false, extraSignals: b.signals };
  }
  // Several scripts: the reviewer sees each one's head under its name, and the hash pins all of them (in order). If
  // even the capped heads don't fit, the command is unbound: a pinned script is never hidden from the reviewer.
  const head = bound.map((b) => `# ${b.label}\n${b.head}`).join("\n\n");
  if (head.length > HEADS_TOTAL_MAX) return UNBOUND;
  return {
    enrichment: {
      file: [...new Set(bound.map((b) => b.file))].join(", "),
      hash: hash(bound.map((b) => `${b.label}\0${b.hash}`).join("\n")),
      head,
    },
    unbound: false,
    extraSignals: [...new Set(bound.flatMap((b) => b.signals))],
  };
}

/** Bug 71 security review: one script's shown head, and every head together. */
const HEAD_MAX = 4000;
const HEADS_TOTAL_MAX = 16_000;
/** npm/pnpm/yarn flags that change which package.json (or how many) a script comes from. */
const PKG_LOCATION_FLAG = /^(?:--(?:prefix|workspaces?|ws|dir|cwd|filter|recursive|include-workspace-root)(?:=.*)?|-[wCFr].*)$/;
const NESTED_MAX_DEPTH = 3;
const NPM_CONFIG_ENV = /\bnpm_config_/i;
/** Package-manager verbs that are not a package.json script (or not one the pass binds exactly). */
const PKG_NOT_A_SCRIPT = new Set(["exec", "x", "dlx", "create", "init", "r", "rm", "t", "tst", "explore", "rebuild", "link", "pack", "run-p", "run-s"]);
/** Every token in a script body that runs code the pass would have to follow. */
const BODY_RUNNER = /(?<![\w.-])(?:npm|pnpm|yarn|yarnpkg|corepack|npx|pnpx|bunx|make|gmake|eval|source|exec|run-s|run-p|lerna|turbo|nx|bun|deno)(?!\w)/g;

const VITEST_MOVE_FLAG = /^(?:--(?:config|root|dir|workspace|project)(?:=.*)?|-[cr].*)$/;
const JEST_MOVE_FLAG = /^(?:--(?:config|rootDir|roots|projects|selectProjects)(?:=.*)?|-c.*)$/;
/** A package manager's own CLI run through node (npm-cli.js, yarn's release bundle, corepack): unbound. */
const NODE_PM_CLI = /(?:^|\/)node_modules\/(?:npm|yarn|pnpm|corepack|@yarnpkg|bun)\/|(?:^|\/)(?:npm|npx|yarn|yarnpkg|pnpm|pnpx|corepack)(?:-cli)?\.[cm]?js$|\/bin\/(?:npm|npx|yarn|pnpm|pnpx|corepack)(?:\.[cm]?js)?$|(?:^|\/)yarn-[\w.-]+\.[cm]?js$/;
function nodeRunsPkgCli(words: string[]): boolean {
  return /^(?:node|nodejs)$/.test(path.basename(words[0] ?? "")) && words.slice(1).some((a) => NODE_PM_CLI.test(a));
}
/** Programs that run package scripts or packages; only npm, pnpm and yarn (and their exact aliases) are followed. */
const PKG_UNFOLLOWED = new Set(["pnpx", "bunx", "bun", "deno"]);
/**
 * Round 3: the package manager a command runs, as the pass follows it — `yarnpkg` is yarn, `corepack yarn|pnpm|npm`
 * is that one (it counts two runner tokens) — or "unfollowed" (pnpx, bunx, bun, deno, corepack anything else), or
 * null when it isn't a package manager. The program is compared by basename, so `/usr/local/bin/npm` counts.
 */
function pkgManager(words: string[]): { pm: "npm" | "pnpm" | "yarn"; args: string[]; tokens: number } | "unfollowed" | null {
  const b = path.basename(words[0] ?? "");
  if (b === "corepack") {
    const n = path.basename(words[1] ?? "");
    return n === "npm" || n === "pnpm" || n === "yarn" ? { pm: n, args: words.slice(2), tokens: 2 } : "unfollowed";
  }
  if (b === "npm" || b === "pnpm" || b === "yarn") return { pm: b, args: words.slice(1), tokens: 1 };
  if (b === "yarnpkg") return { pm: "yarn", args: words.slice(1), tokens: 1 };
  return PKG_UNFOLLOWED.has(b) ? "unfollowed" : null;
}
/** `node --test`, `python[3] -m pytest`, `pytest`: the repo's own tests, with no flag that loads code or config from elsewhere. */
function testRunnerOk(words: string[]): boolean {
  const prog = path.basename(words[0] ?? "");
  if ((prog === "node" || prog === "nodejs") && words[1] === "--test") {
    return !words.slice(2).some((a) => /^(?:--(?:import|require|loader|experimental-loader|env-file|eval|print|test-reporter-destination)(?:=.*)?|-[rep].*)$/.test(a));
  }
  const pytestArgs = /^python3?$/.test(prog) && words[1] === "-m" && words[2] === "pytest" ? words.slice(3) : prog === "pytest" || prog === "py.test" ? words.slice(1) : null;
  if (pytestArgs === null) return false;
  return !pytestArgs.some((a) => /^(?:-[pco].*|--(?:rootdir|config-file|override-ini|confcutdir|pyargs)(?:=.*)?)$/.test(a));
}

/** Interpreters that run a script file named as their first argument. */
const FILE_INTERPRETERS = new Set(["python", "python3", "node", "nodejs", "tsx", "ts-node", "bash", "sh", "zsh", "ruby", "perl"]);
/** The script file a simple command runs (`python3 x.py`, `tsx s.ts`, `./run.sh`), relative as written, or null. */
function scriptFileOf(words: string[]): string | null {
  const first = words[0] ?? "";
  const file = FILE_INTERPRETERS.has(path.basename(first)) ? words[1] ?? "" : first;
  if (/^(?:\.{0,2}\/)?[\w./-]+\.(?:py|js|mjs|cjs|ts|mts|cts|tsx|jsx|sh|rb|pl)$/.test(file)) return file;
  if (/^\.\/[\w./-]+$/.test(first)) return first;
  return null;
}

/** `npx vitest|jest|tsc` with its default config only (`tsc -p .` is the default tsconfig); any other config flag is unbound. */
function npxDevOk(words: string[]): boolean {
  const tool = words[1] ?? "";
  if (!DEV_NPX.has(tool)) return false;
  const args = words.slice(2);
  if (tool === "tsc") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      const m = /^(?:-p|--project|-b|--build)(?:=(.*))?$/.exec(a);
      if (!m) continue;
      const isBuild = a.startsWith("-b") || a.startsWith("--build");
      const v = m[1] ?? (args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("-") ? args[i + 1] : undefined);
      if (v === undefined) { if (isBuild) continue; return false; }
      if (![".", "./", "tsconfig.json", "./tsconfig.json"].includes(v)) return false;
      if (m[1] === undefined) i++;
    }
    return true;
  }
  // Round 3: flags that point the runner at another root, project or config are unbound like --config.
  const moved = tool === "vitest" ? VITEST_MOVE_FLAG : JEST_MOVE_FLAG;
  return !args.some((a) => moved.test(a));
}

/**
 * Bug 71 security review round 2: the scripts a package.json body runs, followed exactly, or null (unbound). Followed:
 * `npm run|run-script <name>`, `npm test|start|stop|restart`, `pnpm|yarn run <name>` (no flag before the name, no
 * location flag before `--`), and `npx vitest|jest|tsc` with its default config. Every other runner token (a bare
 * `yarn <name>`, `npm exec`, npx, make, bash -c, eval, a name the parser can't read) refuses the body, as does a
 * cd/pushd next to a nested run (which package.json it reaches is unknown) or an npm_config_* setting.
 */
function bodyRuns(body: string): { names: string[]; files: string[] } | null {
  if (NPM_CONFIG_ENV.test(body)) return null;
  // A quoted, escaped or expanded script name is refused rather than re-derived.
  if (/(?<![\w.-])(?:npm|pnpm|yarn|yarnpkg)\s+(?:run(?:-script)?\s+)?["'\\$`]/.test(body)) return null;
  const parts = scriptCommands(body, "/");
  if (!parts) return null;
  const names: string[] = [];
  const files: string[] = [];
  let followed = 0;
  for (const p of parts) {
    const w = p.words;
    const prog = path.basename(w[0] ?? "");
    if (p.opaque && (RUNNERISH.test(w.join(" ")) || SHELLS.has(prog))) return null;
    if (nodeRunsPkgCli(w)) return null;
    // Round 3: a script file the body runs is bound like a top-level one; an interpreter call it can't place
    // (`node --test`, `python -m x`, `tsx --import ./y s.ts`) is refused.
    const file = scriptFileOf(w);
    if (file !== null) { files.push(file); continue; }
    // Usability ruling: `node --test` and `python -m pytest` run the repo's own test files (Bot-owned code under the
    // closed-tree rule), like vitest with its default config: followed, unless a flag loads code or config from elsewhere.
    if (testRunnerOk(w)) continue;
    if ((FILE_INTERPRETERS.has(prog) && w.length > 1) || prog === "pytest" || prog === "py.test") return null;
    if (prog === "npx") { if (!npxDevOk(w)) return null; followed++; continue; }
    const pm = pkgManager(w);
    if (pm === "unfollowed") return null;
    if (!pm) continue;
    const args = pm.args;
    const dd = args.indexOf("--");
    if ((dd === -1 ? args : args.slice(0, dd)).some((a) => PKG_LOCATION_FLAG.test(a))) return null;
    let name: string | undefined;
    if (args[0] === "run" || (pm.pm === "npm" && args[0] === "run-script")) name = args[1];
    else if (pm.pm === "npm" && ["test", "start", "stop", "restart"].includes(args[0] ?? "")) name = args[0];
    if (name === undefined || !/^[\w:.-]+$/.test(name)) return null;
    names.push(name);
    followed += pm.tokens;
  }
  // A runner token the parse didn't see as a followed command (inside a wrapper like cross-env or concurrently, a
  // string, a function) is one the pass can't place.
  if ((body.match(BODY_RUNNER) ?? []).length !== followed) return null;
  // Which folder a nested run or a script file resolves in is unknown once the body changes directory.
  if ((names.length || files.length) && /(?:^|[\s;&|(])(?:cd|pushd|popd)(?![\w-])/.test(body)) return null;
  return { names, files };
}

/**
 * Bug 71 security review: the bodies `npm run <name>` really runs — pre<name>, <name>, post<name> — and, followed to
 * depth 3, the scripts they run in turn (`npm run build` inside `test`). Null (unbound) when a script is missing, a
 * run in a body is one it can't place (a location flag, a name it doesn't have), or the chain is deeper than that.
 */
function packageScripts(scripts: Record<string, unknown>, name: string): { bodies: { name: string; body: string }[]; files: string[] } | null {
  const out: { name: string; body: string }[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, depth: number): boolean => {
    if (seen.has(n)) return true;
    seen.add(n);
    const body = scripts[n];
    if (typeof body !== "string" || !body) return false;
    for (const hook of [`pre${n}`, n, `post${n}`]) {
      const b = hook === n ? body : scripts[hook];
      if (hook !== n && typeof b !== "string") continue;
      if (typeof b !== "string") return false;
      out.push({ name: hook, body: b });
      const nested = bodyRuns(b);
      if (nested === null) return false;
      for (const f of nested.files) if (!files.includes(f)) files.push(f);
      for (const next of nested.names) {
        if (depth >= NESTED_MAX_DEPTH) return false;
        if (!visit(next, depth + 1)) return false;
      }
    }
    return true;
  };
  return visit(name, 0) ? { bodies: out, files } : null;
}

/** Text that may run a package script or a script file somewhere in a command (the fail-closed check when it can't be split). */
const SCRIPTISH = /\b(?:npm|pnpm|yarn)\s|\.(?:py|js|mjs|ts|sh|rb|pl)\b|(?:^|[\s;&|(])\.\//;
/** A program that runs code it is handed (a script, a package, a string). */
const RUNNERISH = /\b(?:npm|pnpm|yarn|npx|make|gmake|node|python3?|ruby|perl|deno|bun|bash|sh|zsh|dash|ksh|source|eval)\b|(?:^|[\s;&|(`$])\.\.?\//;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Bug 71: a command's simple commands, each with the directory it runs in (null when unknown). Quote-aware
 * (shell-quote, like analyzeShell); redirects and their targets are dropped; wrappers and leading assignments are
 * stripped (`timeout 60 npm test`, `FOO=1 npm test`). Security review: a `cd` moves the cwd only when it is the
 * command's (or a subshell's) first step or directly follows `&&`, AND is directly followed by `&&` — so whatever runs
 * next ran only if the cd did. Anything else leaves the cwd unknown: a cd after `||`, `;`, `|` or `&`; with -P/-L; to
 * `-`, `~`, a variable or a glob; more than one operand; CDPATH set anywhere in the command; pushd/popd. `--` is
 * skipped. A subshell's cd ends with the subshell. `opaque`: the part runs code the pass can't see (bash -c, eval,
 * source, env -S, shell grammar). Null when the text can't be parsed.
 */
function scriptCommands(command: string, cwd0: string): { words: string[]; cwd: string | null; opaque: boolean }[] | null {
  const tokens: Tok[] = [];
  for (const [n, line] of splitLines(command).lines.entries()) {
    if (n > 0) tokens.push({ op: ";" });
    try { tokens.push(...(parse(line, (k) => `$${k}`) as Tok[])); } catch { return null; }
  }
  const cdpath = /\bCDPATH\b/.test(command);
  const out: { words: string[]; cwd: string | null; opaque: boolean }[] = [];
  const stack: (string | null)[] = [];
  let cwd: string | null = cwd0;
  let cur: string[] = [];
  let prev = "start"; // the operator before the current simple command
  let redirectNext = false;
  const end = (op: string) => {
    const before = prev;
    prev = op;
    const u = unwrap(cur);
    const words = u.s;
    cur = [];
    if (!words.length) return;
    const prog = words[0] as string;
    if (prog === "cd") {
      let args = words.slice(1);
      if (args[0] === "--") args = args.slice(1);
      const target = args.length === 1 ? (args[0] as string) : undefined;
      const certain = (before === "start" || before === "&&") && op === "&&" && !cdpath && !u.assign;
      cwd = certain && cwd !== null && target !== undefined && !target.startsWith("-") && !UNKNOWN_ROOT.test(target) ? path.resolve(cwd, target) : null;
      return;
    }
    if (prog === "pushd" || prog === "popd") { cwd = null; return; }
    const shellC = SHELLS.has(path.basename(prog)) && words.slice(1).some((a) => /^-[a-z]*c/.test(a));
    const opaque = u.opaque || shellC || prog === "eval" || prog === "source" || prog === "." || prog === "exec";
    out.push({ words, opaque, cwd: u.chdir !== undefined ? (u.chdir && cwd !== null && !UNKNOWN_ROOT.test(u.chdir) ? path.resolve(cwd, u.chdir) : null) : cwd });
  };
  for (const t of tokens) {
    if (typeof t === "string") {
      if (redirectNext) { redirectNext = false; continue; }
      cur.push(t);
      continue;
    }
    if ("comment" in t) continue;
    if (t.op === "glob") { cur.push(t.pattern ?? "*"); continue; }
    if ([">", ">>", ">&", "<", "<<<", "&>", ">|"].includes(t.op)) { redirectNext = true; continue; }
    if (t.op === "(") {
      if (cur.length) end(";");
      stack.push(cwd);
      prev = "start";
      continue;
    }
    if (t.op === ")") { end(")"); cwd = stack.length ? (stack.pop() as string | null) : null; prev = ")"; continue; }
    end(t.op);
  }
  end(";");
  return out;
}

// ---------- S1 lean engineering profile: the dev-command fast path ----------

/** Characters a dev command may contain outside a commit message: no quote, `$`, backtick, `\`, `;`, `&`, `|`, `<`, `>`, glob, `~`, `#`, `!`, parens or braces. */
const DEV_SAFE = /^[A-Za-z0-9 ._/:=@+-]+$/;
/**
 * cost-diet-2 (coding-bench run 2): an `echo` that prints a label between a chain's commands (`echo "=== typecheck ==="`,
 * `echo ---`). Literal words, or quoted text with no expansion (`$`, backtick, backslash, `!`); nothing else can reach a
 * part (the chain is split on ` && ` / `; ` first, and a redirect or pipe is not a literal character here).
 */
const ECHO_LABEL = /^echo(?: (?:-[neE]+|[A-Za-z0-9._/:=@+,-]+|"[^"$`\\!]*"|'[^']*'))*$/;
const DEV_PATH = /^[A-Za-z0-9._/@+-]+$/;
/** `npm test` / `npm run <one of these>`; the script BODY must also be a known dev tool (devScriptOk). */
const DEV_NPM_SCRIPTS = new Set(["test", "build", "typecheck", "lint"]);
/** Programs a package.json dev script may run. None of them fetches, installs or deletes on its own. */
/** Fix round 1: no dev servers (`vite`, `next`): they never finish and serve the tree. */
const DEV_SCRIPT_TOOLS = new Set(["vitest", "jest", "tsc", "tsup", "mocha", "eslint", "prettier"]);
/** Local binaries `npx` may run: only when the work tree already has them (npx would otherwise download a package). */
const DEV_NPX = new Set(["vitest", "tsc", "jest"]);
const TSC_FLAGS = new Set(["--noEmit", "-b", "--build", "--pretty", "--listEmittedFiles"]);
const TSC_VALUE_FLAGS = new Set(["-p", "--project"]);
const VITEST_FLAGS = new Set(["--run", "--silent", "--passWithNoTests", "--no-color", "--reporter=dot", "--reporter=verbose"]);
const GIT_ADD_FLAGS = new Set(["-A", "--all", "-u", "--update"]);
const COMMIT_MSG = /^git commit (?:-a )?-m ('[^'\n\r]*'|"[^"$`\\!\n\r]*")$/;

export interface DevCommandFs {
  exists(p: string): boolean;
  readFile(p: string): string | null;
  /** The real path (symlinks resolved); null when it does not exist. */
  realpath(p: string): string | null;
  /** A folder's entry names; null when it can't be read. Without it, `git -c safe.directory=…` is never fast. */
  list?(p: string): string[] | null;
  /** lstat: owner, group and mode bits; null when it does not exist. Without it, no dev command that runs code is fast. */
  stat?(p: string): { uid: number; gid: number; mode: number; link: boolean } | null;
}

/** The Bot's own OS account (per-Bot uid and its private group). */
export interface BotOwner { uid: number; gid: number; home?: string | null }

/**
 * S1 lean engineering profile (engineering mode ON only; the gate checks the mode). True when `command`
 * is one of the project's own build/test/commit commands, run inside a git work tree under the
 * workspace, so it may skip the Haiku reviewer. Deliberately narrow; any doubt answers false and the
 * command takes the ordinary review:
 *   - fixed shapes only: `npm test`, `npm run test|build|typecheck|lint`, `npx vitest|tsc|jest …`,
 *     `tsc …`, `git status|diff …` (the read-only fast path), `git add <paths|-A|-u>`,
 *     `git commit [-a] -m "<message>"`, each optionally after one `cd <dir> && ` (absolute for the
 *     built-in Bash, whose real cwd the host does not track; relative too for the Bot's Shell tool);
 *   - no shell metacharacter, variable, glob, quote (outside the commit message) or env assignment;
 *   - the cwd (after the optional cd) is inside the work tree: the nearest directory with a `.git`,
 *     strictly under the workspace, compared by real path, so a symlink can't lead out of it;
 *   - every path argument is relative, has no `..`, stays in the work tree and is no git control or
 *     secret file;
 *   - an npm script's body is itself a chain of known dev tools with safe characters (the host reads
 *     package.json, like enrichShell's binding), and `npx` only runs a binary the work tree already has.
 */
export function engineeringDevCommand(command: string, o: { cwd: string; cwdKnown: boolean; workspace: string; fs: DevCommandFs; chores?: boolean; owner?: BotOwner | null; boundaries?: string[] }): boolean {
  if (ODD_CHARS.test(command)) return false;
  // speed-fastpath: the textual split below must be the shell's own. A ` && ` or `; ` inside quotes would make the
  // text split disagree with the parser's, so the whole command is then not a dev chain.
  const topSeps = topLevelSeparators(command);
  if (topSeps === null) return false;
  let body = command.trim();
  const realWs = o.fs.realpath(o.workspace);
  const realCwd0 = o.fs.realpath(o.cwd);
  if (!realWs || !realCwd0) return false;
  // The built-in Bash keeps the CLI's own cwd, which the host does not track (`cwdKnown` false): there a
  // cwd-dependent command only qualifies after a `cd` to an ABSOLUTE directory, so what runs is where it
  // was judged; housekeeping on absolute paths needs no cwd (null = unknown).
  let cwd: string | null = o.cwdKnown ? realCwd0 : null;
  // A commit message may hold any separator, so a commit is only ever the whole command (after one cd).
  const cd = /^cd ([^ ]+) && (.+)$/s.exec(body);
  if (cd && COMMIT_MSG.test(cd[2] as string)) {
    cwd = cdTarget(cd[1] as string, cwd, o.fs);
    body = cd[2] as string;
  }
  if (COMMIT_MSG.test(body)) {
    const root = cwd === null ? null : treeOfCwd(cwd, realWs, o.fs);
    // Fix round 1: a commit runs the repo's hooks (core.hooksPath, .husky, lint-staged) and filters: only when
    // none can run and the repo is the Bot's own.
    return !!root && commitInert(root, o.fs) && botOwns(gitDeps(root, o.fs), root, o.fs, o.owner ?? null, o.boundaries ?? []);
  }
  // Housekeeping (2026-09-21 coding bench): a chain of dev commands and routine chores joined by `&&` or `;`,
  // each one judged on its own. Any other separator (`||`, `&`, a newline, a pipe other than the output trim)
  // fails ODD_CHARS or DEV_SAFE, so the whole command takes the ordinary review.
  const parts = body.split(/( && |; )/);
  // Every `;` / `&&` in the text is a spaced top-level separator: none sits inside quotes, none is unspaced.
  const textSeps = (parts.length - 1) / 2;
  if (textSeps !== topSeps || (body.match(/;|&&/g) ?? []).length !== textSeps) return false;
  for (let i = 0; i < parts.length; i += 2) {
    let part = stripOutputTrim((parts[i] as string).trim());
    const sep = parts[i + 1];
    if (ECHO_LABEL.test(part)) continue;
    // speed-fastpath #4: `git -c safe.directory=<dir|'*'> <read>` (the bench's answer to git's "dubious ownership").
    // Only that one key, only before a read, only in a work tree whose own config and hooks can run nothing.
    const sd = /^git -c safe\.directory=(?:'\*'|"\*"|[A-Za-z0-9._/@+-]+) (.+)$/.exec(part);
    if (sd) {
      const rest = (sd[1] as string).split(" ");
      const root = cwd === null ? null : treeOfCwd(cwd, realWs, o.fs);
      if (!root || !DEV_SAFE.test(sd[1] as string) || / {2}/.test(sd[1] as string) || !fastSegmentOk("git", rest) || gitHistoryContent(rest)
        || !gitReadTrusted(root, o.fs, o.owner ?? null, o.boundaries ?? [])) return false;
      continue;
    }
    // speed-fastpath #4: a part that is not a plain dev word list (quotes, a pipe into grep/sort) is still fine when
    // the full static pass reads it as a fast read in the known cwd: `grep -rln "x" src | grep -v y && npx tsc`.
    if ((!DEV_SAFE.test(part) || / {2}/.test(part)) && cwd !== null) {
      const st = analyzeShell(part, { workspace: realWs, cwd, scopeReads: true });
      if (st.readOnly && st.tierHint === 0 && st.floorHits.length === 0) continue;
      return false;
    }
    if (!DEV_SAFE.test(part) || / {2}/.test(part)) return false;
    part = part.trim();
    const [prog, ...args] = part.split(" ");
    if (prog === "cd") {
      if (args.length !== 1) return false;
      const next = cdTarget(args[0] as string, cwd, o.fs);
      if (!next) return false;
      // After `;` a failed cd leaves the shell where it was: the cwd is unknown from there on.
      cwd = sep === " && " ? next : null;
      continue;
    }
    if (!devPart(prog as string, args, cwd, realWs, o.fs, o.chores === true, { owner: o.owner ?? null, boundaries: o.boundaries ?? [] })) return false;
  }
  return true;
}

/**
 * The number of `&&` / `;` separators the shell itself sees at the top level of `command`, or null when the parser
 * can't read it. engineeringDevCommand splits on the text ` && ` / `; `; the two counts agree only when no such
 * text sits inside quotes.
 */
function topLevelSeparators(command: string): number | null {
  try {
    const toks = parse(command, (k) => `$${k}`) as Tok[];
    return toks.filter((t) => typeof t === "object" && "op" in t && (t.op === "&&" || t.op === ";")).length;
  } catch {
    return null;
  }
}

/** Config keys a work tree's own `.git/config` may set for `git -c safe.directory=…` to stay fast: none runs a program. */
const INERT_GIT_KEYS = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|quotepath)|remote\.[^.]+\.(url|fetch)|branch\.[^.]+\.(remote|merge|rebase)|user\.(name|email)|init\.defaultbranch)$/i;

/**
 * `safe.directory` switches off git's own guard against a repository someone else owns: that repo's config
 * (core.fsmonitor, core.pager, diff/filter drivers, include.path, hooksPath…) and its hooks (post-index-change runs
 * on `git status`) would run as this Bot. Fast only when the work tree's `.git` is a folder whose config sets inert
 * keys only, with no worktree config, and whose hooks folder holds only git's `.sample` files. Anything else, or
 * anything that can't be read, is not fast.
 */
function gitRepoInert(root: string, fs: DevCommandFs): boolean {
  const git = path.join(root, ".git");
  if (!fs.list || fs.readFile(git) !== null) return false; // a `.git` FILE points somewhere else
  if (fs.exists(path.join(git, "config.worktree")) || fs.exists(path.join(git, "commondir"))) return false;
  const config = fs.readFile(path.join(git, "config"));
  if (config === null) return false;
  let section = "";
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[([A-Za-z0-9.-]+)(?:\s+"([^"\\]*)")?\]$/.exec(line);
    if (head) { section = head[2] !== undefined ? `${head[1]}.${head[2]}` : (head[1] as string); continue; }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(=.*)?$/.exec(line);
    if (!kv || !section || !INERT_GIT_KEYS.test(`${section}.${kv[1]}`)) return false;
    if (/\\$/.test(line)) return false; // a continued value
  }
  const hooks = fs.list(path.join(git, "hooks"));
  if (hooks === null) return !fs.exists(path.join(git, "hooks"));
  return hooks.every((h) => h.endsWith(".sample"));
}

/** `cd <dir>`: the real directory, or null (a relative dir needs a known cwd; `..`, `~`, variables never pass). */
function cdTarget(dir: string, cwd: string | null, fs: DevCommandFs): string | null {
  if (dir.startsWith("/") ? !DEV_PATH.test(dir) || dir.split("/").includes("..") : !relPathOk(dir) || cwd === null) return null;
  return fs.realpath(path.resolve(cwd ?? "/", dir));
}

/** The work tree a known cwd is in (strictly under the workspace), or null. */
function treeOfCwd(cwd: string, realWs: string, fs: DevCommandFs): string | null {
  return within(realWs, cwd) && cwd !== realWs ? workTreeRoot(cwd, realWs, fs) : null;
}

/** Output trimming a command may end with: `2>&1`, `2>/dev/null`, `| tail -N`, `| head -n N` (read-only filters). */
const OUTPUT_TRIM = / (?:2>&1|2>\/dev\/null|\| (?:tail|head) (?:-n )?-?\d+)$/;
function stripOutputTrim(part: string): string {
  for (let k = 0; k < 3 && OUTPUT_TRIM.test(part); k++) part = part.replace(OUTPUT_TRIM, "");
  return part;
}

/** A folder `rm -r` may clear inside a work tree: dependency, build, cache and temp output, never source. */
const REBUILDABLE = new Set(["node_modules", ".vite", ".vite-temp", ".cache", ".turbo", ".next", ".parcel-cache", "dist", "build", "out", "coverage", "tmp", "temp", ".tmp"]);
const RM_FLAGS = /^-[rRf]+$/;

/**
 * One housekeeping target (an rm or mkdir operand), judged by its real path: a file or new folder in a git
 * work tree under the workspace (never the tree itself, a nested tree, `.git`, a git control, security or
 * secret file; a recursive delete only of a rebuildable folder), or a file under /tmp (never recursive: /tmp
 * is shared by every Bot on the box). A relative operand needs a known cwd.
 */
function choreTarget(a: string, recursive: boolean, cwd: string | null, realWs: string, fs: DevCommandFs): boolean {
  if (!DEV_PATH.test(a) || a.startsWith("-") || a.split("/").includes("..") || /\/\.?$/.test(a) || a === ".") return false;
  if (!a.startsWith("/") && cwd === null) return false;
  const abs = path.resolve(cwd ?? "/", a);
  const real = realOrParent(abs, fs);
  if (!real) return false;
  if (abs.startsWith("/tmp/")) {
    const tmp = fs.realpath("/tmp");
    return !recursive && !!tmp && real.startsWith(`${tmp}/`);
  }
  if (!within(realWs, real) || real === realWs) return false;
  if ([abs, real].some((p) => GIT_CONTROL_PATH.test(p) || p.split("/").includes(".git") || SECURITY_PATH.test(p) || SECRET_PATH.test(` ${p}`))) return false;
  if (fs.exists(path.join(real, ".git"))) return false; // a (nested) work tree itself
  const root = workTreeRoot(path.dirname(real), realWs, fs);
  if (!root || !within(root, real) || real === root) return false;
  return !recursive || path.relative(root, real).split("/").some((seg) => REBUILDABLE.has(seg));
}

/** The real path of `p`, or, for a path that does not exist yet, its nearest existing ancestor's real path + the rest. */
function realOrParent(p: string, fs: DevCommandFs): string | null {
  const rest: string[] = [];
  for (let d = p; ; d = path.dirname(d)) {
    const r = fs.realpath(d);
    if (r) return path.join(r, ...rest.reverse());
    if (d === "/") return null;
    rest.push(path.basename(d));
  }
}

/** One command of an engineering chain: a dev command (needs a known cwd in a work tree), a chore, or a plain read. */
function devPart(prog: string, args: string[], cwd: string | null, realWs: string, fs: DevCommandFs, chores: boolean, trust: { owner: BotOwner | null; boundaries: string[] }): boolean {
  const { owner, boundaries } = trust;
  if (prog === "rm" || prog === "mkdir") {
    // speed-fastpath: housekeeping deletes stay an engineering-mode (lean profile) fast path only.
    if (!chores) return false;
    const flags = args.filter((a) => a.startsWith("-"));
    const targets = args.filter((a) => !a.startsWith("-"));
    if (!targets.length || args.indexOf(targets[0] as string) !== flags.length) return false; // flags first, then operands
    if (prog === "mkdir" ? flags.some((f) => f !== "-p") : flags.some((f) => !RM_FLAGS.test(f))) return false;
    const recursive = prog === "rm" && flags.some((f) => /[rR]/.test(f));
    return targets.every((t) => choreTarget(t, recursive, cwd, realWs, fs));
  }
  if (prog === "git" && args[0] === "-C") {
    // `git -C <dir> status|diff|log|show…`: read-only, in a work tree under the workspace.
    const dir = cdTarget(args[1] ?? "", cwd, fs);
    const tree = dir ? treeOfCwd(dir, realWs, fs) : null;
    return !!tree && fastSegmentOk("git", args.slice(2)) && !gitHistoryContent(args.slice(2)) && gitReadTrusted(tree, fs, owner, boundaries);
  }
  // A plain read (the read-only fast path's own flag lists); the static pass has already flagged secret paths.
  // Never a wrapper: `env rm -rf /` passes env's flag list, and only analyzeShell unwraps it.
  if (!Object.hasOwn(WRAPPERS, prog) && fastSegmentOk(prog, args)) return true;
  const root = cwd === null ? null : treeOfCwd(cwd, realWs, fs);
  if (!root || cwd === null) return false;
  const pathArg = (a: string) => relPathOk(a) && insideTree(root, cwd, a, fs);

  if (prog === "npm") {
    const script = args.length === 1 && args[0] === "test" ? "test" : args.length === 2 && args[0] === "run" ? (args[1] as string) : null;
    if (!script || !DEV_NPM_SCRIPTS.has(script)) return false;
    const tools = devScriptTools(fs.readFile(path.join(cwd, "package.json")), script);
    // Fix round 1 (shared-workspace trust): everything the script runs must be the Bot's own.
    return tools !== null && botOwns(npmDeps(root, cwd, tools, fs), root, fs, owner, boundaries);
  }
  if (prog === "npx") {
    const tool = args[0] ?? "";
    if (!DEV_NPX.has(tool) || !localBin(root, cwd, tool, fs)) return false;
    return toolArgsOk(tool, args.slice(1), pathArg) && botOwns(npmDeps(root, cwd, [tool], fs), root, fs, owner, boundaries);
  }
  if (prog === "tsc") return toolArgsOk("tsc", args, pathArg);
  if (prog === "git") {
    const sub = args[0] ?? "";
    if (sub === "status" || sub === "diff") return fastSegmentOk("git", args) && !gitHistoryContent(args) && gitReadTrusted(root, fs, owner, boundaries);
    if (sub === "add") {
      const rest = args.slice(1);
      // Fix round 1: `git add` runs clean filters from the repo's config and attributes.
      return rest.length > 0 && rest.every((a) => GIT_ADD_FLAGS.has(a) || (!a.startsWith("-") && (a === "." || pathArg(a))))
        && commitInert(root, fs) && botOwns(gitDeps(root, fs), root, fs, owner, boundaries);
    }
  }
  return false;
}

function within(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

function relPathOk(a: string): boolean {
  return DEV_PATH.test(a) && !a.startsWith("/") && !a.startsWith("-") && !a.split("/").includes("..");
}

/** The nearest directory from `cwd` up to (not including) the workspace that holds a `.git`. */
function workTreeRoot(cwd: string, ws: string, fs: DevCommandFs): string | null {
  for (let d = cwd; within(ws, d) && d !== ws; d = path.dirname(d)) if (fs.exists(path.join(d, ".git"))) return d;
  return null;
}

function insideTree(root: string, cwd: string, a: string, fs: DevCommandFs): boolean {
  const abs = path.resolve(cwd, a);
  if (GIT_CONTROL_PATH.test(abs) || abs.split("/").includes(".git") || SECURITY_PATH.test(abs) || SECRET_PATH.test(` ${abs}`)) return false;
  // A path that exists is judged by its real path (a symlink may point out); a new one by its text.
  const real = fs.realpath(abs) ?? abs;
  return within(root, real);
}

function localBin(root: string, cwd: string, tool: string, fs: DevCommandFs): boolean {
  for (let d = cwd; within(root, d); d = path.dirname(d)) {
    if (fs.exists(path.join(d, "node_modules", ".bin", tool))) return true;
    if (d === root) break;
  }
  return false;
}

function toolArgsOk(tool: string, args: string[], pathArg: (a: string) => boolean): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (tool === "tsc") {
      if (TSC_FLAGS.has(a)) continue;
      if (TSC_VALUE_FLAGS.has(a) && i + 1 < args.length && pathArg(args[i + 1] as string)) { i++; continue; }
      return false;
    }
    if (tool === "vitest" && i === 0 && a === "run") continue;
    if (tool === "vitest" && VITEST_FLAGS.has(a)) continue;
    if (tool === "jest" && (a === "--silent" || a === "--ci")) continue;
    if (a.startsWith("-") || !pathArg(a)) return false;
  }
  return true;
}

/**
 * The npm script body: `tool args && tool args …`, each a known dev tool with safe characters and no delete word;
 * returns the tools it runs, or null. Fix round 1: a `pre<script>` / `post<script>` lifecycle hook makes it
 * unreviewable, and no option value (`--reporter=/tmp/x`, `-c/x`) may be absolute, climb with `..` or use `~`.
 */
function devScriptTools(pkg: string | null, script: string): string[] | null {
  if (!pkg) return null;
  let scripts: Record<string, unknown> | undefined;
  try {
    scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts;
  } catch {
    return null;
  }
  if (!scripts || typeof scripts !== "object") return null;
  if (Object.hasOwn(scripts, `pre${script}`) || Object.hasOwn(scripts, `post${script}`)) return null;
  const body = scripts[script];
  if (typeof body !== "string" || !body.trim()) return null;
  const tools: string[] = [];
  for (const part of body.trim().split(" && ")) {
    const p = part.trim();
    if (!DEV_SAFE.test(p) || / {2}/.test(p)) return null;
    const words = p.split(" ");
    if (!DEV_SCRIPT_TOOLS.has(words[0] as string)) return null;
    if (words.some((w) => DELETER_WORDS.has(w) || /^--?(watch|w)$/.test(w) || /^(publish|deploy|serve|dev|preview|start)$/.test(w))) return null;
    // Fix round 2: a config named on the command line (`--config x`, `-c x`) is code the ownership check never saw.
    if (words.some((w) => /^--config(=|$)/.test(w) || /^-c/.test(w) || /^--(setupFiles|globalSetup|require|loader|import)(=|$)/.test(w))) return null;
    const values = words.slice(1).flatMap((w) => {
      if (w.startsWith("--")) return w.includes("=") ? [w.slice(w.indexOf("=") + 1)] : [];
      if (w.startsWith("-")) return w.length > 2 ? [w.slice(2)] : [];
      return [w];
    });
    if (values.some((v) => v.startsWith("/") || v.startsWith("~") || v.split(/[/=,:]/).includes(".."))) return null;
    tools.push(words[0] as string);
  }
  return tools;
}

/** Config files a test runner, bundler, linter or package manager loads and RUNS (or that steer what it runs). */
const RUNNER_CONFIG = /^((vitest|vite|jest|next|babel|eslint|prettier|tsup|webpack|rollup|postcss|tailwind|mocha|playwright|lint-staged)\.(config|workspace|setup)(\.[\w-]+)*\.[cm]?[jt]sx?|\.(babelrc|eslintrc|prettierrc|mocharc|lintstagedrc)(\..*)?|package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|conftest\.py|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml|tsconfig(\.[\w-]+)?\.json)$/;

/** What an npm script / npx run depends on: the runner configs in the tree root and the cwd, and each tool's bin. */
function npmDeps(root: string, cwd: string, tools: string[], fs: DevCommandFs): string[] {
  const deps = new Set<string>([root, cwd]);
  for (const dir of new Set([root, cwd])) {
    for (const name of fs.list?.(dir) ?? []) if (RUNNER_CONFIG.test(name)) deps.add(path.join(dir, name));
    deps.add(path.join(dir, "node_modules"));
    deps.add(path.join(dir, "node_modules", ".bin"));
    for (const t of tools) deps.add(path.join(dir, "node_modules", ".bin", t));
  }
  return [...deps];
}

/** What a commit / add depends on: the repo's control files (config, hooks, attributes, husky). */
function gitDeps(root: string, fs: DevCommandFs): string[] {
  const git = path.join(root, ".git");
  const hooks = path.join(git, "hooks");
  return [root, git, path.join(git, "config"), path.join(git, "info"), path.join(git, "info", "attributes"), hooks,
    ...(fs.list?.(hooks) ?? []).map((h) => path.join(hooks, h)), path.join(root, ".gitattributes"), path.join(root, ".husky"), path.join(root, "package.json")];
}

const isDirMode = (mode: number) => (mode & 0o170000) === 0o040000;

/**
 * Fix round 2 ruling: the closed ancestor. The tree is unreachable by other Bots only when some folder from the tree
 * root up to the Bot's home (both ends included) is the Bot's own and not searchable by anyone else: owned by the
 * Bot's uid, no world x, group x only for the Bot's private group. `~/code/<repo>` under the Bot's 0700 home
 * qualifies. `boundaries` are the Bot's home ONLY (final ruling): a /workspace project is never closed, even one
 * chmod'd to 0700, since files another uid planted there earlier (or hard links to them) can stay editable. Null
 * when none.
 */
export function closedAncestor(root: string, fs: DevCommandFs, owner: BotOwner | null, boundaries: string[]): string | null {
  if (!owner || !fs.stat) return null;
  if (!boundaries.some((b) => within(b, root))) return null;
  for (let d = root; ; d = path.dirname(d)) {
    const st = fs.stat(d);
    if (st && !st.link && st.uid === owner.uid && (st.mode & 0o001) === 0 && ((st.mode & 0o010) === 0 || st.gid === owner.gid)) return d;
    if (boundaries.includes(d) || d === path.dirname(d)) return null;
  }
}

/** System folders a command may name from inside a closed tree (root-owned programs and the null devices). */
const CLOSED_TREE_SYSTEM = /^\/(dev\/(null|stdout|stderr|stdin|tty)$|usr\/bin\/|bin\/|usr\/sbin\/|sbin\/|usr\/local\/bin\/|opt\/homebrew\/bin\/)/;

/**
 * Bug 258: an UNBOUND command (make, npx tools, bash -c, time, loops — the pass couldn't bind the script it runs) needs
 * no card in Full auto when it runs in the Bot's own closed tree: `root` (its work tree or cwd) has a closedAncestor
 * under the Bot's 0700 home, so the scripts it can reach from there are the Bot's own and no other Bot's. The command
 * must also stay in that tree as written: every absolute or ~ path it names is inside the closed folder (or a system
 * program / null device), and it has no `..`, no `cd`/`-C` to a variable or ~, no path built from a variable, and no
 * command substitution. The shared /workspace is never a closed tree (the boundary is the home only), so it keeps the
 * card. Anything else: false (the card stays).
 */
export function unboundInClosedTree(command: string, root: string, fs: DevCommandFs, owner: BotOwner | null, home: string): string | null {
  if (!owner || !home || !within(home, root)) return null;
  const closed = closedAncestor(root, fs, owner, [home]);
  if (!closed) return null;
  if (/\$\(|`|<\(|>\(/.test(command)) return null;
  if (/(^|[\s/'"=:])\.\.(\/|[\s'";&|)]|$)/.test(command)) return null;
  if (/(^|[\s;&|("'])(cd|pushd)(\s+["']?[$~`-]|\s*($|[;&|)"']))/.test(command)) return null;
  if (/(^|\s)(-C|--prefix|--cwd|--dir|--directory|-f|--file|--makefile)(\s+|=)["']?[$~]/.test(command)) return null;
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?\//.test(command)) return null;
  const noUrls = command.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi, ""); // a URL is no path on this disk
  // Absolute and ~ paths the command names.
  for (const m of noUrls.matchAll(/(?:^|[\s'"=:(])(\/[^\s'";&|()<>]*|~[^\s'";&|()<>]*)/g)) {
    const raw = m[1] as string;
    const abs = raw.startsWith("~") ? path.join(home, raw.slice(1)) : path.resolve(raw);
    if (CLOSED_TREE_SYSTEM.test(abs)) continue;
    const real = fs.realpath(abs) ?? abs;
    if (!within(closed, abs) || !within(closed, real)) return null;
  }
  // Fix round (review of bug 258): a relative argument that names a path (`bash link/x.sh`, `./tools/run`) is resolved
  // against the cwd and its real path checked, so a symlink or `..` that leaves the tree is a card, not a quiet run.
  // The nearest EXISTING ancestor's real path is checked, so a symlink dir with a not-yet-created file under it counts.
  const realNearest = (abs: string): string | null => {
    let cur = abs;
    for (;;) {
      const r = fs.realpath(cur);
      if (r !== null) return cur === abs ? r : path.join(r, path.relative(cur, abs));
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  };
  for (const m of noUrls.matchAll(/(?:^|[\s'"=(])((?:\.\.?\/|[\w.@%+-]+\/)[^\s'";&|()<>]*)/g)) {
    const raw = m[1] as string;
    if (raw.startsWith("/") || raw.startsWith("~")) continue;
    const abs = path.resolve(root, raw);
    if (!within(closed, abs)) return null;
    const real = realNearest(abs);
    if (real !== null && !within(closed, real)) return null;
  }
  return closed;
}

/**
 * Fix round 1 ruling 6 + round 2: a dev command that runs code from the tree is fast only when that code is the Bot's
 * own and no other Bot can reach it. The tree needs a closed ancestor (above). Every dependency that exists, its
 * real target (a bin link, which must stay inside the closed folder and be a file, never a folder), and every folder
 * from it up to the closed ancestor must be owned by the Bot's uid, never world-writable, and group-writable only for
 * the Bot's private group. A symlinked folder at the top of the tree, the usual test folders or node_modules is
 * refused. Anything else, an unknown owner or no way to stat answers false: the model reviews it (no card).
 */
function botOwns(deps: string[], root: string, fs: DevCommandFs, owner: BotOwner | null, boundaries: string[]): boolean {
  if (!owner || !fs.stat) return false;
  const closed = closedAncestor(root, fs, owner, boundaries);
  if (!closed) return false;
  // Final minors: a monorepo's packages/ or apps/ hold more configs and links than the scan below covers.
  if (fs.exists(path.join(root, "packages")) || fs.exists(path.join(root, "apps"))) return false;
  const ok = (p: string, linkOk = false): boolean => {
    const st = fs.stat!(p);
    if (!st) return true; // not there: nothing to plant through (creating it needs a write the parent check covers)
    if (st.uid !== owner.uid) return false;
    if (st.link) return linkOk;
    return (st.mode & 0o002) === 0 && ((st.mode & 0o020) === 0 || st.gid === owner.gid);
  };
  const dirsUp = (p: string): string[] => {
    const out: string[] = [];
    for (let d = path.dirname(p); within(closed, d); d = path.dirname(d)) { out.push(d); if (d === closed) break; }
    return out;
  };
  /** A link must resolve inside the closed folder, to a FILE. */
  const linkOk = (p: string): boolean => {
    const real = fs.realpath(p);
    const rst = real ? fs.stat!(real) : null;
    return !!real && !!rst && within(closed, real) && !isDirMode(rst.mode);
  };
  for (const dep of deps) {
    const st = fs.stat(dep);
    if (st?.link) {
      if (!ok(dep, true) || !linkOk(dep)) return false;
      const real = fs.realpath(dep) as string;
      if (!ok(real) || !dirsUp(real).every((d) => ok(d))) return false;
    } else if (!ok(dep)) return false;
    if (!dirsUp(dep).every((d) => ok(d))) return false;
  }
  for (const dir of [root, ...["src", "test", "tests", "__tests__", "spec", "node_modules", "config"].map((d) => path.join(root, d))]) {
    for (const name of fs.list?.(dir) ?? []) {
      const p = path.join(dir, name);
      if (fs.stat(p)?.link && !linkOk(p)) return false;
    }
  }
  return true;
}

/**
 * Fix round 2: a fast git read (status, diff, log, show) runs the repo's config and hooks, so it needs an inert repo
 * (gitRepoInert: harmless config keys only, sample-only hooks) that is either inside a closed tree or whose control
 * files (.git, its config, info and hooks, .gitattributes) are the Bot's own and not group- or world-writable.
 */
export function gitReadTrusted(root: string, fs: DevCommandFs, owner: BotOwner | null, boundaries: string[]): boolean {
  if (!owner || !fs.stat || !gitRepoInert(root, fs)) return false;
  if (closedAncestor(root, fs, owner, boundaries)) return true;
  const git = path.join(root, ".git");
  const hooks = path.join(git, "hooks");
  const control = [root, git, path.join(git, "config"), path.join(git, "info"), path.join(git, "info", "attributes"), hooks,
    ...(fs.list?.(hooks) ?? []).map((h) => path.join(hooks, h)), path.join(root, ".gitattributes")];
  return control.every((p) => {
    const st = fs.stat!(p);
    return !st || (!st.link && st.uid === owner.uid && (st.mode & 0o022) === 0);
  });
}

/** The work tree a folder is in (the nearest folder up that holds `.git`), or null. */
export function gitRootOf(dir: string, fs: DevCommandFs): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.exists(path.join(d, ".git"))) return d;
    if (d === path.dirname(d)) return null;
  }
}

/**
 * Fix round 1: a commit (and `git add`) runs nothing the Bot didn't choose: the repo's config and hooks are inert
 * (gitRepoInert: no core.hooksPath, fsmonitor, filter/diff/textconv drivers, sample-only hooks), there is no
 * `.husky/` and no lint-staged config, and no attributes file names a filter, diff or merge driver.
 */
function commitInert(root: string, fs: DevCommandFs): boolean {
  if (!gitRepoInert(root, fs)) return false;
  if (fs.exists(path.join(root, ".husky"))) return false;
  const names = fs.list?.(root) ?? null;
  if (names === null || names.some((n) => /^(\.lintstagedrc(\..*)?|lint-staged\.config\.[cm]?[jt]s)$/.test(n))) return false;
  const pkg = fs.readFile(path.join(root, "package.json"));
  if (pkg !== null) {
    try {
      const j = JSON.parse(pkg) as Record<string, unknown>;
      if (Object.hasOwn(j, "lint-staged") || Object.hasOwn(j, "husky") || Object.hasOwn(j, "simple-git-hooks") || Object.hasOwn(j, "pre-commit")) return false;
    } catch {
      return false;
    }
  }
  for (const f of [path.join(root, ".gitattributes"), path.join(root, ".git", "info", "attributes")]) {
    const text = fs.readFile(f);
    if (text !== null && /(^|\s)(filter|diff|merge)=/m.test(text)) return false;
  }
  return true;
}
