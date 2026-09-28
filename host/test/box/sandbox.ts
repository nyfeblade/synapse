import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Final secfix round 3, ruling 1: runs the REAL box/files helpers on this Mac against a temp tree that mirrors the
 * box (T/home/box, T/workspace, T/run, T/var/lib/bots, T/etc = "a root-only place"), with the privileged commands
 * shimmed through PATH:
 *
 *  - `id` answers from FAKE_UID (0 = root; 1001 = box; 999 = bothost), so a helper believes it runs as root.
 *  - `setpriv` logs its arguments and cwd, then runs the command with FAKE_UID of the target user inside a macOS
 *    sandbox-exec profile that grants exactly that user's write (and, for box, read) rights on the tree: box may
 *    write T/home/box (not .host) and T/workspace (not .host-out) and can't read T/home/box/.host; bothost may write
 *    T/home/box/.host, T/workspace/.host-out and T/var/lib/bothost. A write through a link into T/etc (or anywhere
 *    the user can't write) is denied by the kernel, exactly as on the box. "root" (FAKE_UID=0) is unconfined.
 *  - every mutating command (mkdir mv ln rm chown chmod install mktemp cp touch rmdir tar zstd rsync sqlite3 …) is a
 *    logging wrapper: one line per call with FAKE_UID, so a test can assert that root never mutated a box- or
 *    bothost-writable path. mv -T / ln -T get GNU semantics (perl); chown is logged only.
 *  - service/process tools (systemctl, systemd-run, kill, pgrep, xauth, mcookie, …) are logged stubs.
 *
 * Each helper is copied with its absolute paths rewritten into T and its `#!/bin/sh` shebang pointed at /bin/dash
 * (Debian's /bin/sh), so the POSIX sh helpers are exercised by dash.
 */
export const BOX_UID = 1001;
export const BOTHOST_UID = 999;
const FILES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files");

export interface LogEntry { uid: number; cmd: string; args: string[]; cwd: string }
export interface RunResult { status: number | null; stdout: string; stderr: string; log: LogEntry[] }

const MUTATORS = ["mkdir", "mv", "ln", "rm", "chown", "chmod", "install", "mktemp", "cp", "touch", "rmdir", "tar", "zstd", "rsync", "sqlite3", "tee", "truncate", "cat", "head", "xauth"];
const STUBS = ["systemctl", "systemd-run", "kill", "pgrep", "mcookie", "sha256sum", "du", "df", "sleep", "claude", "git", "visudo"];

export class Sandbox {
  readonly T: string;
  readonly shim: string;
  readonly bin: string;
  readonly logFile: string;

  /** `realTools`: these archive tools run for real (logged, then the system binary), for tests that need real data. */
  constructor(private o: { realTools?: ("tar" | "zstd" | "rsync")[] } = {}) {
    this.T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boxsbx-")));
    this.shim = path.join(this.T, "shim");
    this.bin = path.join(this.T, "bin");
    this.logFile = path.join(this.T, "log", "calls.log");
    for (const d of ["shim", "bin", "log", "tmp", "etc", "run", "var/lib/bots", "var/lib/bothost", "home/box/.claude/projects/-workspace", "home/box/.claude/skills",
      "home/box/.host/run", "home/box/.host/snapshots", "home/box/agent-data", "home/box/reference", "workspace/.host-out"]) fs.mkdirSync(path.join(this.T, d), { recursive: true });
    fs.writeFileSync(path.join(this.T, "etc", "shadow"), "root:SECRET-HASH\n");
    fs.writeFileSync(this.logFile, "");
    this.writeShims();
  }

  p(...rel: string[]): string { return path.join(this.T, ...rel); }

  /** Box-writable / bothost-writable places, as sandbox-exec write allowances. */
  private profile(uid: number): string | null {
    const sp = (x: string) => `(subpath "${this.p(x)}")`;
    if (uid === BOX_UID) {
      return `(version 1)(allow default)(deny file-write* (subpath "${this.T}"))` +
        `(allow file-write* ${sp("home/box")} ${sp("workspace")} ${sp("tmp")} ${sp("log")})` +
        `(deny file-write* ${sp("home/box/.host")} ${sp("workspace/.host-out")} ${sp("home/box/agent-data")} ${sp("home/box/reference")})` +
        `(deny file-read* ${sp("home/box/.host")} ${sp("etc")} ${sp("var/lib/bots/snapshot-stage")})`;
    }
    if (uid === BOTHOST_UID) {
      return `(version 1)(allow default)(deny file-write* (subpath "${this.T}"))` +
        `(allow file-write* ${sp("home/box/.host")} ${sp("workspace/.host-out")} ${sp("home/box/agent-data")} ${sp("var/lib/bothost")} ${sp("tmp")} ${sp("log")})` +
        `(deny file-read* ${sp("etc")} ${sp("var/lib/bots/snapshot-stage")})`;
    }
    return null;
  }

  private writeShims(): void {
    const w = (name: string, body: string) => { fs.writeFileSync(path.join(this.shim, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(this.shim, name), 0o755); };
    // One write per line (O_APPEND), so a pipeline's two logged commands never interleave their lines.
    const log = `_l=$(printf '%s\\t%s\\t%s' "\${FAKE_UID:-0}" "$(basename "$0")" "$PWD"; for a in "$@"; do printf '\\t%s' "$a"; done); printf '%s\\n' "$_l" >> "$SHIM_LOG"`;
    w("id", `case "$*" in
  "-u") echo "\${FAKE_UID:-0}" ;;
  "-u box") echo ${BOX_UID} ;;
  "-u bothost") echo ${BOTHOST_UID} ;;
  "-un") case "\${FAKE_UID:-0}" in 0) echo root;; ${BOX_UID}) echo box;; ${BOTHOST_UID}) echo bothost;; *) echo nobody;; esac ;;
  *) exec /usr/bin/id "$@" ;;
esac`);
    // setpriv: log, then run as the target user inside that user's sandbox profile.
    const boxProf = this.profile(BOX_UID)!.replace(/'/g, "");
    const hostProf = this.profile(BOTHOST_UID)!.replace(/'/g, "");
    w("setpriv", `${log}
uid=""; reset=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reuid=box) uid=${BOX_UID} ;;
    --reuid=bothost) uid=${BOTHOST_UID} ;;
    --reuid=*) echo "setpriv shim: unknown user $1" >&2; exit 97 ;;
    --reset-env) reset=1 ;;
    --) shift; break ;;
    *) ;;
  esac
  shift
done
[ -n "$uid" ] || { echo "setpriv shim: no --reuid" >&2; exit 97; }
[ "\${FAKE_UID:-0}" = 0 ] || { echo "setpriv: setresuid failed: Operation not permitted" >&2; exit 1; }
case "$uid" in ${BOX_UID}) prof='${boxProf}' ;; *) prof='${hostProf}' ;; esac
if [ "$reset" = 1 ]; then
  exec /usr/bin/sandbox-exec -p "$prof" /usr/bin/env -i PATH="$PATH" SHIM_LOG="$SHIM_LOG" SHIM_STAT_U="\${SHIM_STAT_U:-}" SHIM_PGREP="\${SHIM_PGREP:-}" FAKE_UID="$uid" HOME=/nonexistent "$@"
fi
exec /usr/bin/sandbox-exec -p "$prof" /usr/bin/env FAKE_UID="$uid" "$@"`);
    // env: GNU -C DIR support (macOS env may lack it); logged so a test can see the cwd a command got.
    w("env", `${log}
args=""; dir=""; clear=0
while [ $# -gt 0 ]; do
  case "$1" in
    -i) clear=1 ;;
    -C) shift; dir="$1" ;;
    --chdir=*) dir="\${1#--chdir=}" ;;
    *) break ;;
  esac
  shift
done
if [ -n "$dir" ]; then cd "$dir" || exit 125; fi
if [ "$clear" = 1 ]; then exec /usr/bin/env -i PATH="$PATH" SHIM_LOG="$SHIM_LOG" FAKE_UID="\${FAKE_UID:-0}" "$@"; fi
exec /usr/bin/env "$@"`);
    for (const m of MUTATORS) {
      if (m === "mv") {
        w("mv", `${log}
T=0; F=0
while [ $# -gt 0 ]; do case "$1" in -T) T=1 ;; -f) F=1 ;; -fT|-Tf) T=1; F=1 ;; --) shift; break ;; -*) ;; *) break ;; esac; shift; done
if [ "$T" = 1 ]; then
  exec /usr/bin/perl -e 'my ($s,$d)=@ARGV; if (-d $d && ! -l $d) { print STDERR "mv: cannot overwrite directory \\x27$d\\x27 with non-directory\\n"; exit 1 } rename($s,$d) or do { print STDERR "mv: $!\\n"; exit 1 }' -- "$1" "$2"
fi
exec /bin/mv -f -- "$@"`);
      } else if (m === "ln") {
        w("ln", `${log}
T=0; S=0
while [ $# -gt 0 ]; do case "$1" in -T) T=1 ;; -s) S=1 ;; -sT|-Ts) S=1; T=1 ;; --) shift; break ;; -*) ;; *) break ;; esac; shift; done
if [ "$S" = 1 ]; then exec /bin/ln -s -- "$@"; fi
exec /usr/bin/perl -e 'my ($s,$d)=@ARGV; link($s,$d) or do { print STDERR "ln: failed to create hard link \\x27$d\\x27: $!\\n"; exit 1 }' -- "$1" "$2"`);
      } else if (m === "chmod") {
        // GNU accepts "chmod MODE -- FILE"; BSD would take "--" as a file name.
        w("chmod", `${log}\nm="$1"; shift; [ "$1" = "--" ] && shift\nexec /bin/chmod "$m" "$@"`);
      } else if (m === "chown") {
        w("chown", log);
      } else if (m === "install") {
        w("install", `${log}
mode=""; dir=0
while [ $# -gt 0 ]; do case "$1" in -d) dir=1 ;; -m) shift; mode="$1" ;; -o|-g) shift ;; --) shift; break ;; -*) ;; *) break ;; esac; shift; done
if [ "$dir" = 1 ]; then for d in "$@"; do /bin/mkdir -p -- "$d" || exit 1; [ -z "$mode" ] || /bin/chmod "$mode" "$d" || exit 1; done; exit 0; fi
/bin/cp -- "$1" "$2" || exit 1; [ -z "$mode" ] || /bin/chmod "$mode" "$2"`);
      } else if ((this.o.realTools as string[] | undefined)?.includes(m)) {
        w(m, `${log}\nexec ${realTool(m)} "$@"`);
      } else if (["tar", "zstd", "rsync", "sqlite3", "xauth"].includes(m)) {
        w(m, `${log}
case "$(basename "$0") $*" in
  "tar "*-cf\\ -*|"tar "*"-cf -"*) printf 'TAR' ;;
  "zstd "*-dc*) printf 'TAR' ;;
esac
exit 0`);
      } else {
        const real = fs.existsSync(`/bin/${m}`) ? `/bin/${m}` : `/usr/bin/${m}`;
        w(m, `${log}\nexec ${real} "$@"`);
      }
    }
    for (const s of STUBS) {
      w(s, `${log}
case "$(basename "$0")" in
  pgrep) [ -z "$SHIM_PGREP" ] || printf '%s\\n' $SHIM_PGREP ;;
  sha256sum) echo "0000  -" ;;
  du) echo "1 x" ;;
  df) printf 'Avail\\n999999999\\n' ;;
esac
exit 0`);
    }
    // stat: GNU -c %U / %a / %U:%a (owner name comes from SHIM_STAT_U: files here are all the test user's)
    w("stat", `if [ "$1" = -c ]; then fmt="$2"; f="$3"; [ "$f" = "--" ] && f="$4"
  [ -e "$f" ] || [ -L "$f" ] || { echo "stat: cannot statx '$f': No such file or directory" >&2; exit 1; }
  a=$(/usr/bin/stat -f %Lp "$f"); u="\${SHIM_STAT_U:-bothost}"
  printf '%s\\n' "$fmt" | sed "s/%U/$u/g; s/%a/$a/g"; exit 0; fi
exec /usr/bin/stat "$@"`);
  }

  /** Copies box/files/<name> into T/bin with its paths pointed into T; returns the copy's path. */
  install(name: string): string {
    let s = fs.readFileSync(path.join(FILES, name), "utf8");
    s = s.replace(/^#!\/bin\/sh\b/, "#!/bin/dash");
    const T = this.T;
    s = s.replace(/\/usr\/local\/libexec\//g, `${this.bin}/`).replace(/\/usr\/local\/lib\/bots\//g, `${this.bin}/`)
      .replace(/\/usr\/bin\/env\b/g, `${this.shim}/env`).replace(/\/usr\/bin\/git\b/g, `${this.shim}/git`).replace(/\/usr\/local\/bin\/claude\b/g, `${this.shim}/claude`)
      .replace(/(^|[^\w.-])\/home\/box/g, `$1${T}/home/box`).replace(/(^|[^\w.-])\/workspace/g, `$1${T}/workspace`).replace(/(^|[^\w.-])\/run\//g, `$1${T}/run/`)
      .replace(/(^|[^\w.-])\/var\/lib\/bots/g, `$1${T}/var/lib/bots`).replace(/(^|[^\w.-])\/proc\//g, `$1${T}/proc/`).replace(/(^|[^\w.-])\/tmp\//g, `$1${T}/tmp/`)
      .replace(/(^|[^\w.-])\/etc\/bots\//g, `$1${T}/etc/bots/`);
    const out = path.join(this.bin, name);
    fs.writeFileSync(out, s);
    fs.chmodSync(out, 0o755);
    return out;
  }

  run(name: string, args: string[], o: { input?: string | Buffer; sudoUser?: string | null; uid?: number; env?: Record<string, string>; cwd?: string; prefix?: string } = {}): RunResult {
    fs.writeFileSync(this.logFile, "");
    const helper = this.install(name);
    const env: Record<string, string> = {
      PATH: `${this.shim}:/usr/bin:/bin:/usr/sbin:/sbin`, SHIM_LOG: this.logFile, FAKE_UID: String(o.uid ?? 0), TMPDIR: this.p("tmp"), ...(o.env ?? {}),
    };
    if (o.sudoUser !== null) env.SUDO_USER = o.sudoUser ?? "bothost";
    // `prefix` runs a shell snippet first and then execs the helper in the same process (same PID), for the
    // "plant a link named after the helper's PID" attack.
    const r = o.prefix
      ? spawnSync("/bin/dash", ["-c", `${o.prefix}\nexec "$0" "$@"`, helper, ...args], { env, input: o.input ?? "", cwd: o.cwd ?? this.T, encoding: "utf8" })
      : spawnSync(helper, args, { env, input: o.input ?? "", cwd: o.cwd ?? this.T, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: this.readLog() };
  }

  readLog(): LogEntry[] {
    return fs.readFileSync(this.logFile, "utf8").split("\n").filter(Boolean).map((l) => {
      const [uid, cmd, cwd, ...args] = l.split("\t");
      return { uid: Number(uid), cmd: cmd!, cwd: cwd!, args };
    });
  }

  /** Mutating calls made as root whose arguments name a path under T outside the given root-owned places. */
  rootMutations(log: LogEntry[], rootOwned: string[] = []): LogEntry[] {
    const ok = rootOwned.map((x) => this.p(x));
    return log.filter((e) => e.uid === 0 && MUTATORS.includes(e.cmd) && e.args.some((a) => a.startsWith(this.T) && !ok.some((r) => a === r || a.startsWith(`${r}/`))));
  }

  /** Everything under a directory, relative (for "nothing landed here" assertions). */
  tree(rel: string): string[] {
    const root = this.p(rel);
    if (!fs.existsSync(root)) return [];
    return (fs.readdirSync(root, { recursive: true }) as string[]).sort();
  }

  cleanup(): void { fs.rmSync(this.T, { recursive: true, force: true }); }
}

/** The system binary for a real archive tool (zstd comes from Homebrew on the Mac), or null. */
export function realTool(name: string): string | null {
  for (const d of ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"]) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}

export const setprivCalls = (log: LogEntry[]) => log.filter((e) => e.cmd === "setpriv");
/** Index of the first log entry, or Infinity. */
export const firstIndex = (log: LogEntry[], pred: (e: LogEntry) => boolean) => { const i = log.findIndex(pred); return i < 0 ? Infinity : i; };

/**
 * For validation-only tests: a PATH prefix whose `id -u` says root (so a helper takes its root stage) and whose
 * `setpriv` refuses loudly (exit 97), so a helper that gets past its argument checks never does anything real.
 */
let rootOnlyShim: string | null = null;
export function rootValidationPath(): string {
  if (!rootOnlyShim) {
    rootOnlyShim = fs.mkdtempSync(path.join(os.tmpdir(), "rootshim-"));
    fs.writeFileSync(path.join(rootOnlyShim, "id"), `#!/bin/sh\ncase "$*" in "-u") echo 0 ;; *) exec /usr/bin/id "$@" ;; esac\n`);
    fs.writeFileSync(path.join(rootOnlyShim, "setpriv"), `#!/bin/sh\necho "setpriv (validation-only test): would re-exec as $2" >&2\nexit 97\n`);
    for (const f of ["id", "setpriv"]) fs.chmodSync(path.join(rootOnlyShim, f), 0o755);
  }
  return `${rootOnlyShim}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}
