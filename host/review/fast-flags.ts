/**
 * ORIG-01 §01.3/§01.4 fast path, round-3 security review (controller ruling, fail-closed): a segment is tier 0
 * only when its program is listed here AND every flag it passes is on that program's explicit safe-flag list.
 * Trusting a program by name is not enough (`git diff --output=…` writes files, `rg --pre …` runs programs,
 * `less +!…` shells out). Any unknown flag, and any pager or editor, makes the segment non-fast (tier ≥ 1).
 */

interface FlagSpec {
  /** Boolean short letters (clusterable). */
  short?: string;
  /** Short letters that take a value (attached or the next argument). */
  shortValue?: string;
  /** Boolean long options (`--x`); `--x=v` is accepted for these only when also listed in `longValue`. */
  long?: string[];
  /** Long options that take a value (`--x=v` or `--x v`). */
  longValue?: string[];
  /** Long options that take two values (`jq --arg name value`). */
  longTwo?: string[];
  /** `-5` style count shorthand (head, tail, git log). */
  numeric?: boolean;
  /** Single-dash long words (find primaries). */
  words?: string[];
  wordValue?: string[];
  /** Positional (non-flag) arguments allowed at all. Default true. */
  positionals?: boolean;
}

const GIT_DIFF_COMMON = {
  short: "pRuwbzMCBDsq", shortValue: "U",
  long: ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--patch", "--no-patch", "--color", "--no-color",
    "--word-diff", "--minimal", "--patience", "--histogram", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--exit-code",
    "--quiet", "--relative", "--no-renames", "--find-renames", "--full-index", "--binary", "--abbrev", "--raw", "--patch-with-stat", "--compact-summary", "--dirstat"],
  longValue: ["--unified", "--diff-filter", "--color", "--word-diff", "--stat", "--relative", "--abbrev", "--find-renames", "--dirstat", "--diff-algorithm", "--color-moved"],
};

/** Per-program safe flags. `less`, `more`, pagers and editors are deliberately absent. */
const FAST: Record<string, FlagSpec> = {
  ls: { short: "aAbBcCdfFgGhHiklLmnNopqQrRsStuUvxXZ1", shortValue: "IwT", long: ["--all", "--almost-all", "--human-readable", "--recursive", "--reverse", "--classify", "--directory", "--inode", "--size", "--dereference", "--no-group", "--numeric-uid-gid", "--full-time", "--group-directories-first", "--color", "--si"], longValue: ["--color", "--sort", "--time", "--format", "--block-size", "--ignore", "--hide", "--width", "--time-style", "--indicator-style", "--quoting-style"] },
  cat: { short: "AbeEnstTuv", long: ["--number", "--number-nonblank", "--show-all", "--show-ends", "--show-tabs", "--squeeze-blank", "--show-nonprinting"] },
  head: { short: "qvz", shortValue: "nc", numeric: true, long: ["--quiet", "--silent", "--verbose", "--zero-terminated"], longValue: ["--lines", "--bytes"] },
  tail: { short: "qvz", shortValue: "nc", numeric: true, long: ["--quiet", "--silent", "--verbose", "--zero-terminated"], longValue: ["--lines", "--bytes"] },
  wc: { short: "cmlLw", long: ["--bytes", "--chars", "--lines", "--words", "--max-line-length"] },
  grep: {
    short: "ivnclLwxrRhHoqsEFGPzZabUTIy", shortValue: "ABCmefd", numeric: true,
    long: ["--ignore-case", "--invert-match", "--line-number", "--count", "--files-with-matches", "--files-without-match", "--word-regexp", "--line-regexp",
      "--recursive", "--dereference-recursive", "--no-filename", "--with-filename", "--only-matching", "--quiet", "--silent", "--no-messages", "--extended-regexp",
      "--fixed-strings", "--basic-regexp", "--perl-regexp", "--text", "--byte-offset", "--null", "--null-data", "--color", "--colour"],
    longValue: ["--include", "--exclude", "--exclude-dir", "--color", "--colour", "--max-count", "--after-context", "--before-context", "--context", "--regexp", "--file", "--binary-files", "--directories", "--devices", "--label"],
  },
  rg: {
    short: "iSsnNlcwvFxuLHhoqaUIpb0", shortValue: "gtTefABCmMjr", numeric: false,
    long: ["--hidden", "--no-ignore", "--files", "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--json", "--line-number", "--no-line-number",
      "--no-heading", "--heading", "--color", "--smart-case", "--ignore-case", "--case-sensitive", "--fixed-strings", "--word-regexp", "--line-regexp", "--follow",
      "--type-list", "--stats", "--vimgrep", "--only-matching", "--trim", "--no-messages", "--invert-match", "--multiline", "--pretty", "--no-filename", "--with-filename",
      "--column", "--byte-offset", "--null", "--text", "--unrestricted", "--no-config", "--quiet", "--passthru"],
    longValue: ["--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--max-count", "--context", "--after-context", "--before-context", "--max-depth",
      "--max-filesize", "--max-columns", "--sort", "--sortr", "--color", "--colors", "--replace", "--threads", "--encoding", "--type-add"],
  },
  find: {
    short: "", positionals: true,
    words: ["-H", "-L", "-P", "-print", "-print0", "-ls", "-empty", "-readable", "-writable", "-executable", "-prune", "-quit", "-true", "-false", "-not", "-a",
      "-and", "-o", "-or", "-depth", "-xdev", "-mount", "-follow", "-nouser", "-nogroup", "-daystart", "-noleaf", "-ignore_readdir_race"],
    wordValue: ["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-regextype", "-type", "-xtype", "-maxdepth", "-mindepth",
      "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-anewer", "-cnewer", "-user", "-group", "-uid", "-gid", "-perm", "-links",
      "-inum", "-samefile", "-lname", "-ilname", "-used", "-printf"],
  },
  pwd: { short: "LP" },
  echo: { short: "neE" },
  printf: {},
  date: { short: "uRI", shortValue: "d", long: ["--utc", "--universal", "--rfc-email", "--iso-8601"], longValue: ["--date", "--iso-8601", "--rfc-3339"] },
  which: { short: "a" },
  type: { short: "atpP" },
  df: { short: "hHkTaiPlx", shortValue: "t", long: ["--human-readable", "--si", "--total", "--inodes", "--local", "--portability", "--all", "--print-type"], longValue: ["--type", "--output", "--exclude-type", "--block-size"] },
  du: { short: "shackmxLbl0", shortValue: "d", long: ["--summarize", "--human-readable", "--apparent-size", "--total", "--si", "--bytes", "--one-file-system", "--dereference", "--count-links"], longValue: ["--max-depth", "--threshold", "--time", "--exclude", "--block-size"] },
  ps: { short: "aAefFlLuxwjHTrN", shortValue: "opuUCgGt", long: ["--forest", "--no-headers", "--headers"], longValue: ["--sort", "--pid", "--ppid", "--user", "--format", "--cols", "--columns"] },
  stat: { short: "fLt", shortValue: "c", long: ["--file-system", "--dereference", "--terse"], longValue: ["--format", "--printf"] },
  file: { short: "biLzkN", long: ["--brief", "--mime", "--mime-type", "--mime-encoding", "--dereference", "--uncompress", "--keep-going", "--no-pad"] },
  jq: { short: "rcnesSjaMC", long: ["--raw-output", "--compact-output", "--slurp", "--sort-keys", "--null-input", "--exit-status", "--tab", "--join-output", "--ascii-output", "--monochrome-output", "--color-output", "--raw-input"], longValue: ["--indent"], longTwo: ["--arg", "--argjson"] },
  yq: { short: "reCMP", long: ["--exit-status", "--colors", "--no-colors", "--prettyPrint"] },
  tree: { short: "adfilshDCnpugFqNQrtvUx", shortValue: "LIP", long: ["--noreport", "--dirsfirst", "--du", "--prune", "--matchdirs", "--ignore-case"], longValue: ["--filelimit", "--charset", "--sort"] },
  // speed-fastpath: `env` / `printenv` with no command print every environment variable, tokens included, so they
  // are never fast (static.ts marks them a credential read). `sort` and `uniq` only filter a pipe: no -o/--output,
  // no --compress-program (sort runs it), and uniq at most ONE positional (its second one is an output file).
  sort: { short: "bdfgiMhnRrsuVcCz", shortValue: "ktS", long: ["--ignore-leading-blanks", "--dictionary-order", "--ignore-case", "--general-numeric-sort", "--human-numeric-sort", "--numeric-sort", "--reverse", "--stable", "--unique", "--version-sort", "--zero-terminated", "--check", "--month-sort", "--ignore-nonprinting"], longValue: ["--key", "--field-separator", "--buffer-size", "--sort", "--parallel"] },
  uniq: { short: "cdDiuz", shortValue: "fsw", long: ["--count", "--repeated", "--ignore-case", "--unique", "--zero-terminated"], longValue: ["--skip-fields", "--skip-chars", "--check-chars", "--all-repeated", "--group"] },
  uname: { short: "asnrvmpio", long: ["--all", "--kernel-name", "--nodename", "--kernel-release", "--kernel-version", "--machine", "--processor", "--hardware-platform", "--operating-system"] },
  true: {},
  cd: { short: "LPe@" },
  // 2026-09-21 coding bench: identity reads the Bot ran while debugging a permission error (each cost a ~8 s review).
  id: { short: "ugGnrz", long: ["--user", "--group", "--groups", "--name", "--real", "--zero"] },
  whoami: {},
  groups: {},
  // Listing an archive only (`tar -tf a.tar`, checked in fastSegmentOk); extraction and every other mode are not fast.
  tar: { short: "tvzjJf" },
};

/** git subcommands on the fast path; a global option before the subcommand (`-c`, `-C`, …) is never fast. */
const GIT_FAST: Record<string, FlagSpec> = {
  status: { short: "sbvz", shortValue: "u", long: ["--short", "--branch", "--long", "--porcelain", "--ignored", "--verbose", "--show-stash", "--ahead-behind", "--no-ahead-behind"], longValue: ["--porcelain", "--untracked-files", "--ignored", "--column"] },
  log: {
    ...GIT_DIFF_COMMON, numeric: true, shortValue: "UnSG",
    long: [...GIT_DIFF_COMMON.long, "--oneline", "--graph", "--decorate", "--all", "--reverse", "--no-merges", "--merges", "--abbrev-commit", "--follow", "--first-parent", "--date-order", "--topo-order", "--no-decorate", "--left-right", "--cherry-pick", "--source"],
    longValue: [...GIT_DIFF_COMMON.longValue, "--max-count", "--format", "--pretty", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep", "--date", "--decorate", "--skip"],
  },
  diff: { ...GIT_DIFF_COMMON, long: [...GIT_DIFF_COMMON.long, "--cached", "--staged", "--merge-base", "--no-index"] },
  show: { ...GIT_DIFF_COMMON, long: [...GIT_DIFF_COMMON.long, "--oneline", "--no-patch", "--abbrev-commit"], longValue: [...GIT_DIFF_COMMON.longValue, "--format", "--pretty", "--date"] },
  branch: { short: "arvl", long: ["--all", "--remotes", "--verbose", "--list", "--show-current", "--no-color", "--color"], longValue: ["--contains", "--no-contains", "--merged", "--no-merged", "--sort", "--color", "--points-at", "--format"] },
  "rev-parse": { short: "q", long: ["--show-toplevel", "--abbrev-ref", "--short", "--git-dir", "--is-inside-work-tree", "--verify", "--show-prefix", "--show-cdup", "--absolute-git-dir", "--symbolic-full-name", "--quiet"], longValue: ["--short", "--abbrev-ref"] },
};

/** Checks every argument of one program invocation against its spec. */
function argsOk(spec: FlagSpec, args: string[]): boolean {
  const has = (list: string[] | undefined, x: string) => (list ?? []).includes(x);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return spec.positionals !== false;
    if (!a.startsWith("-") || a === "-") {
      if (spec.positionals === false) return false;
      continue;
    }
    if (spec.words && (has(spec.words, a) || has(spec.wordValue, a))) { if (has(spec.wordValue, a)) i++; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (eq !== -1) { if (!has(spec.longValue, name)) return false; continue; }
      if (has(spec.longTwo, name)) { i += 2; continue; }
      if (has(spec.long, name)) continue;
      if (has(spec.longValue, name)) { i++; continue; }
      return false;
    }
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    if (spec.words) return false;
    for (let k = 1; k < a.length; k++) {
      const c = a[k] as string;
      if ((spec.shortValue ?? "").includes(c)) { if (k === a.length - 1) i++; break; }
      if (!(spec.short ?? "").includes(c)) return false;
    }
  }
  return true;
}

/** A fast program's value-taking options (speed-fastpath: static.ts tells an option's value from a file operand). */
export function fastValueOptions(prog: string): { shortValue: string; longValue: readonly string[]; long: readonly string[]; numeric: boolean } | null {
  const spec = FAST[prog];
  return spec ? { shortValue: spec.shortValue ?? "", longValue: spec.longValue ?? [], long: spec.long ?? [], numeric: spec.numeric === true } : null;
}

/** True when this program invocation may take the fast path (tier 0); wrappers and assignments are already stripped. */
export function fastSegmentOk(prog: string, args: string[]): boolean {
  if (prog === "git") {
    const sub = args[0] ?? "";
    if (sub === "remote") return args.length === 1 || (args.length === 2 && (args[1] === "-v" || args[1] === "--verbose"));
    const spec = GIT_FAST[sub];
    if (!spec) return false;
    const rest = args.slice(1);
    // `git branch <name>` creates a branch; positionals are read-only only in list mode.
    if (sub === "branch" && !rest.some((a) => a === "--list" || a === "-l" || /^-[a-z]*l/.test(a)) && rest.some((a, i) => !a.startsWith("-") && !/^--(contains|no-contains|merged|no-merged|sort|points-at|format)$/.test(rest[i - 1] ?? ""))) return false;
    return argsOk(spec, rest);
  }
  // sed: only `sed -n <addr>p <file…>`, the line-range print (`sed -n '60,100p' f`); every other script can
  // write (`w`), run (`e`) or edit in place (`-i`), so it is never fast.
  if (prog === "sed") return args.length >= 3 && args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1] as string) && args.slice(2).every((a) => !a.startsWith("-"));
  // tar: only a dash-form list cluster first (`-tf`, `-tvzf`); old-style `tar xf …` is never fast.
  if (prog === "tar" && !/^-[vzjJf]*t[tvzjJf]*$/.test(args[0] ?? "")) return false;
  // echo prints its arguments; a dash-leading one that is not an -n/-e/-E cluster is printed too (`echo ---`), so no
  // argument can make it do anything else. Expansions and redirects never reach here (the shell analyzer owns them).
  if (prog === "echo") return true;
  // ps: a BSD-style word with `e` (`ps e`, `ps axe`, `ps eww`) prints every process's environment, tokens included.
  if (prog === "ps" && args.some((a) => /^[A-Za-z]+$/.test(a) && a.includes("e"))) return false;
  // uniq's second operand is an OUTPUT file.
  if (prog === "uniq" && args.filter((a) => !a.startsWith("-") || a === "-").length > 1) return false;
  const spec = FAST[prog];
  return !!spec && argsOk(spec, args);
}
