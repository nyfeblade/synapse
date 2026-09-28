import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bug #66: runs the REAL per-Bot-uid helpers (box/files/bot-user, bot-claude-as-box, the session helpers) on this Mac
 * against a temp tree, with the account database and every privileged command shimmed:
 *  - T/etc/passwd and T/etc/group are the account database; `getent`, `useradd`, `groupadd`, `userdel`, `groupdel`
 *    read and edit them (and log).
 *  - `id -u` answers FAKE_UID (0 = root by default).
 *  - `setpriv` logs its arguments, then runs the command after `--` unconfined but with FAKE_UID = the --reuid it asked for.
 *  - `chown` and `pkill` only log; `flock` is a no-op; `python3` is the real one with pwd/fchown faked from T/etc so the
 *    O_NOFOLLOW staging code really runs (fchown is logged, never applied).
 * Absolute paths in a helper are rewritten into T, as host/test/box/sandbox.ts does.
 */
const FILES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../box/files");
const ME = os.userInfo().uid;
export const BOTHOST_UID = ME; // bothost owns what the test process creates
export const BOTHOST_GID = 4242;

export interface Call { cmd: string; args: string[] }

export class FakeUsers {
  readonly T: string;
  private shim: string;
  private logFile: string;

  constructor() {
    this.T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "botuid-")));
    this.shim = this.p("shim");
    this.logFile = this.p("calls.log");
    for (const d of ["shim", "etc", "run", "var/lib/bots", "home/box/.claude/skills", "home/box/.claude/projects/-workspace", "workspace/.host-out/uploads",
      "workspace/.host-out/screens", "workspace/.host-out/events", "libexec", "py"]) fs.mkdirSync(this.p(d), { recursive: true });
    fs.writeFileSync(this.p("etc/passwd"), [
      "root:x:0:0:root:/root:/bin/bash", "box:x:1001:1001::/home/box:/bin/bash", `bothost:x:${BOTHOST_UID}:${BOTHOST_GID}::/var/lib/bothost:/usr/sbin/nologin`,
      "alex:x:1000:1000::/home/alex:/bin/bash", ""].join("\n"));
    fs.writeFileSync(this.p("etc/group"), ["root:x:0:", "box:x:1001:", `bothost:x:${BOTHOST_GID}:`, "bots:x:1002:box,bothost", ""].join("\n"));
    fs.writeFileSync(this.logFile, "");
    this.writeShims();
  }

  p(...rel: string[]): string { return path.join(this.T, ...rel); }

  /** Paths in the helpers, mapped into T (longest first). */
  private rewrite(src: string): string {
    const map: [string, string][] = [
      ["/usr/bin/setpriv", this.p("shim", "setpriv")], ["/usr/bin/getent", this.p("shim", "getent")], ["/usr/local/libexec/", `${this.p("libexec")}/`], ["/usr/local/bin/claude", this.p("shim", "claude")],
      ["/home/bots", this.p("home/bots")], ["/home/box", this.p("home/box")], ["/workspace", this.p("workspace")],
      ["/var/lib/bots", this.p("var/lib/bots")], ["/run/bot-user.lock", this.p("run/bot-user.lock")], ["/run/bots-shell", this.p("run/bots-shell")], ["/run/bot-x", this.p("run/bot-x")], ["/run/systemd/system", this.p("run/systemd/system")], ["/etc/systemd/system", this.p("etc/systemd/system")], ["/usr/local/lib/bots/", `${this.p("libexec")}/`],
    ];
    let out = src;
    for (const [a, b] of map) out = out.split(a).join(b);
    return out.replace(/^#!\/bin\/sh/, "#!/bin/dash");
  }

  install(helper: string): string {
    const dest = this.p("libexec", helper);
    fs.writeFileSync(dest, this.rewrite(fs.readFileSync(path.join(FILES, helper), "utf8")));
    fs.chmodSync(dest, 0o755);
    return dest;
  }

  run(helper: string, args: string[], env: Record<string, string> = {}, input?: string) {
    const file = this.install(helper);
    const r = spawnSync(file, args, {
      encoding: "utf8", input,
      env: { PATH: `${this.shim}:/usr/bin:/bin:/usr/sbin:/sbin`, SHIM_LOG: this.logFile, FAKE_ETC: this.p("etc"), FAKE_UID: "0", SUDO_USER: "bothost",
        PYTHONPATH: this.p("py"), ...env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  calls(): Call[] {
    return fs.readFileSync(this.logFile, "utf8").split("\n").filter(Boolean).map((l) => { const [cmd, ...args] = l.split("\t"); return { cmd: cmd!, args }; });
  }
  clearCalls(): void { fs.writeFileSync(this.logFile, ""); }

  passwd(name: string): string[] | null {
    const l = fs.readFileSync(this.p("etc/passwd"), "utf8").split("\n").find((x) => x.startsWith(`${name}:`));
    return l ? l.split(":") : null;
  }
  groupOf(name: string): string[] | null {
    const l = fs.readFileSync(this.p("etc/group"), "utf8").split("\n").find((x) => x.startsWith(`${name}:`));
    return l ? l.split(":") : null;
  }
  addPasswd(line: string): void { fs.appendFileSync(this.p("etc/passwd"), `${line}\n`); }

  cleanup(): void { fs.rmSync(this.T, { recursive: true, force: true }); }

  private writeShims(): void {
    const w = (name: string, body: string) => { fs.writeFileSync(path.join(this.shim, name), `#!/bin/bash\n${body}\n`); fs.chmodSync(path.join(this.shim, name), 0o755); };
    const log = `{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$SHIM_LOG"`;
    w("id", `if [ "$1" = -nG ]; then awk -F: -v n="$2" '{ split($4, m, ","); for (i in m) if (m[i]==n) print $1 }' "$FAKE_ETC/group" | tr '\\n' ' '; echo; exit 0; fi
if [ "$1" = -un ]; then awk -F: -v u="\${FAKE_UID:-0}" '$3==u{print $1; exit}' "$FAKE_ETC/passwd"; exit 0; fi
if [ "$1" = -u ] && [ -z "$2" ]; then echo "\${FAKE_UID:-0}"; elif [ "$1" = -u ]; then awk -F: -v n="$2" '$1==n{print $3; f=1} END{exit !f}' "$FAKE_ETC/passwd"; else /usr/bin/id "$@"; fi`);
    w("getent", `db="$1"; key="$2"; f="$FAKE_ETC/$db"
if [ -z "$key" ]; then grep -v '^$' "$f"; exit 0; fi
awk -F: -v k="$key" '($1==k || $3==k){print; f=1} END{exit !f}' "$f" || exit 2`);
    w("groupadd", `${log}
if [ "$1" = --system ]; then gid=990; n="$2"; else [ "$1" = -g ] || exit 9; gid="$2"; n="$3"; fi
grep -q "^$n:" "$FAKE_ETC/group" && exit 9
echo "$n:x:$gid:" >> "$FAKE_ETC/group"`);
    w("useradd", `${log}
while [ $# -gt 1 ]; do case "$1" in -u) u="$2"; shift 2;; -g) g="$2"; shift 2;; -G) G="$2"; shift 2;; -d) d="$2"; shift 2;; -s) s="$2"; shift 2;; -c) c="$2"; shift 2;; -M) shift;; *) exit 9;; esac; done
n="$1"; grep -q "^$n:" "$FAKE_ETC/passwd" && exit 9
gid=$(awk -F: -v k="$g" '$1==k{print $3}' "$FAKE_ETC/group")
echo "$n:x:$u:$gid:$c:$d:$s" >> "$FAKE_ETC/passwd"
for grp in \${G//,/ }; do sed -i '' -E "s/^($grp:x:[0-9]+:)(.*)$/\\1\\2,$n/; s/^($grp:x:[0-9]+:),/\\1/" "$FAKE_ETC/group"; done`);
    w("usermod", `${log}
[ "$1" = -aG ] || exit 9; grp="$2"; n="$3"
sed -i '' -E "s/^($grp:x:[0-9]+:)(.*)$/\\1\\2,$n/; s/^($grp:x:[0-9]+:),/\\1/" "$FAKE_ETC/group"`);
    w("mount", log);
    w("findmnt", "echo rw,nosuid");
    w("userdel", `${log}
sed -i '' "/^$1:/d" "$FAKE_ETC/passwd"; sed -i '' -E "s/,$1(,|$)/\\1/; s/:$1,/:/; s/:$1$/:/" "$FAKE_ETC/group"`);
    w("groupdel", `${log}
sed -i '' "/^$1:/d" "$FAKE_ETC/group"`);
    w("setpriv", `${log}
while [ $# -gt 0 ] && [ "$1" != -- ]; do case "$1" in --reuid=*) r="\${1#--reuid=}";; esac; shift; done; shift
case "$r" in ''|*[!0-9]*) r=$(awk -F: -v n="$r" '$1==n{print $3}' "$FAKE_ETC/passwd");; esac
FAKE_UID="$r" exec "$@"`);
    w("chown", log);
    w("pkill", log);
    w("flock", ":");
    // GNU rm's --one-file-system is not in BSD rm: logged, then dropped.
    w("rm", `${log}
a=(); for x in "$@"; do [ "$x" = --one-file-system ] || a+=("$x"); done; exec /bin/rm "\${a[@]}"`);
    // BSD chmod has no "--"; GNU ln -T (no-clobber publish) is a hard link that fails if the name exists.
    w("chmod", `a=(); for x in "$@"; do [ "$x" = -- ] || a+=("$x"); done; exec /bin/chmod "\${a[@]}"`);
    w("ln", `a=(); T=0; for x in "$@"; do case "$x" in -T) T=1;; --) ;; *) a+=("$x");; esac; done
if [ $T = 1 ]; then exec perl -e 'link($ARGV[0], $ARGV[1]) or die "ln: $!\\n"' "\${a[@]}"; fi; exec /bin/ln "\${a[@]}"`);
    w("claude", `${log}
echo "HOME=$HOME USER=$USER CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR umask=$(umask)"
echo "cwd=$(pwd -P)" >&2`);
    w("install", `${log}
d=0; m=""; while [ $# -gt 0 ]; do case "$1" in -d) d=1; shift;; -o|-g) shift 2;; -m) m="$2"; shift 2;; *) break;; esac; done
if [ $d = 0 ]; then /bin/cp "$1" "$2"; [ -n "$m" ] && /bin/chmod "$m" "$2"; exit 0; fi
for x in "$@"; do mkdir -p "$x"; [ -n "$m" ] && /bin/chmod "$m" "$x"; done; exit 0`);
    // GNU-only spellings the helpers use: stat -c %U (bothost = the test's own uid), realpath -m, find -perm /mode.
    w("stat", `[ "$1" = -c ] || exec /usr/bin/stat "$@"; fmt="$2"; f="$3"; [ "$f" = -- ] && f="$4"
case "$fmt" in
  %U) o=$(/usr/bin/stat -f %u "$f") || exit 1; [ "$o" = "$(/usr/bin/id -u)" ] && echo bothost || echo "uid$o" ;;
  %u:%g) /usr/bin/stat -f %u:%g "$f" ;;
  *) exit 9 ;;
esac`);
    // GNU date +%s%3N (milliseconds); BSD date has no %N.
    w("date", `[ "$1" = +%s%3N ] && exec perl -MTime::HiRes=time -e 'printf "%d\\n", time()*1000'; exec /bin/date "$@"`);
    w("tac", 'exec tail -r "$@"');
    w("sync", ":");
    w("chgrp", log);
    w("mv", `a=(); for x in "$@"; do case "$x" in -T|--) ;; *) a+=("$x");; esac; done; exec /bin/mv "\${a[@]}"`);
    w("realpath", `a=(); for x in "$@"; do case "$x" in -m|--) ;; *) a+=("$x");; esac; done
exec python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "\${a[@]}"`);
    w("find", `a=(); for x in "$@"; do case "$x" in /0*) a+=("+\${x#/}");; *) a+=("$x");; esac; done; exec /usr/bin/find "\${a[@]}"`);
    w("systemd-run", log);
    w("runuser", log);
    w("xauth", `${log}
prev=; for a in "$@"; do [ "$prev" = -f ] && : > "$a"; prev="$a"; done`);
    w("mcookie", "echo 0123abcd");
    w("systemctl", log);
    // python3: the real interpreter, with the account database and fchown faked (sitecustomize).
    fs.writeFileSync(this.p("py", "sitecustomize.py"), `import os, pwd, fcntl, collections
_etc = os.environ.get("FAKE_ETC")
if _etc:
    _P = collections.namedtuple("P", "pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell")
    def _getpwnam(n):
        for l in open(os.path.join(_etc, "passwd")):
            f = l.rstrip("\\n").split(":")
            if f[0] == n: return _P(f[0], f[1], int(f[2]), int(f[3]), f[4], f[5], f[6])
        raise KeyError(n)
    pwd.getpwnam = _getpwnam
    def _fchown(fd, u, g):
        p = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\\0" * 1024).rstrip(b"\\0").decode()
        with open(os.environ["SHIM_LOG"], "a") as log: log.write("fchown\\t%s\\t%d\\t%d\\n" % (p, u, g))
    os.fchown = _fchown
`);
  }
}
