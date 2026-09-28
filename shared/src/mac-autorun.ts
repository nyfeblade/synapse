import { macFloorHits, macOpaque } from "./mac-floor";

/**
 * Final secfix round 2, ruling A: Mac "Always" (per-Bot or computer-wide) is an ALLOWLIST BY LOCATION.
 * The ONE predicate both the host (host/local/local-tools) and the Mac (app/src/coordinator/local-exec/policy)
 * apply. Pure string code (the renderer imports @synapse/shared): the Mac passes `realpath` (fs.realpathSync.native
 * of the deepest existing ancestor), the host (which can't see the Mac's disk) checks the lexical path only.
 * Spec §01.x: "Mac auto-run is allowlist-by-location, ORIGINAL."
 */
export interface MacAutoRunContext {
  /** The Mac user's home: `~` in a command word expands here (zsh). */
  home: string;
  /** The local root: the default cwd, and where `~` in a cwd or a file op's path points (the executor's within()). */
  root: string;
  /** The folders the user added in Settings → Computer. Empty (the default) = nothing auto-runs. */
  roots: readonly string[];
  /** The app's own data folder (never auto-run). */
  userData?: string | null;
  /** Mac only: the on-disk path (symlinks resolved, APFS spelling). May throw for a missing path. */
  realpath?: (p: string) => string;
}

export interface MacAutoRunRequest { op: string; command?: string; path?: string; cwd?: string }

/**
 * Commands that only read, each with its FLAG ALLOWLIST (final secfix round 3, ruling 3). `bool` letters take no
 * value; `value` letters take one (attached or the next word): "num" = digits only, "pattern" = a grep pattern (never
 * a file name). Any other flag, any long (--x) flag and any recursive/link-following mode sends the call to a card.
 * find is gone entirely, and so are grep -r/-R/-S/-O/-f, diff -r, ls -R/-L and tail -f.
 */
type FlagSpec = { bool: string; value?: Record<string, "num" | "pattern">; require?: string };
const GREP: FlagSpec = { bool: "inclvwEF", value: { e: "pattern" } };
const HEADTAIL: FlagSpec = { bool: "", value: { n: "num", c: "num" } };
const NONE: FlagSpec = { bool: "" };
const READ_ONLY_PROGRAMS = new Map<string, FlagSpec>([
  // (file -C, tree -o, rg --pre and hostname NAME can write or run things, so they aren't here.)
  ["cat", { bool: "nb" }], ["head", HEADTAIL], ["tail", HEADTAIL], ["ls", { bool: "lah1tS" }], ["wc", { bool: "lwc" }],
  ["grep", GREP], ["egrep", GREP], ["fgrep", GREP], ["diff", { bool: "uq" }], ["cmp", NONE], ["md5", NONE], ["shasum", NONE],
  ["pwd", NONE], ["stat", NONE], ["du", { bool: "shk", require: "s" }], ["df", { bool: "hk" }], ["which", NONE], ["whoami", NONE],
  ["date", NONE], ["uname", { bool: "asrmnp" }], ["echo", { bool: "n" }], ["basename", NONE], ["dirname", NONE], ["realpath", NONE],
  ["sw_vers", NONE], ["mdls", NONE], ["id", NONE], ["uptime", NONE],
]);
/** Printable ASCII only (ruling A (2)). */
const PRINTABLE = /^[\x20-\x7e]*$/;
/** Ruling A (3): glob, brace, quote, $, backtick, redirect, ;, &, |, escapes, subshells, history, comments, =, ^. */
const SHELL_META = /[*?[\]{}'"$`<>;&|\\()!#=^]/;
/** date: no args, or a single +FORMAT. */
const DATE_FORMAT = /^\+[A-Za-z0-9%:._/-]*$/;
/** Credential and startup places under ~ (ruling A (4)); every one is also a dot path, which is refused on its own. */
const CREDENTIALS = [".ssh", ".aws", ".netrc", ".config", ".docker", ".gnupg", ".kube", ".profile"];
const CREDENTIAL_PREFIXES = [".zsh", ".bash"];
const DENIED_SEGMENTS = new Set(["keychains", "launchagents", "launchdaemons"]);

/** APFS compares names case-insensitively and after Unicode normalization: fold both ways (ſ → s, K (Kelvin) → k). */
export function macFold(p: string): string {
  return p.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** Lexical normalization: collapse //, drop /./, resolve .. (never above /). */
export function macLexical(p: string, base: string): string {
  const abs = p.startsWith("/") ? p : `${base}/${p}`;
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

const expandTilde = (p: string, to: string): string | null => (p === "~" ? to : p.startsWith("~/") ? `${to}${p.slice(1)}` : p.startsWith("~") ? null : p);
const within = (p: string, dir: string): boolean => dir !== "/" && (p === dir || p.startsWith(`${dir}/`));

/** The on-disk path of `abs`: realpath of its deepest existing ancestor, plus the missing tail. */
function realOf(abs: string, realpath: (p: string) => string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return macLexical([realpath(cur), ...tail].join("/"), "/"); } catch { /* missing: walk up */ }
    if (cur === "/") return abs;
    tail.unshift(cur.slice(cur.lastIndexOf("/") + 1));
    cur = cur.slice(0, cur.lastIndexOf("/")) || "/";
  }
}

/** One absolute, lexically normal path: denied places first, then inside some root. */
function placeOk(abs: string, c: MacAutoRunContext, roots: string[]): boolean {
  const f = macFold(abs);
  const home = macFold(macLexical(c.home, "/"));
  const segs = f.split("/").filter(Boolean);
  if (segs.some((s) => s.startsWith(".") || DENIED_SEGMENTS.has(s))) return false; // any dot-dir/dot-file, keychains, startup items
  if (within(f, `${home}/library`) || within(f, "/library") || within(f, "/system")) return false;
  if (CREDENTIALS.some((x) => within(f, `${home}/${x}`))) return false;
  if (segs.length && within(f, home) && CREDENTIAL_PREFIXES.some((x) => f.slice(home.length + 1).startsWith(x))) return false;
  if (c.userData && within(f, macFold(macLexical(c.userData, "/")))) return false;
  return roots.some((r) => within(f, r));
}

/** Protected places under ~ that an auto-run root may never contain (ruling 2). */
const PROTECTED_UNDER_HOME = [
  ".ssh", ".aws", ".config", ".gnupg", ".kube", ".docker", ".netrc", ".profile", ".inputrc",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".zsh_history", ".bashrc", ".bash_profile", ".bash_login", ".bash_history",
  "library/keychains", "library",
];
const hasDotDot = (p: string): boolean => p.split("/").includes("..");

/**
 * Final secfix round 3, ruling 2: an auto-run root is a strict subfolder of ~ (depth ≥ 1) that is not ~/Library, not a
 * dot-dir and not inside one, and contains no protected path (the credential dot-dirs, shell rc files, Keychains, the
 * app's data) — or a subfolder of /Volumes/<name>. ~, its ancestors, /Users, /private, /var, /Applications, /opt, /,
 * /Volumes and /Volumes/<name> are refused. Lexical (the Mac passes a realpath'd value); pure string code.
 */
export function macRootAcceptable(p: string, c: { home: string; userData?: string | null }): boolean {
  if (typeof p !== "string" || !p.startsWith("/") || !PRINTABLE.test(p) || hasDotDot(p)) return false;
  const f = macFold(macLexical(p, "/"));
  const home = macFold(macLexical(c.home, "/"));
  const segs = f.split("/").filter(Boolean);
  if (segs.some((s) => s.startsWith(".") || DENIED_SEGMENTS.has(s))) return false;
  let placed = false;
  if (home !== "/" && f.startsWith(`${home}/`)) placed = f.slice(home.length + 1).split("/")[0] !== "library";
  else placed = segs[0] === "volumes" && segs.length >= 3;
  if (!placed) return false;
  const userData = c.userData ? macFold(macLexical(c.userData, "/")) : null;
  const inside = [...PROTECTED_UNDER_HOME.map((x) => `${home}/${x}`), ...(userData ? [userData] : [])];
  if (inside.some((x) => within(x, f))) return false; // the root contains a protected place
  return !(userData && within(f, userData));
}

/** One flag word against its program's allowlist; returns how many following words it consumed, or -1 (refused). */
function flagWord(w: string, next: string | undefined, spec: FlagSpec, seen: Set<string>): number {
  if (!/^-[A-Za-z0-9]+$/.test(w)) return -1; // --long, -, attached punctuation (-f=NAME, -f/x)
  for (let i = 1; i < w.length; i++) {
    const ch = w[i]!;
    if (spec.bool.includes(ch)) { seen.add(ch); continue; }
    const kind = spec.value?.[ch];
    if (!kind) return -1;
    const attached = w.slice(i + 1);
    const v = attached || next;
    if (v === undefined) return -1;
    if (kind === "num" && !/^[0-9]+$/.test(v)) return -1;
    if (kind === "pattern" && v.startsWith("-")) return -1;
    return attached ? 0 : 1;
  }
  return 0;
}

/**
 * Ruling A: true ONLY IF (1) the call is a read-only program from the list (date: no args or one +FORMAT) or a
 * read-file/list-directory, (2) every string is printable ASCII, (3) there is no shell syntax at all, and (4) the
 * cwd and every path-like argument, lexically normalized, folded and (on the Mac) realpath'd, lie inside an
 * auto-run root and never under ~/Library, a dot path, a credential path or the app's data. The Mac floor regexes
 * and zsh-opaque checks stay on as an extra layer. Everything else goes to a card.
 *
 * Final secfix round 3: (ruling 2) a root must pass macRootAcceptable, and on the Mac a stored root whose realpath no
 * longer equals the stored value is ignored; (ruling 3) a `..` segment anywhere (args, path, cwd) is refused, each
 * program has a flag allowlist (no recursive or link-following mode, no find), a `-…` word after the first operand
 * must pass both the flag allowlist and the path check, and words after `--` are paths.
 */
export function macAutoRunEligible(r: MacAutoRunRequest, c: MacAutoRunContext): boolean {
  const texts = [r.command, r.path, r.cwd].filter((t): t is string => typeof t === "string");
  if (!texts.every((t) => PRINTABLE.test(t))) return false;
  if (texts.some((t) => SHELL_META.test(t) || macFloorHits(t).floors.size > 0 || macOpaque(t, { command: t === r.command }))) return false;
  if (texts.some((t) => t.split(/[ /]/).includes(".."))) return false;
  const safeReal = (x: string): string | null => { try { return c.realpath!(x); } catch { return null; } };
  const roots = c.roots
    .filter((x) => typeof x === "string" && macRootAcceptable(x, c))
    .filter((x) => !c.realpath || safeReal(x) === x)
    .map((x) => macFold(macLexical(x, "/")));
  if (!roots.length) return false;
  const rootDir = macLexical(c.root, "/");
  const ok = (p: string, base: string, tildeTo: string): boolean => {
    const e = expandTilde(p, tildeTo);
    if (e === null) return false;
    const abs = macLexical(e, base);
    if (!placeOk(abs, c, roots)) return false;
    return !c.realpath || placeOk(realOf(abs, c.realpath), c, roots);
  };
  if (r.op === "read-file" || r.op === "list-directory") return !!r.path && ok(r.path, rootDir, rootDir);
  if (r.op !== "run-command") return false;
  const cwdExp = expandTilde(r.cwd ?? rootDir, rootDir);
  if (cwdExp === null || !ok(cwdExp, rootDir, rootDir)) return false;
  const cwd = macLexical(cwdExp, rootDir);
  const words = (r.command ?? "").split(" ").filter(Boolean);
  const prog = words[0];
  const spec = prog === undefined ? undefined : READ_ONLY_PROGRAMS.get(prog);
  if (!prog || !spec) return false;
  const args = words.slice(1);
  if (prog === "date") return args.length === 0 || (args.length === 1 && DATE_FORMAT.test(args[0]!));
  const seen = new Set<string>();
  let operand = false;
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (!endOfFlags && w === "--") { endOfFlags = true; continue; }
    if (!endOfFlags && w.startsWith("-")) {
      const used = flagWord(w, args[i + 1], spec, seen);
      if (used < 0) return false;
      // After the first operand a program may take this word as a file: it must pass the path check too.
      if (operand && (!ok(w, cwd, c.home) || (used === 1 && !ok(args[i + 1]!, cwd, c.home)))) return false;
      i += used;
      continue;
    }
    operand = true;
    if (!ok(w, cwd, c.home)) return false;
  }
  return !spec.require || [...spec.require].every((ch) => seen.has(ch));
}
