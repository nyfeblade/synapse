import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../config";

/**
 * Shared repos (coordinator decision 2026-09-22, bug-log 121). With per-Bot OS accounts (#66) git refuses a
 * /workspace repo another account owns ("dubious ownership"), so team repos stopped working. Trusting them is
 * only safe because a repo's own config can't run code in a Bot's git; /workspace is group-writable (2775,
 * group bots), so ANY Bot could already edit any repo's .git/config there. This shim is the one place both happen:
 *
 *  1. TRUST, /workspace only: when the repo git is about to open (after the leading -C options) is a directory
 *     under the workspace (real path), it adds `safe.directory=<that repo root>` as a command-scope pin
 *     (GIT_CONFIG_COUNT/KEY/VALUE, protected config). Bot homes, /home/box and everything else are never trusted.
 *     git 2.39 on the box has no `lead/*` pattern, hence the exact root, found per call (new clones work at once).
 *  2. NEUTRALIZE, per call: every config key that can run a program, keyed by a name the repo chooses (a filter,
 *     diff or merge driver, a remote, an alias, a pager, a credential URL, a tool), is read with `git config
 *     --list -z` (includes resolved) and pinned to an inert value the same way. Fixed-name keys are pinned for
 *     every Bot process by the env builder (spawn-options.ts GIT_NEUTRAL). A key and its value travel in separate
 *     env vars, so no name can smuggle a value in.
 *
 * A git started by absolute path gets the fixed pins but no trust, so a foreign repo is refused.
 */

/** Rules for keys whose NAME the repo picks, matched on the lower-cased name. First match wins. */
export const NAMED_EXEC_KEYS: readonly { pattern: string; value: string; why: string; onlyIfBang?: boolean }[] = Object.freeze([
  { pattern: "filter.*.clean", value: "cat", why: "clean filter runs on add/status/diff" },
  { pattern: "filter.*.smudge", value: "cat", why: "smudge filter runs on checkout" },
  { pattern: "filter.*.process", value: "", why: "long-running filter process" },
  { pattern: "filter.*.required", value: "false", why: "a neutralized required filter must not fail the command" },
  { pattern: "diff.*.textconv", value: "cat", why: "textconv runs on diff/log -p/show/blame/grep" },
  { pattern: "diff.*.command", value: "@BUILTIN_DIFF@", why: "a diff driver command beats diff.external" },
  { pattern: "merge.*.driver", value: "git merge-file --marker-size=%L %A %O %B", why: "custom merge driver" },
  // git keeps the FIRST value of these (remote.c), so a later pin can't override one: a repo that sets them has
  // its transport commands refused instead (fetch/pull/push/clone/ls-remote/remote/submodule).
  { pattern: "remote.*.uploadpack", value: "@REFUSE_TRANSPORT@", why: "fetch from a local remote runs it" },
  { pattern: "remote.*.receivepack", value: "@REFUSE_TRANSPORT@", why: "push to a local remote runs it" },
  { pattern: "credential.helper", value: "", why: "credential helper program" },
  { pattern: "credential.*.helper", value: "", why: "per-URL credential helper" },
  { pattern: "pager.*", value: "false", why: "pager.<cmd> string beats GIT_PAGER" },
  { pattern: "alias.*", value: "!false", why: "a `!` alias is a shell command", onlyIfBang: true },
  { pattern: "submodule.*.update", value: "checkout", why: "`!cmd` update runs on submodule update", onlyIfBang: true },
  { pattern: "difftool.*.cmd", value: "false", why: "git difftool" },
  { pattern: "difftool.*.path", value: "false", why: "git difftool" },
  { pattern: "mergetool.*.cmd", value: "false", why: "git mergetool" },
  { pattern: "mergetool.*.path", value: "false", why: "git mergetool" },
  { pattern: "man.*.cmd", value: "false", why: "git help" },
  { pattern: "man.*.path", value: "false", why: "git help" },
  { pattern: "browser.*.cmd", value: "false", why: "git web--browse / instaweb" },
  { pattern: "browser.*.path", value: "false", why: "git web--browse / instaweb" },
  { pattern: "tar.*.command", value: "false", why: "git archive custom format" },
  { pattern: "sendemail.*", value: "", why: "git send-email hooks and commands (tocmd, cccmd, sendmailcmd, smtpserver)" },
  { pattern: "gpg.*.program", value: "/bin/false", why: "signature programs for any format" },
]);

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shim's bash source. `realGit` is the git it wraps; `workspace` the one tree it may trust. */
export function renderGitShim(o: { realGit: string; workspace: string; builtinDiff: string } & GhHelperOptions): string {
  const gh = o.gh ?? GH_BIN;
  const ghHelper = sq(`!${gh} auth git-credential`);
  const cases = NAMED_EXEC_KEYS.map((r) => {
    if (r.value === "@REFUSE_TRANSPORT@") return `    ${r.pattern}) refuse="$name";;`;
    const v = r.value === "@BUILTIN_DIFF@" ? o.builtinDiff : r.value;
    const act = r.onlyIfBang ? `case "$value" in '!'*) add "$name" ${sq(v)};; esac` : `add "$name" ${sq(v)}`;
    return `    ${r.pattern}) ${act};;`;
  }).join("\n");
  return `#!/bin/bash
# Synapse git shim: written by the host (host/brain/git-shim.ts), not the Bot's to change. See that file.
real=${sq(o.realGit)}
ws=${sq(o.workspace)}
n=\${GIT_CONFIG_COUNT:-0}
hk=(); tlsk=
case "$n" in ''|*[!0-9]*) n=0;; esac
add() { export "GIT_CONFIG_KEY_$n=$1" "GIT_CONFIG_VALUE_$n=$2"; n=$((n+1)); }
# The directory git will open: the cwd, then each leading -C (other global options pass through untouched).
dir=$PWD; pre=(); i=1
while [ $i -le $# ]; do
  a=\${!i}
  case "$a" in
    -C) j=$((i+1)); d=\${!j}; case "$d" in /*) dir=$d;; '') ;; *) dir=$dir/$d;; esac; pre+=(-C "$d"); i=$((i+2));;
    -c|--git-dir|--work-tree|--namespace|--config-env) j=$((i+1)); pre+=("$a" "\${!j}"); i=$((i+2));;
    -*) pre+=("$a"); i=$((i+1));;
    *) break;;
  esac
done
# Trust: the nearest directory with a .git, only when its real path is strictly inside the workspace.
wsr=$(cd "$ws" 2>/dev/null && pwd -P) || wsr=
d=$(cd "$dir" 2>/dev/null && pwd -P) || d=
while [ -n "$d" ] && [ -n "$wsr" ]; do
  case "$d" in "$wsr"/*) ;; *) break;; esac
  if [ -e "$d/.git" ]; then add safe.directory "$d"; break; fi
  d=\${d%/*}
done
export GIT_CONFIG_COUNT=$n
# Neutralize: every exec-capable key whose name the repo chooses, from the config this command would read.
while IFS= read -r -d '' entry; do
  name=\${entry%%$'\\n'*}
  if [ "$name" = "$entry" ]; then value=; else value=\${entry#*$'\\n'}; fi
  lname=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
  case "$lname" in
${cases}
  esac
  # Bug 195 N1: transport keys another Bot could plant in a shared repo (pinned or refused below, Bot accounts only).
  case "$lname" in
    http.*.proxy|http.*.sslverify|http.*.extraheader|http.*.curloptresolve|remote.*.proxy) hk+=("$name");;
    http.sslcainfo|http.sslcapath|http.sslcert|http.sslkey|http.cookiefile|http.*.sslcainfo|http.*.sslcapath|http.*.sslcert|http.*.sslkey|http.*.cookiefile) tlsk=$name;;
  esac
done < <(GIT_CONFIG_COUNT=$n "$real" "\${pre[@]}" config --list -z 2>/dev/null)
# Bug 195: a Bot account's own gh login (Bot settings -> GitHub) is git's ONE credential helper, for exactly
# github.com and gist.github.com: an empty value resets every helper before it (repo, home, anything above), then
# gh. Every other helper stays blanked. Only for a Bot's own account (its gh reads its own ~/.config/gh).
# S1 (controller ruling): and only where no one else can write what git reads -- the repo lives in the Bot's own
# (0700) home, and its root, .git, every config file git reads (repo, includes, global) and everything under
# .git/modules is owned by the Bot (or root), not world-writable, and group-writable only for the Bot's own private
# group (Bot processes run with umask 002). Anywhere else (a shared /workspace repo) git gets no credential at all.
# N1: where it is active, nothing in the config may route or MITM the transport: proxies off, TLS verified, no extra
# headers or resolve overrides (every url-scoped copy pinned too: same name = same specificity, last wins); a CA,
# client cert or cookie file refuses the transport; proxy/TLS env cleared; submodules never recurse.
ghok=
case "$(id -un 2>/dev/null)" in ${o.botUser ?? BOT_ACCOUNT_CASE})
  if [ -x ${sq(gh)} ]; then
    ghok=1
    uid=$(id -u); gid=$(id -g)
    unsafe() { find "$1" -maxdepth \${2:-0} \\( \\( ! -user "$uid" ! -user 0 \\) -o -perm -002 -o \\( -perm -020 ! -group "$gid" \\) \\) -print 2>/dev/null | head -n 1; }
    safe() { [ -e "$1" ] && [ ! -L "$1" ] && [ -z "$(unsafe "$1")" ]; }
    [ -z "\${GIT_DIR:-}\${GIT_WORK_TREE:-}\${GIT_COMMON_DIR:-}\${GIT_CONFIG_GLOBAL:-}\${GIT_CONFIG:-}\${GIT_CONFIG_SYSTEM:-}" ] || ghok=
    for a in "\${pre[@]}"; do case "$a" in --git-dir|--git-dir=*|--work-tree|--work-tree=*) ghok=;; esac; done
    home=$(cd "$(${o.homeCmd ?? HOME_CMD})" 2>/dev/null && pwd -P) || home=
    { [ -n "$home" ] && [ "$home" != / ] && safe "$home"; } || ghok=
    top=; r=$(cd "$dir" 2>/dev/null && pwd -P) || r=
    while [ -n "$r" ]; do
      if [ -e "$r/.git" ] || [ -L "$r/.git" ]; then top=$r; break; fi
      [ "$r" = / ] && break
      r=\${r%/*}; [ -n "$r" ] || r=/
    done
    if [ -n "$top" ] && [ -n "$ghok" ]; then
      case "$top" in "$home"/*) ;; *) ghok=;; esac
      { [ -d "$top/.git" ] && safe "$top" && safe "$top/.git"; } || ghok=
      [ ! -e "$top/.git/config" ] || safe "$top/.git/config" || ghok=
      if [ -e "$top/.git/modules" ]; then { safe "$top/.git/modules" && [ -z "$(unsafe "$top/.git/modules" 64)" ]; } || ghok=; fi
    fi
    if [ -n "$ghok" ]; then
      while IFS= read -r -d '' origin && IFS= read -r -d '' _; do
        case "$origin" in
          file:/*) f=\${origin#file:};;
          file:*) f=$dir/\${origin#file:};;
          *) continue;;
        esac
        safe "$f" || { ghok=; break; }
      done < <(GIT_CONFIG_COUNT=$n "$real" "\${pre[@]}" config --list --show-origin -z 2>/dev/null)
    fi
  fi;;
esac
if [ -n "$ghok" ]; then
  add http.proxy ''; add http.sslVerify true; add http.extraHeader ''; add http.curloptResolve ''
  for k in "\${hk[@]}"; do
    case "$(printf '%s' "$k" | tr '[:upper:]' '[:lower:]')" in *.sslverify) add "$k" true;; *) add "$k" '';; esac
  done
  [ -n "$tlsk" ] && tlsrefuse=$tlsk
  add submodule.recurse false; add fetch.recurseSubmodules false; add push.recurseSubmodules no
  unset GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_SSL_CAPATH GIT_SSL_CERT GIT_SSL_KEY GIT_SSL_CERT_PASSWORD_PROTECTED GIT_PROXY_SSL_CAINFO GIT_PROXY_SSL_CERT GIT_PROXY_SSL_KEY \\
    HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR
  for u in https://github.com https://gist.github.com; do add "credential.$u.helper" ''; add "credential.$u.helper" ${ghHelper}; done
  if [ "\${!i:-}" = submodule ]; then
    for a in "\${@:i+1}"; do case "$a" in update|sync) echo "git: refused: git submodule $a with your GitHub sign-in active (Synapse git shim)" >&2; exit 128;; esac; done
  fi
elif [ -x ${sq(gh)} ]; then
  case "$(id -un 2>/dev/null)" in ${o.botUser ?? BOT_ACCOUNT_CASE})
    case "\${!i:-}" in fetch|pull|push|clone|ls-remote|remote|submodule)
      echo "GitHub sign-in is only used in repos your Bot owns; clone it into your own folder (e.g. ~/code) to push." >&2;;
    esac;;
  esac
fi
export GIT_CONFIG_COUNT=$n
sub=\${!i:-}
if [ -n "\${tlsrefuse:-}" ]; then
  case "$sub" in fetch|pull|push|clone|ls-remote|remote|submodule|fetch-pack|send-pack|archive)
    echo "git: refused: the config sets $tlsrefuse, which could expose your GitHub sign-in (Synapse git shim)" >&2; exit 128;;
  esac
fi
if [ -n "\${refuse:-}" ]; then
  case "$sub" in fetch|pull|push|clone|ls-remote|remote|submodule|fetch-pack|send-pack|archive)
    echo "git: refused: this repo's config sets $refuse, a program git would run (Synapse git shim)" >&2; exit 128;;
  esac
fi
exec "$real" "$@"
`;
}

/** Bug 195: the gh a Bot's git may use as its github.com credential helper, and which accounts get it. */
export const GH_BIN = "/usr/bin/gh";
const BOT_ACCOUNT_CASE = `bot-${"[0-9a-f]".repeat(12)}`;
/** `botUser` (a bash case pattern), `gh` and `homeCmd` are test seams; the box uses the defaults. */
export interface GhHelperOptions { gh?: string; botUser?: string; homeCmd?: string }
/** The Bot account's home from the passwd database (not $HOME, which a process can change). */
const HOME_CMD = `getent passwd "$(id -un)" | cut -d: -f6`;

/** Where the shim lives: bothost-owned, group bots (every Bot account), no one else; first on each Bot's PATH. */
export const gitShimDir = (cfg: Pick<HostConfig, "ccManagedDir">): string | null => (cfg.ccManagedDir ? path.join(cfg.ccManagedDir, "git-bin") : null);

/** Writes the shim if missing or stale (atomic rename, 0750). Best effort: a Bot without it fails closed on foreign repos. */
export function ensureGitShim(cfg: Pick<HostConfig, "ccManagedDir" | "workspace">, builtinDiff: string, realGit = "/usr/bin/git", gh: GhHelperOptions = {}): string | null {
  const dir = gitShimDir(cfg);
  if (!dir) return null;
  const file = path.join(dir, "git");
  const src = renderGitShim({ realGit, workspace: cfg.workspace, builtinDiff, ...gh });
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === src) return file;
    fs.mkdirSync(dir, { recursive: true, mode: 0o2750 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, src, { mode: 0o750 });
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}
