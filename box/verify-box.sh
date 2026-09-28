#!/usr/bin/env bash
# Verifies the provisioned box. Prints PASS/FAIL per check; exits non-zero if any check fails.
set -uo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
M="$BOX_MACHINE"
# The Claude CLI version provision.sh installs (it used to be written here too, and went stale).
CLAUDE_VERSION="$(sed -n 's/^CLAUDE_VERSION=//p' "$(dirname "$0")/provision.sh")"
fail=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS $name"; else echo "FAIL $name"; fail=1; fi
}
check "machine running"           bash -c "orb list | grep -Eq '^$M +running'"
check "node v24.20.0"             bash -c "orb -m $M -u root /usr/local/bin/node -v | grep -qx v24.20.0"
check "claude $CLAUDE_VERSION"           bash -c "orb -m $M -u box /usr/local/bin/claude --version | grep -qF $CLAUDE_VERSION"
check "gh installed"              orb -m $M -u root sh -c 'command -v gh'
check "users box and bothost"     orb -m $M -u root sh -c 'id box && id bothost && id -nG bothost | grep -qw bots && id -nG box | grep -qw bots'
check ".host is bothost 700"      orb -m $M -u root sh -c 'test "$(stat -c %U:%a /home/box/.host)" = bothost:700'
check "box cannot read .host"     bash -c "! orb -m $M -u box ls /home/box/.host"
check "/home/box sticky"          orb -m $M -u root sh -c 'test -k /home/box'
check "/workspace group bots rw"  orb -m $M -u root sh -c 'test "$(stat -c %G:%a /workspace)" = bots:2775'
check "skills dir group bots 2775"  orb -m $M -u root sh -c 'test "$(stat -c %G:%a /home/box/.claude/skills)" = bots:2775'
# Final secfix round 3 (ruling 4): host output is bothost:bots 2750 from /workspace/.host-out all the way down.
check "host-out tree is bothost:bots 2750" orb -m $M -u root sh -c 'for d in /workspace/.host-out /workspace/.host-out/uploads /workspace/.host-out/events /workspace/.host-out/screens /workspace/.host-out/teach; do test ! -L $d && test "$(stat -c %U:%G:%a $d)" = bothost:bots:2750 || exit 1; done'
check "host-out has no group/other write" orb -m $M -u root sh -c 'test -z "$(find /workspace/.host-out -perm /022 -print -quit)"'
check "box can read host-out, can't write it" bash -c "orb -m $M -u box ls /workspace/.host-out/uploads >/dev/null && ! orb -m $M -u box touch /workspace/.host-out/uploads/.probe && ! orb -m $M -u box ln -s /home/box/.host /workspace/.host-out/teach/x"
check "teach work folder is box:bots 2775" orb -m $M -u root sh -c 'test ! -L /workspace/teach-sessions && test "$(stat -c %U:%G:%a /workspace/teach-sessions)" = box:bots:2775'
check "bothost can write skills"    orb -m $M -u root runuser -u bothost -- sh -c 'f=/home/box/.claude/skills/.probe; : > $f && rm $f'
check "agent-data readable by box" orb -m $M -u box ls /home/box/agent-data
# Bug #61 (Bot walls): Bot folders and transcript mirrors are host-private; shared user memory stays readable.
check "Bot folders walled from box" bash -c "! orb -m $M -u box ls /home/box/agent-data/agents >/dev/null 2>&1 && ! orb -m $M -u box ls /home/box/agent-data/agent-transcripts >/dev/null 2>&1"
check "user memory readable by box" orb -m $M -u box ls /home/box/agent-data/user-memory
# Final secfix round 2 (ruling B): the managed plugins/skills tree is bothost:bots 2750; box reads, never writes.
CM=/var/lib/bots/cc-managed
check "cc-managed is bothost:bots 2750" orb -m $M -u root sh -c "for d in $CM $CM/skills $CM/plugins; do test \"\$(stat -c %U:%G:%a \$d)\" = bothost:bots:2750 || exit 1; done"
check "cc-managed parent is root 755" orb -m $M -u root sh -c 'test "$(stat -c %U:%a /var/lib/bots)" = root:755'
check "cc-managed has no group/other write" orb -m $M -u root sh -c "test -z \"\$(find $CM -perm /022 -print -quit)\""
check "box can read cc-managed"       orb -m $M -u box ls $CM/skills $CM/plugins
check "box cannot write cc-managed"   bash -c "! orb -m $M -u box touch $CM/skills/.probe && ! orb -m $M -u box mkdir $CM/plugins/.probe && ! orb -m $M -u box ln -s /home/box/.host $CM/skills/x"
check "bothost can write cc-managed"  orb -m $M -u root runuser -u bothost -- sh -c "d=$CM/skills/.probe-\$\$; mkdir \$d && rmdir \$d"
check "box CLI accepts --plugin-dir"  bash -c "orb -m $M -u root runuser -u bothost -- /usr/local/bin/bot-claude --help | grep -q -- '--plugin-dir'"
check "wrapper runs CLI as box"   bash -c "orb -m $M -u root runuser -u bothost -- /usr/local/bin/bot-claude --version | grep -qF $CLAUDE_VERSION"
# Gate M-2: the delete helper (BOT-11 delete, CT-14 cleanup): one allowlisted directory, uuid names only.
VU=00000000-0000-4000-8000-00000000beef
VD=/home/box/.claude/projects/-workspace
check "delete-session helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-delete-session
check "delete-session sudoers grant + directory allowlist" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-delete-session /etc/passwd 2>&1 | grep -q 'bot-claude-delete-session: directory must be'"
check "delete-session rejects traversal" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-delete-session '$VD/../../../../etc/$VU.jsonl' 2>&1 | grep -q 'bot-claude-delete-session: directory must be'"
check "delete-session rejects a non-uuid name" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-delete-session '$VD/memory' 2>&1 | grep -q 'bot-claude-delete-session: not a session file name'"
check "delete-session deletes the session file and its <uuid>/ dir" orb -m $M -u root sh -c "rm -rf $VD/$VU $VD/$VU.jsonl && install -d -o box -g bots $VD/$VU && touch $VD/$VU/x && runuser -u bothost -- sh -c 'echo {} | sudo -n /usr/local/libexec/bot-claude-write-session $VD/$VU.jsonl' && test -e $VD/$VU.jsonl && runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-delete-session $VD/$VU.jsonl && test ! -e $VD/$VU.jsonl && test ! -e $VD/$VU"
check "delete-session is idempotent on a missing file" orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-delete-session $VD/$VU.jsonl
check "reap helper allowed"       orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-reap --dry-run
check "read-session helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-read-session
check "read-session sudoers grant + path allowlist" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-read-session /etc/passwd 2>&1 | grep -q 'bot-claude-read-session: path must be under'"
check "read-session rejects traversal" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-read-session '/home/box/.claude/projects/../../../etc/passwd' 2>&1 | grep -q 'bot-claude-read-session: path traversal rejected'"
check "write-session helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-write-session
check "write-session sudoers grant + path allowlist" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-write-session /etc/passwd' 2>&1 | grep -q 'bot-claude-write-session: path must be under'"
check "write-session rejects traversal" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-write-session \"/home/box/.claude/projects/../../../etc/passwd\"' 2>&1 | grep -q 'bot-claude-write-session: path traversal rejected'"
check "write-session verify dir"  orb -m $M -u root install -d -o box -g bots -m 2775 /home/box/.claude/projects/-verify
# Since secfix round 3 (ruling 1) the helper writes as box with --regid=bots, and the projects directory is setgid
# group bots, so the transcript lands box:bots 0600 -- exactly like the CLI's own session files. Either group is fine
# (the file is 0600); what matters is that box owns it and nothing else can read it.
check "write-session writes atomically as box 0600" bash -c "orb -m $M -u root rm -f /home/box/.claude/projects/-verify/verify.jsonl; orb -m $M -u root runuser -u bothost -- sh -c 'echo verify-content | sudo -n /usr/local/libexec/bot-claude-write-session /home/box/.claude/projects/-verify/verify.jsonl'; orb -m $M -u root stat -c '%U:%G:%a' /home/box/.claude/projects/-verify/verify.jsonl | grep -qx 'box:\(box\|bots\):600'"
check "write-session refuses overwrite" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo again | sudo -n /usr/local/libexec/bot-claude-write-session /home/box/.claude/projects/-verify/verify.jsonl' 2>&1 | grep -q 'bot-claude-write-session: refusing to overwrite an existing file'"
check "write-session rejects symlinked parent directory" bash -c "orb -m $M -u root sh -c 'rm -f /home/box/.claude/projects/-verify/evil-link; ln -s /tmp /home/box/.claude/projects/-verify/evil-link'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-write-session /home/box/.claude/projects/-verify/evil-link/x.jsonl' 2>&1 | grep -q 'bot-claude-write-session: parent directory is a symlink'"
check "write-session enforces the 64 MiB size cap, leaves no leftover file" bash -c "orb -m $M -u root rm -f /home/box/.claude/projects/-verify/oversized.jsonl; orb -m $M -u root runuser -u bothost -- sh -c 'head -c $((64*1024*1024+1024)) /dev/zero | sudo -n /usr/local/libexec/bot-claude-write-session /home/box/.claude/projects/-verify/oversized.jsonl' 2>&1 | grep -q 'bot-claude-write-session: input exceeds the 67108864 byte size cap' && ! orb -m $M -u root test -e /home/box/.claude/projects/-verify/oversized.jsonl"
# Ruling (final box verification): keyed command MCP servers run as their own uid boxmcp, so a Bot (box) can't read
# their env (API keys) through /proc/<pid>/environ.
mcp_user_ok() {
  orb -m $M -u root sh -c 'id boxmcp && test "$(id -u boxmcp)" != "$(id -u box)" && ! id -nG boxmcp | grep -qw box && ! id -nG box | grep -qw boxmcp && test "$(stat -c %U:%a /var/lib/boxmcp)" = boxmcp:700'
}
mcp_runs_as_boxmcp() {
  local out
  out="$(orb -m $M -u root runuser -u bothost -- sh -c '
    f=/home/box/.host/run/mcp-verify-$$.env; umask 077
    printf "VERIFY_MCP=mcp-9c1e\nHOME=/home/box\n" > $f
    sudo -n /usr/local/libexec/bot-mcp-as-box $f -- sh -c "echo \$(id -un) \$VERIFY_MCP \$HOME \$(pwd)"
    test ! -e $f && echo gone')"
  [ "$out" = "boxmcp mcp-9c1e /var/lib/boxmcp /workspace
gone" ]
}
mcp_env_hidden_from_box() {
  orb -m $M -u root runuser -u bothost -- sh -c '
    f=/home/box/.host/run/mcp-verify2-$$.env; umask 077; echo VERIFY_MCP=mcp-7d2b > $f
    sudo -n /usr/local/libexec/bot-mcp-as-box $f -- sleep 20 </dev/null >/dev/null 2>&1 &' || return 1
  sleep 1
  local p r=0
  p="$(orb -m $M -u root pgrep -u boxmcp -x sleep | head -1)"
  [ -n "$p" ] || return 1
  orb -m $M -u root grep -qa mcp-7d2b "/proc/$p/environ" || r=1
  orb -m $M -u box cat "/proc/$p/environ" 2>/dev/null | grep -qa mcp-7d2b && r=1
  orb -m $M -u root pkill -u boxmcp -x sleep
  return $r
}
check "user boxmcp: own uid, not in group box, home 0700" mcp_user_ok
check "mcp helper sudoers grant"  orb -m $M -u root runuser -u bothost -- sudo -n -l /usr/local/libexec/bot-mcp-as-box x -- true
check "mcp helper runs the server as boxmcp with its env, deletes the env file" mcp_runs_as_boxmcp
check "box can't read a keyed MCP server's env via /proc" mcp_env_hidden_from_box
# CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): SkillLibrary.write()/.remove()
# for user-authored skills must not use the host process's own fs operations; bot-claude-skill-write
# and bot-claude-skill-delete are the root-owned helpers it routes through instead.
check "skill-write helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-skill-write
check "skill-delete helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-skill-delete
check "skill-write rejects a malformed skill id" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write \"../etc\"' 2>&1 | grep -q 'bot-claude-skill-write: invalid skill id'"
check "skill-delete rejects a malformed skill id" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-skill-delete '../etc' 2>&1 | grep -q 'bot-claude-skill-delete: invalid skill id'"
check "skill-write writes atomically as box:bots 0664, and skill-delete removes it" bash -c "orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill; orb -m $M -u root runuser -u bothost -- sh -c 'printf -- \"---\\nname: Verify\\n---\\nbody\\n\" | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root stat -c '%U:%G:%a' /home/box/.claude/skills/verify-skill/SKILL.md | grep -qx 'box:bots:664' && orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-skill-delete verify-skill && ! orb -m $M -u root test -e /home/box/.claude/skills/verify-skill"
check "skill-write overwrites an existing skill in place" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'printf v1 | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root runuser -u bothost -- sh -c 'printf v2 | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/SKILL.md | grep -qx v2; orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill"
check "skill-delete is idempotent on a missing skill" orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-skill-delete no-such-skill
check "skill-write rejects a symlinked skills directory" bash -c "orb -m $M -u root sh -c 'mv /home/box/.claude/skills /home/box/.claude/skills.real && ln -s /tmp /home/box/.claude/skills'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill' 2>&1 | grep -q 'bot-claude-skill-write: skills directory is a symlink'; orb -m $M -u root sh -c 'rm -f /home/box/.claude/skills && mv /home/box/.claude/skills.real /home/box/.claude/skills'"
check "skill-delete rejects a symlinked skills directory" bash -c "orb -m $M -u root sh -c 'mv /home/box/.claude/skills /home/box/.claude/skills.real && ln -s /tmp /home/box/.claude/skills'; orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-claude-skill-delete verify-skill 2>&1 | grep -q 'bot-claude-skill-delete: skills directory is a symlink'; orb -m $M -u root sh -c 'rm -f /home/box/.claude/skills && mv /home/box/.claude/skills.real /home/box/.claude/skills'"
check "skill-write rejects a symlinked skill directory" bash -c "orb -m $M -u root sh -c 'rm -rf /home/box/.claude/skills/evil-link; ln -s /tmp /home/box/.claude/skills/evil-link'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write evil-link' 2>&1 | grep -q 'bot-claude-skill-write: skill directory is a symlink'; orb -m $M -u root rm -f /home/box/.claude/skills/evil-link"
# Follow-up controller ruling: SkillLibrary.writeHelper() (a skill's non-SKILL.md helper files)
# carries the same race, so bot-claude-skill-write-file is the root-owned helper it routes through,
# confined to that skill's own directory.
check "skill-write-file helper installed" orb -m $M -u root test -x /usr/local/libexec/bot-claude-skill-write-file
check "skill-write-file rejects a malformed skill id" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file \"../etc\" template.md' 2>&1 | grep -q 'bot-claude-skill-write-file: invalid skill id'"
check "skill-write-file rejects SKILL.md (must go through bot-claude-skill-write)" bash -c "orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill; orb -m $M -u root runuser -u bothost -- sh -c 'printf -- \"---\\nname: Verify\\n---\\nbody\\n\" | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill SKILL.md' 2>&1 | grep -q 'bot-claude-skill-write-file: SKILL.md must go through bot-claude-skill-write'"
check "skill-write-file rejects a traversal relative path" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill \"../escape\"' 2>&1 | grep -q 'bot-claude-skill-write-file: invalid relative path'"
check "skill-write-file writes a nested helper file atomically as box:bots 0664" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'printf template | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill \"scripts/run.sh\"'; orb -m $M -u root stat -c '%U:%G:%a' /home/box/.claude/skills/verify-skill/scripts/run.sh | grep -qx 'box:bots:664' && orb -m $M -u root cat /home/box/.claude/skills/verify-skill/scripts/run.sh | grep -qx template"
check "skill-write-file overwrites an existing helper file in place" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'printf v2 | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill \"scripts/run.sh\"'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/scripts/run.sh | grep -qx v2; orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill"
check "skill-write-file rejects a symlinked skill directory" bash -c "orb -m $M -u root sh -c 'rm -rf /home/box/.claude/skills/evil-link; ln -s /tmp /home/box/.claude/skills/evil-link'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file evil-link template.md' 2>&1 | grep -q 'bot-claude-skill-write-file: skill directory is a symlink'; orb -m $M -u root rm -f /home/box/.claude/skills/evil-link"
check "skill-write-file rejects a symlinked intermediate directory" bash -c "orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill; orb -m $M -u root runuser -u bothost -- sh -c 'printf -- \"---\\nname: Verify\\n---\\nbody\\n\" | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root sh -c 'ln -s /tmp /home/box/.claude/skills/verify-skill/scripts'; orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill \"scripts/run.sh\"' 2>&1 | grep -q 'bot-claude-skill-write-file: path component is a symlink'; orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill"
# Controller ruling: templates/importer.ts imports several files into a brand-new skill directory
# and must never silently clobber one; --no-clobber switches the publish step from `mv -f` to `ln`
# (fails if the target already exists) in both write helpers.
check "skill-write rejects an unrecognized second argument" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill --clobber-please' 2>&1 | grep -q 'bot-claude-skill-write: unknown second argument'"
check "skill-write --no-clobber writes a new skill but refuses to overwrite it" bash -c "orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill; orb -m $M -u root runuser -u bothost -- sh -c 'printf v1 | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill --no-clobber'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/SKILL.md | grep -qx v1; orb -m $M -u root runuser -u bothost -- sh -c 'printf v2 | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill --no-clobber' 2>&1 | grep -q 'bot-claude-skill-write: refusing to overwrite an existing file'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/SKILL.md | grep -qx v1; orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill"
check "skill-write-file rejects an unrecognized third argument" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'echo x | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill template.md --clobber-please' 2>&1 | grep -q 'bot-claude-skill-write-file: unknown third argument'"
check "skill-write-file --no-clobber writes a new helper file but refuses to overwrite it" bash -c "orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill; orb -m $M -u root runuser -u bothost -- sh -c 'printf -- \"---\\nname: Verify\\n---\\nbody\\n\" | sudo -n /usr/local/libexec/bot-claude-skill-write verify-skill'; orb -m $M -u root runuser -u bothost -- sh -c 'printf v1 | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill notes.md --no-clobber'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/notes.md | grep -qx v1; orb -m $M -u root runuser -u bothost -- sh -c 'printf v2 | sudo -n /usr/local/libexec/bot-claude-skill-write-file verify-skill notes.md --no-clobber' 2>&1 | grep -q 'bot-claude-skill-write-file: refusing to overwrite an existing file'; orb -m $M -u root cat /home/box/.claude/skills/verify-skill/notes.md | grep -qx v1; orb -m $M -u root rm -rf /home/box/.claude/skills/verify-skill"
check "sudoers valid"             orb -m $M -u root visudo -cf /etc/sudoers.d/bothost
check "systemd unit enabled"      orb -m $M -u root systemctl is-enabled bothost

# ---- Phase 3 desktop (Task 2) ----
as_host() { orb -m $M -u root runuser -u bothost -- "$@"; }
check "desktop packages"          orb -m $M -u root sh -c 'for p in xvfb xfwm4 picom plank x11vnc chromium xdotool ffmpeg imagemagick zstd rsync sqlite3 xauth; do dpkg -s $p >/dev/null || exit 1; done'
# Final box verification: Teach a task records keys with xmodmap + xinput (host/teach/xinput.ts); they weren't provisioned.
check "teach tools (xmodmap, xinput, xprop, mousepad)" orb -m $M -u root sh -c 'command -v xmodmap && command -v xinput && command -v xprop && command -v mousepad'
check "desktop.env installed"     orb -m $M -u root grep -q '^VNC_TRANSPORT=' /etc/bots/desktop.env
check "primary display :1 up"     orb -m $M -u root systemctl is-active --quiet bot-display@1 bot-chrome@1 bot-vnc@1
check "primary CDP on loopback"   orb -m $M -u root curl -fs http://127.0.0.1:9223/json/version
check "bothost captures :1"       as_host sh -c 'DISPLAY=:1 XAUTHORITY=/run/bot-x/1.xauth ffmpeg -loglevel error -f x11grab -video_size 1280x800 -i :1 -frames:v 1 -f webp -y /tmp/verify.webp && test -s /tmp/verify.webp'
check "box can't read vnc dir"    bash -c "! orb -m $M -u box ls /run/bothost-vnc"
# Final secfix round 3 (ruling 1): /run/bot-x is root-owned (group bots) so box can't plant a symlink where bot-display
# and display-cookie write the owner token and xauth cookie as root; box still reads the cookie via the bots group.
check "bot-x dir is root:bots 0750"  orb -m $M -u root sh -c 'test "$(stat -c %U:%G:%a /run/bot-x)" = root:bots:750'
check "box can read the xauth cookie" orb -m $M -u box test -r /run/bot-x/1.xauth
check "box can't write in /run/bot-x" bash -c "! orb -m $M -u box sh -c 'ln -s /etc/shadow /run/bot-x/evil'"
# Final secfix round 3 (ruling 1): the session/skill helpers now re-exec themselves as box before any filesystem
# step, so a symlinked temp name can't redirect a root write. Local sandbox tests
# (host/test/box/secfix3-session-skill-helpers.test.ts) prove the drop and the symlink attacks; here we confirm the
# transcript/skill files still land box:box / box:bots (only possible if the helper ran as box).

check "display helper start"      as_host sudo -n /usr/local/libexec/bot-display start 13 verify-token
check "display helper status"     bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-display status 13 | grep -qx running"
check "display owner token → 75"  bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-display start 13 other-token; test \$? -eq 75"
check "display helper stop"       as_host sudo -n /usr/local/libexec/bot-display stop 13
check "display helper rejects 0"  bash -c "! orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-display start 0 t"
check "display helper rejects x"  bash -c "! orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-display stop '13;id'"
check "shell helper runs as box"  as_host sh -c '
  set -e; id=shell-verify1; d=/workspace/.bot/terminals; r=/home/box/.host/run; test "$(stat -c %G:%a $d)" = bots:2775
  printf "%s\n" "---" "command: echo" "---" > $d/$id.txt; chmod 0664 $d/$id.txt
  printf "echo \"user=\$(id -un) v=\$VERIFY_SECRET\"\n" > $r/$id.sh; chmod 0600 $r/$id.sh
  printf "VERIFY_SECRET=verify-9f3a\n" > $r/$id.env; chmod 0600 $r/$id.env
  sudo -n /usr/local/libexec/bot-shell start $id /workspace; rm -f $r/$id.env $r/$id.sh
  for i in $(seq 1 30); do grep -q "^exit_code: 0" $d/$id.txt && break; sleep 0.2; done
  grep -q "user=box v=verify-9f3a" $d/$id.txt && grep -q "^exit_code: 0" $d/$id.txt && rm -f $d/$id.txt'
# Security re-review item 5: the script runs from a root-owned copy; a group/world-writable or missing host script is refused.
check "shell script copy is root-owned" orb -m $M -u root sh -c 'test "$(stat -c %U:%a /run/bots-shell/shell-verify1.sh)" = root:644 && test "$(stat -c %U:%a /run/bots-shell)" = root:755'
check "box can't write the script copies" bash -c "! orb -m $M -u box sh -c 'echo x >> /run/bots-shell/shell-verify1.sh' 2>/dev/null"
check "shell helper rejects a writable script" bash -c "orb -m $M -u root runuser -u bothost -- sh -c 'r=/home/box/.host/run; echo true > \$r/shell-verify2.sh; chmod 0660 \$r/shell-verify2.sh; echo A=1 > \$r/shell-verify2.env; chmod 600 \$r/shell-verify2.env; sudo -n /usr/local/libexec/bot-shell start shell-verify2 /workspace; ec=\$?; rm -f \$r/shell-verify2.sh \$r/shell-verify2.env; exit \$ec' 2>&1 | grep -q 'bot-shell: bad script'"
check "shell helper ignores a box-planted script" bash -c "orb -m $M -u box sh -c 'echo \"touch /workspace/.p3-planted\" > /workspace/.bot/terminals/shell-verify3.sh' ; orb -m $M -u root runuser -u bothost -- sh -c 'echo A=1 > /home/box/.host/run/shell-verify3.env; chmod 600 /home/box/.host/run/shell-verify3.env; sudo -n /usr/local/libexec/bot-shell start shell-verify3 /workspace 2>/dev/null; rm -f /home/box/.host/run/shell-verify3.env'; sleep 1; orb -m $M -u root sh -c 'rm -f /workspace/.bot/terminals/shell-verify3.sh; test ! -e /workspace/.p3-planted'"
check "shell env not in show"     bash -c "! orb -m $M -u root systemctl show bot-shell-shell-verify1 2>/dev/null | grep -q verify-9f3a"
check "shell helper rejects id"   bash -c "! orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-shell start '../x' /workspace"
check "snapshot excludes vault"   as_host sh -c '
  set -e; sudo -n /usr/local/libexec/bot-snapshot create snap-verify01 agent-data
  f=/home/box/.host/snapshots/snap-verify01.tar.zst; test "$(stat -c %U:%a $f)" = bothost:600
  ! zstd -dc $f | tar -tf - | grep -q "vault.key"; sudo -n /usr/local/libexec/bot-snapshot delete snap-verify01'
# Final secfix round 4 (ruling 2): restore never writes as root; each tree is extracted and rsynced by its owner.
check "snapshot restore drops to owners" orb -m $M -u root sh -c 'f=/usr/local/libexec/bot-snapshot; grep -q "__restore-tree" $f && grep -q "setpriv --reuid=\"\$owner\"" $f && ! grep -Eq "rsync -a|-aHAX" $f'
check "snapshot restore stage refuses root" bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-snapshot __restore-tree workspace </dev/null 2>&1 | grep -q 'bad restore stage'"
# (a real /workspace restore: it rewinds /workspace to a few seconds earlier, so run verify while Bots are idle)
check "snapshot restore ignores a planted link" bash -c "
  orb -m $M -u box sh -c 'rm -rf /workspace/.p4-restore && mkdir -p /workspace/.p4-restore/sub && echo one > /workspace/.p4-restore/sub/p4-restore-probe' &&
  as_host() { orb -m $M -u root runuser -u bothost -- \"\$@\"; } &&
  as_host sudo -n /usr/local/libexec/bot-snapshot create snap-verify02 workspace >/dev/null &&
  orb -m $M -u box sh -c 'rm -rf /workspace/.p4-restore/sub && ln -s /etc /workspace/.p4-restore/sub' &&
  as_host sudo -n /usr/local/libexec/bot-snapshot restore snap-verify02 workspace; rc=\$?
  as_host sudo -n /usr/local/libexec/bot-snapshot delete snap-verify02
  orb -m $M -u root sh -c 'test ! -e /etc/p4-restore-probe && test ! -L /workspace/.p4-restore/sub && test \"\$(stat -c %U /workspace/.p4-restore/sub/p4-restore-probe)\" = box && grep -qx one /workspace/.p4-restore/sub/p4-restore-probe'; ok=\$?
  orb -m $M -u box rm -rf /workspace/.p4-restore; [ \$rc = 0 ] && [ \$ok = 0 ]"
# (runs a real reap: any Bot turn running right now is stopped, as at a host restart; run verify while Bots are idle)
check "reap spares screens"       bash -c "orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-reap && orb -m $M -u root systemctl is-active --quiet bot-display@1 bot-chrome@1"
check "box has no sudo"           bash -c "! orb -m $M -u box sudo -n true"
check "box-doctor passes"         bash -c "orb -m $M -u box env DISPLAY=:1 XAUTHORITY=/run/bot-x/1.xauth /usr/local/bin/box-doctor | grep -q '^PASS chromium'"
check "reference docs host-owned" orb -m $M -u root sh -c 'test "$(stat -c %U:%a /home/box/reference)" = bothost:755'
check "image version written"     orb -m $M -u root sh -c 'grep -Eq "^[0-9a-f]{16}$" /etc/bots/image-version'
check "wallpapers generated"      orb -m $M -u root sh -c 'for t in dawn day dusk evening night; do test -s /usr/local/share/bots/wallpapers/$t.png || exit 1; done'

# ---- Bug #66: per-Bot OS accounts. Two throwaway Bot accounts (removed at the end) prove the kernel walls them off
# from each other and that each can still work: tools, git and npm in its own home, the shared /workspace, its CLI.
# Safe on a box that is not migrated yet: it only makes (and removes) its own two accounts.
BU=/usr/local/libexec/bot-user
as_host_q() { orb -m $M -u root runuser -u bothost -- "$@" </dev/null; }
check "bot-user installed, /home/bots root 711" orb -m $M -u root sh -c "test -x $BU && test \"\$(stat -c %U:%a /home/bots)\" = root:711"
if as_host_q sudo -n $BU ensure verify-walls-a >/dev/null 2>&1 && as_host_q sudo -n $BU ensure verify-walls-b >/dev/null 2>&1; then
  UA="$(orb -m $M -u root $BU name verify-walls-a)"; UB="$(orb -m $M -u root $BU name verify-walls-b)"
  HA=/home/bots/$UA; HB=/home/bots/$UB
  asA() { orb -m $M -u root setpriv --reuid="$UA" --regid="$UA" --init-groups -- env HOME="$HA" PATH=/usr/local/bin:/usr/bin:/bin sh -c "umask 002; $1" </dev/null; }
  asB() { orb -m $M -u root setpriv --reuid="$UB" --regid="$UB" --init-groups -- env HOME="$HB" PATH=/usr/local/bin:/usr/bin:/bin sh -c "umask 002; $1" </dev/null; }
  export M UA UB HA HB; export -f asA asB   # the `bash -c` checks below call them
  asB "mkdir -p $HB/.claude/projects/-workspace && echo b-secret > $HB/notes.md && echo '{}' > $HB/.claude/projects/-workspace/verify.jsonl && chmod 600 $HB/.claude/projects/-workspace/verify.jsonl && echo b-cookie > $HB/chrome-profile/Cookies"
  as_host_q sh -c 'echo staged > /workspace/.host-out/uploads/verify-walls-b/f.txt && chmod 640 /workspace/.host-out/uploads/verify-walls-b/f.txt'
  as_host_q sh -c 'echo staged > /workspace/.host-out/uploads/verify-walls-a/f.txt && chmod 640 /workspace/.host-out/uploads/verify-walls-a/f.txt'
  check "per-Bot homes are 0700, their own"   orb -m $M -u root sh -c "test \"\$(stat -c %U:%a $HA)\" = $UA:700 && test \"\$(stat -c %U:%a $HB)\" = $UB:700"
  check "Bot A can't list or read Bot B's home"          bash -c "! asA 'ls $HB' && ! asA 'cat $HB/notes.md'"
  check "Bot A can't read Bot B's CLI transcript"        bash -c "! asA 'cat $HB/.claude/projects/-workspace/verify.jsonl'"
  check "Bot A can't read Bot B's Chrome cookies"        bash -c "! asA 'cat $HB/chrome-profile/Cookies'"
  check "Bot A can't read Bot B's staged upload"         bash -c "! asA 'cat /workspace/.host-out/uploads/verify-walls-b/f.txt'"
  check "Bot A reads its own staged upload"              asA "grep -qx staged /workspace/.host-out/uploads/verify-walls-a/f.txt"
  check "Bot A can't read any Bot's memory or chat store" bash -c "! asA 'ls /home/box/agent-data/agents' && ! asA 'ls /home/box/agent-data/agent-transcripts' && ! asA 'ls /home/box/.host'"
  check "Bot A can't read box's own CLI sessions"        bash -c "! asA 'cat /home/box/.claude/projects/-workspace/*.jsonl 2>/dev/null | head -c1 | grep -q .'"
  check "Bot A can't read Bot B's process env"           bash -c "orb -m $M -u root sh -c 'setpriv --reuid=$UB --regid=$UB --init-groups -- env WALL_SECRET=b sleep 20 </dev/null >/dev/null 2>&1 & echo \$! > /run/verify-walls.pid' && p=\$(orb -m $M -u root cat /run/verify-walls.pid) && ! asA \"cat /proc/\$p/environ\"; r=\$?; orb -m $M -u root sh -c 'kill \$(cat /run/verify-walls.pid); rm -f /run/verify-walls.pid'; exit \$r"
  check "each Bot has its own ~/code, 0700 (bug 231)"    orb -m $M -u root sh -c "test \"\$(stat -c %U:%a $HA/code)\" = $UA:700 && test \"\$(stat -c %U:%a $HB/code)\" = $UB:700"
  check "Bot A runs tools, git and npm in its own home"  asA "cd $HA && mkdir -p w && cd w && git init -q . && git -c user.name=v -c user.email=v@x commit -q --allow-empty -m v && git log --oneline | grep -q v && npm init -y >/dev/null && test -f package.json && npm --version >/dev/null"
  check "Bot A and B share /workspace (group write)"     bash -c "asA 'mkdir -p /workspace/.verify-walls && echo a > /workspace/.verify-walls/shared.txt' && asB 'echo b >> /workspace/.verify-walls/shared.txt' && asA 'grep -qx b /workspace/.verify-walls/shared.txt'"
  check "Bot CLI starts as its own account"               bash -c "orb -m $M -u root runuser -u bothost -- env BOT_UNIX_USER=$UA BOT_ACCOUNT_OF=verify-walls-a sudo -n /usr/local/libexec/bot-claude-as-box --version </dev/null | grep -qF $CLAUDE_VERSION"
  # Bug 231 round 1: the gate's read-only view into a Bot's home, as that Bot.
  check "fs-query answers as the Bot, in its own home"    bash -c "printf '%s' '{\"ops\":[[\"lstat\",\"$HA/code\"],[\"realpath\",\"$HA/code\"]]}' | orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-fs-query $UA verify-walls-a | grep -q '\"$HA/code\"'"
  check "fs-query refuses another Bot's home"            bash -c "! printf '%s' '{\"ops\":[[\"ls\",\"$HB/code\"]]}' | orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-fs-query $UA verify-walls-a"
  check "fs-query refuses a Bot named by another's id"    bash -c "! printf '%s' '{\"ops\":[]}' | orb -m $M -u root runuser -u bothost -- sudo -n /usr/local/libexec/bot-fs-query $UB verify-walls-a"
  check "Bot CLI refuses another Bot's account"           bash -c "! orb -m $M -u root runuser -u bothost -- env BOT_UNIX_USER=$UB BOT_ACCOUNT_OF=verify-walls-a sudo -n /usr/local/libexec/bot-claude-as-box --version </dev/null"
  # Follow-up 1: a Bot's Shell transcript is its own (a real bot-shell unit as Bot B, output appended by systemd).
  VS=shell-verifywalls$$
  as_host_q sh -c "printf 'echo walls-out; ps -eo uid= | sort -u | tr -d \" \"\n' > /home/box/.host/run/$VS.sh && chmod 600 /home/box/.host/run/$VS.sh && : > /home/box/.host/run/$VS.env && chmod 600 /home/box/.host/run/$VS.env && printf -- '---\n' > /workspace/.host-out/terminals/verify-walls-b/$VS.txt && chmod 640 /workspace/.host-out/terminals/verify-walls-b/$VS.txt"
  as_host_q sudo -n /usr/local/libexec/bot-shell start $VS /workspace $UB verify-walls-b >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do orb -m $M -u root grep -q exit_code /workspace/.host-out/terminals/verify-walls-b/$VS.txt 2>/dev/null && break; sleep 1; done
  as_host_q rm -f /home/box/.host/run/$VS.sh /home/box/.host/run/$VS.env
  check "Bot B's Shell output lands in its private transcript" orb -m $M -u root sh -c "grep -qx walls-out /workspace/.host-out/terminals/verify-walls-b/$VS.txt && grep -q '^exit_code: 0' /workspace/.host-out/terminals/verify-walls-b/$VS.txt"
  check "Bot B reads its own Shell transcript"            asB "grep -qx walls-out /workspace/.host-out/terminals/verify-walls-b/$VS.txt"
  check "Bot A can't read Bot B's Shell transcript"       bash -c "! asA 'cat /workspace/.host-out/terminals/verify-walls-b/$VS.txt'"
  check "Bot B's Shell can't write its transcript by name" bash -c "! asB 'echo x >> /workspace/.host-out/terminals/verify-walls-b/$VS.txt'"
  # Follow-up 2: other uids' processes are hidden from a Bot by /proc hidepid=invisible (bots-hidepid.service), which
  # the migration turns on; the host's own monitoring (group procview) still sees every process. Live finding
  # (2026-09-22): systemd's ProtectProc= and PrivateTmp= are silently inert on OrbStack, so before the migration a
  # Bot's Shell still sees every process and this whole block is skipped.
  UBID="$(orb -m $M -u root id -u $UB)"
  if orb -m $M -u root test -f /etc/systemd/system/bothost.service.d/50-per-bot-uid.conf; then
    check "Bot B's Shell sees only its own processes"     orb -m $M -u root sh -c "sed -n '/^walls-out\$/,/^\$/p' /workspace/.host-out/terminals/verify-walls-b/$VS.txt | sed '1d;/^\$/d' | grep -vx '$UBID' | grep -q . && exit 1 || exit 0"
    check "/proc is hidepid=invisible (migrated box)"     orb -m $M -u root sh -c 'findmnt -no OPTIONS /proc | grep -q hidepid=invisible && systemctl is-enabled --quiet bots-hidepid.service'
    check "bothost is in procview"                        orb -m $M -u root sh -c 'id -nG bothost | tr " " "\n" | grep -qx procview'
    orb -m $M -u root sh -c "setpriv --reuid=$UB --regid=$UB --init-groups -- sleep 20 </dev/null >/dev/null 2>&1 & echo \$! > /run/verify-walls-ps.pid"
    PSP="$(orb -m $M -u root cat /run/verify-walls-ps.pid)"
    check "Bot A can't see Bot B's process"               bash -c "! asA 'test -e /proc/$PSP' && ! asA 'ps -eo pid= | grep -qw $PSP'"
    check "the host still sees and measures Bot B's process" as_host_q sh -c "test -r /proc/$PSP/status && grep -q VmRSS /proc/$PSP/status && ps -eo pid= | grep -qw $PSP"
    check "bot-reap still runs"                           as_host_q sudo -n /usr/local/libexec/bot-reap --dry-run
    orb -m $M -u root sh -c 'kill $(cat /run/verify-walls-ps.pid) 2>/dev/null; rm -f /run/verify-walls-ps.pid'
  else
    echo "SKIP /proc hidepid checks (box not migrated to per-Bot accounts yet)"
  fi
  # Bug 117: the auth proxy port answers bothost, box and a Bot account, and refuses any other local user.
  check "auth proxy port rule is loaded"                  orb -m $M -u root sh -c 'systemctl is-active --quiet bots-auth-proxy.service && nft list table inet bots_auth_proxy >/dev/null'
  check "box reaches the auth proxy"                      orb -m $M -u root setpriv --reuid=box --regid=box --init-groups -- curl -sf -m 3 -I http://127.0.0.1:47802/api/hello
  check "a Bot account reaches the auth proxy"            orb -m $M -u root setpriv --reuid=$UB --regid=$UB --init-groups -- curl -sf -m 3 -I http://127.0.0.1:47802/api/hello
  check "another local user can't reach the auth proxy"   bash -c "! orb -m $M -u root setpriv --reuid=nobody --regid=nogroup --clear-groups -- curl -sf -m 3 -I http://127.0.0.1:47802/api/hello"
  check "the proxy refuses a made-up proxy token"         orb -m $M -u root sh -c "setpriv --reuid=box --regid=box --init-groups -- curl -s -m 3 -o /dev/null -w '%{http_code}' -H 'x-api-key: sk-ant-api03-synproxy-madeup' -d '{}' http://127.0.0.1:47802/v1/messages | grep -qx 401"
  # synapse-public: every Claude process runs on a proxy API-key token, and none holds a Claude login.
  check "every process's ANTHROPIC_API_KEY is a proxy token" orb -m $M -u root sh -c "! cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -a '^ANTHROPIC_API_KEY=' | grep -av -- '-synproxy-' | grep -q ."
  check "no process holds a Claude login token"           orb -m $M -u root sh -c "! cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -aq '^CLAUDE_CODE_OAUTH_TOKEN='"
  check "the box keeps no Claude login token file"        orb -m $M -u root sh -c "! ls /home/box/.host/claude-oauth-token* >/dev/null 2>&1"
  check "no stored Claude login in any config dir"        orb -m $M -u root sh -c "! ls /home/box/.claude/.credentials.json /home/bots/*/.claude/.credentials.json >/dev/null 2>&1"
  check "managed settings pin forceLoginMethod console"   orb -m $M -u root sh -c "grep -q '\"forceLoginMethod\": \"console\"' /etc/claude-code/managed-settings.json"
  # Follow-up 3: a "home" snapshot includes every Bot's own home, and the manifest line says so.
  SNAPOUT="$(as_host_q sudo -n /usr/local/libexec/bot-snapshot create snap-verifyhome home 2>/dev/null)"
  check "snapshot manifest lists home/bots"               bash -c "printf '%s\n' \"\$1\" | grep -qx 'trees home/box home/bots'" _ "$SNAPOUT"
  check "snapshot archives Bot A's home"                  orb -m $M -u root sh -c "zstd -dc /home/box/.host/snapshots/snap-verifyhome.tar.zst | tar -tf - | grep -q '^home/bots/$UA/'"
  as_host_q sudo -n /usr/local/libexec/bot-snapshot delete snap-verifyhome >/dev/null 2>&1
  as_host_q rm -rf /workspace/.host-out/terminals/verify-walls-a /workspace/.host-out/terminals/verify-walls-b
  orb -m $M -u root rm -rf /workspace/.verify-walls
  as_host_q sudo -n $BU remove verify-walls-a >/dev/null; as_host_q sudo -n $BU remove verify-walls-b >/dev/null
  as_host_q rm -rf /workspace/.host-out/uploads/verify-walls-a /workspace/.host-out/uploads/verify-walls-b /workspace/.host-out/screens/verify-walls-a /workspace/.host-out/screens/verify-walls-b /workspace/.host-out/events/verify-walls-a /workspace/.host-out/events/verify-walls-b /workspace/.host-out/mcp-output/verify-walls-a /workspace/.host-out/mcp-output/verify-walls-b
  check "throwaway Bot accounts removed"                  bash -c "! orb -m $M -u root id $UA && ! orb -m $M -u root test -e $HA"
else
  echo "FAIL bot-user ensure (per-Bot accounts)"; fail=1
fi
# Follow-up 4 (decided, not changed): keyed command MCP servers are one shared process per server for every Bot, so
# they keep their own uid boxmcp -- never a Bot's, whose uid could then read the server's API keys in /proc.
check "keyed MCP servers run as boxmcp, never a Bot uid" orb -m $M -u root sh -c 'grep -q -- "--reuid=boxmcp" /usr/local/libexec/bot-mcp-as-box && ! ps -eo user=,args= | grep -E "^bot-[0-9a-f]{12} .*bot-mcp" | grep -q .'

# The session-helper checks above build a scratch project; leaving it behind (with root-owned probe files) is a
# landmine for a /home/box restore, whose stage runs as box and can't set times on a file it doesn't own.
orb -m $M -u root rm -rf /home/box/.claude/projects/-verify

exit $fail
