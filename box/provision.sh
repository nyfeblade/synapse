#!/usr/bin/env bash
set -euo pipefail
NODE_VERSION=24.20.0
NODE_SHA256=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7
CLAUDE_VERSION=2.1.280
CLOUDFLARED_VERSION=2026.9.3
CLOUDFLARED_SHA256=bcce0111878f13d26e66b1d2ea7f270c8bde4bd549e32ce74d32474521583ca3
HERE="$(cd "$(dirname "$0")" && pwd)"

# Names: the app is Synapse (it was Bots), but the box keeps bothost (the service account, bothost.service, /opt/bothost,
# /etc/bothost.env) and the bots-* names: this script re-runs in place on existing boxes and has no step that migrates an
# account with its files and rules (docs/decisions.md, 2026-09-26; bug 284).
# Portable install: provisioning is idempotent and RESUMABLE — the app runs it on a brand-new machine at
# first launch, again after a failure (no network, a quit mid-way), and in place whenever the bundled box
# files change. It never touches user data, and it reports its progress as `::step n/N label` lines,
# which the setup screen turns into a real progress bar.
STEPS=10
step() { echo "::step $1/$STEPS $2"; }
# One provision at a time: a retry started while an interrupted run is still unwinding waits for it.
exec 9>/run/bots-provision.lock
flock -w 600 9 || { echo "provision: another provision is still running" >&2; exit 1; }
# A run killed mid-install leaves dpkg half-configured; finish that first, or every apt call fails.
APT="-o DPkg::Lock::Timeout=300 -o Acquire::Retries=3"
export DEBIAN_FRONTEND=noninteractive
dpkg --configure -a || true
# shellcheck disable=SC2086
apt-get $APT -f install -y || true
# A box that has never been provisioned before (no image-version yet) gets the new-install defaults below.
FRESH=0
[ -f /etc/bots/image-version ] || FRESH=1

step 1 "system packages"
# shellcheck disable=SC2086
apt-get $APT update
# shellcheck disable=SC2086
apt-get $APT install -y --no-install-recommends \
  ca-certificates curl xz-utils sudo procps util-linux git ripgrep jq bubblewrap nftables

# TOOL-20: the GitHub CLI, so a coding agent's worktree can `gh pr create --fill` (free; PR creation is
# optional and needs the user's own `gh auth login` as user box). Optional: a failure here never fails setup.
step 2 "GitHub CLI"
if ! command -v gh >/dev/null; then
  {
    curl -fsSL --retry 3 https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg &&
    echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list &&
    apt-get $APT update && apt-get $APT install -y gh
  } || { echo "provision: warning: the GitHub CLI could not be installed (coding PRs need it; everything else works)"; rm -f /etc/apt/sources.list.d/github-cli.list; }
fi

# Node and the Claude CLI: installed into /usr/local when the system-wide copy is missing or another version.
# The Node tarball is checked against its published sha256 before anything is unpacked.
step 3 "Node.js"
if ! /usr/local/bin/node -v 2>/dev/null | grep -qx "v${NODE_VERSION}"; then
  NODE_TGZ="/tmp/node-v${NODE_VERSION}-linux-arm64.tar.xz"
  curl -fsSL --retry 3 -o "$NODE_TGZ" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
  echo "${NODE_SHA256}  ${NODE_TGZ}" | sha256sum -c - >/dev/null || { echo "provision: the Node.js download does not match its checksum" >&2; rm -f "$NODE_TGZ"; exit 1; }
  tar -xJ -C /usr/local --strip-components=1 -f "$NODE_TGZ"
  rm -f "$NODE_TGZ"
fi
step 4 "Claude CLI"
if ! /usr/local/bin/claude --version 2>/dev/null | grep -q "${CLAUDE_VERSION}"; then
  /usr/local/bin/npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_VERSION}"
fi

step 5 "accounts and folders"

getent group bots >/dev/null || groupadd bots
id box >/dev/null 2>&1 || useradd -m -s /bin/bash box
id bothost >/dev/null 2>&1 || useradd -r -m -d /var/lib/bothost -s /usr/sbin/nologin bothost
usermod -aG bots box
usermod -aG bots bothost
# Ruling (final box verification): keyed command MCP servers run as their own uid boxmcp (bot-mcp-as-box), never box,
# so a Bot can't read their env (API keys) through /proc. Group bots only, for /workspace; its home is private.
id boxmcp >/dev/null 2>&1 || useradd -r -m -d /var/lib/boxmcp -s /usr/sbin/nologin boxmcp
usermod -aG bots boxmcp
install -d -o boxmcp -g boxmcp -m 0700 /var/lib/boxmcp

chmod 1755 /home/box
install -d -o box -g bots -m 2775 /workspace
install -d -o box -g bots -m 2775 /home/box/.claude
install -d -o box -g bots -m 2775 /home/box/.claude/skills   # SKL-01 library: host writes 0664, the CLI reads and edits
# Live-box finding (final box verification): on a box provisioned by an older build the managed teach skill directory
# /home/box/.claude/skills/learn-from-demonstration was created by the host process itself and is bothost-owned, but
# since final secfix round 3 (ruling 1) the publishing helper runs as box and its mktemp there fails, so the skill can
# never be refreshed again. Remove a managed-skill directory box does not own -- rm never follows a link, and the host
# re-creates it as box on the next boot. Nothing here chowns inside the box-writable skills tree: box could swap the
# path for a link between the check and the chown.
MSD=/home/box/.claude/skills/learn-from-demonstration
if [ ! -L "$MSD" ] && [ -d "$MSD" ] && [ "$(stat -c %U "$MSD")" != box ]; then rm -rf --one-file-system -- "$MSD"; fi

# Final secfix round 3 (ruling 4): the host's Bot-visible output (CHAT-09 upload staging, oversized webhook bodies,
# screenshots, published Teach recordings) lives in /workspace/.host-out, bothost:bots 2750 from .host-out all the way
# down (files 0640): box reads through the bots group and can never write, rename or plant a link there. Anything else
# found at those names (a box-planted link, file or box-owned folder) is removed first. rm never follows a link.
for d in /workspace/.host-out /workspace/.host-out/uploads /workspace/.host-out/events /workspace/.host-out/screens /workspace/.host-out/teach; do
  if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then rm -f -- "$d"; fi
  if [ -d "$d" ] && [ "$(stat -c %U "$d")" != bothost ]; then rm -rf --one-file-system -- "$d"; fi
  install -d -o bothost -g bots -m 2750 "$d"
done
# The Bot's own Teach work folders (trace.json, rehearsal.json): box-writable; the host only reads them (no links).
if [ -L /workspace/teach-sessions ]; then rm -f /workspace/teach-sessions; fi
install -d -o box -g bots -m 2775 /workspace/teach-sessions
install -d -o box -g bots -m 2775 /home/box/.bot-cwd
install -d -o bothost -g bots -m 2750 /home/box/agent-data
# Bug #61 (Bot walls): every Bot's folder (chat store, memory, attachments, routines) and transcript mirror are
# host-private. Every Bot runs as uid box (group bots), so these two lose all group/other bits; user-memory/ and
# projects/ stay group-readable (shared by design). The host re-applies this on every start (store/layout.ts).
for d in /home/box/agent-data/agents /home/box/agent-data/agent-transcripts; do
  if [ -L "$d" ]; then rm -f -- "$d"; fi
  install -d -o bothost -g bots -m 0700 "$d"
done
install -d -o bothost -g bothost -m 0700 /home/box/.host
install -d -o bothost -g bothost -m 0755 /opt/bothost /opt/bothost/app
# Final secfix round 2 (ruling B): marketplace plugins and their skills are installed ONLY here, a bothost-owned tree
# the box (group bots) can read but never write. The Bot CLI loads the skills with --plugin-dir (host-controlled);
# user-authored skills stay box-owned in /home/box/.claude/skills and the host never rm's or cp's there for plugins.
install -d -o root -g root -m 0755 /var/lib/bots
install -d -o bothost -g bots -m 2750 /var/lib/bots/cc-managed /var/lib/bots/cc-managed/skills /var/lib/bots/cc-managed/plugins

install -m 0755 -o root -g root "$HERE/files/bot-claude" /usr/local/bin/bot-claude
install -m 0755 -o root -g root "$HERE/files/bot-claude-bwrap" /usr/local/bin/bot-claude-bwrap
install -d -m 0755 /usr/local/libexec
install -m 0755 -o root -g root "$HERE/files/bot-claude-as-box" /usr/local/libexec/bot-claude-as-box
install -m 0755 -o root -g root "$HERE/files/bot-fs-query" /usr/local/libexec/bot-fs-query
install -m 0755 -o root -g root "$HERE/files/bot-reap" /usr/local/libexec/bot-reap
install -m 0755 -o root -g root "$HERE/files/bot-git-as-box" /usr/local/libexec/bot-git-as-box
install -m 0755 -o root -g root "$HERE/files/bot-mcp-as-box" /usr/local/libexec/bot-mcp-as-box
install -m 0755 -o root -g root "$HERE/files/bot-claude-read-session" /usr/local/libexec/bot-claude-read-session
install -m 0755 -o root -g root "$HERE/files/bot-claude-write-session" /usr/local/libexec/bot-claude-write-session
install -m 0755 -o root -g root "$HERE/files/bot-claude-delete-session" /usr/local/libexec/bot-claude-delete-session
# CONTROLLER RULING (final secfix round 2, SkillLibrary follow-up): SkillLibrary.write()/.remove()
# for user-authored skills in the box-writable ~/.claude/skills must not use the host process's own
# fs operations, for the same reason the session helpers above exist. bot-claude-skill-write and
# bot-claude-skill-delete run the actual mutation as user box, confined to
# /home/box/.claude/skills/<validated id>, refusing any symlink in the chain.
install -m 0755 -o root -g root "$HERE/files/bot-claude-skill-write" /usr/local/libexec/bot-claude-skill-write
install -m 0755 -o root -g root "$HERE/files/bot-claude-skill-delete" /usr/local/libexec/bot-claude-skill-delete
# Follow-up controller ruling: writeHelper() (a skill's non-SKILL.md helper files) carries the same
# race, so it routes through this helper the same way, confined to that skill's own directory.
install -m 0755 -o root -g root "$HERE/files/bot-claude-skill-write-file" /usr/local/libexec/bot-claude-skill-write-file
# Bug #66: one OS account per Bot (bot-user ensure/remove, reserved uids 60200-61099, homes /home/bots/<name> 0700).
# /home/bots is root-owned 0711: a Bot can reach its own home by name and can't list or plant anything there.
install -m 0755 -o root -g root "$HERE/files/bot-user" /usr/local/libexec/bot-user
install -d -o root -g root -m 0711 /home/bots
# synapse-public (review round 2, S1): Bots reach Claude with the Anthropic API key only. No stored Claude login may sit
# in box's or any Bot's config dir (all app accounts), the old setup token goes, and managed settings pin the CLI's login
# method to the Console. Idempotent; runs on every provision.
install -m 0755 -o root -g root "$HERE/files/retire-claude-login" /usr/local/libexec/retire-claude-login
/usr/local/libexec/retire-claude-login /
install -m 0440 -o root -g root "$HERE/files/sudoers-bothost" /etc/sudoers.d/bothost
visudo -cf /etc/sudoers.d/bothost

install -m 0644 -o root -g root "$HERE/files/bothost.service" /etc/systemd/system/bothost.service
systemctl daemon-reload
systemctl enable bothost

# Portable install: no Bot account may hold sudo. OrbStack gives its default user (created with -u, never
# box/bothost/boxmcp) NOPASSWD sudo through /etc/sudoers.d/orbstack; refuse to carry on if that user is one
# of ours, rather than run Bots with root one command away.
for u in box bothost boxmcp; do
  if id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx sudo || grep -Eq "^[[:space:]]*$u[[:space:]]" /etc/sudoers.d/orbstack 2>/dev/null; then
    echo "provision: user $u has sudo; this machine's default user must not be a Bot account" >&2
    exit 1
  fi
done

step 6 "desktop packages"

# ---- Phase 3 desktop (plan 2026-09-19 Task 2) ----
# Bug 3 (hand-test after a long engineering build): python3 was here but pip was not, so a Bot's `pip3
# install`/`pip3 show` always failed with no package manager at all (bug-log 194's full-auto commands
# checked for `playwright` with `pip3 show`). python3-venv rides along so a Bot can isolate installs
# instead of fighting Debian's externally-managed-environment guard. A re-provision is needed to pick
# this up on an already-provisioned box.
# shellcheck disable=SC2086
apt-get $APT install -y --no-install-recommends \
  xvfb xfwm4 picom plank thunar xfce4-terminal mousepad x11vnc chromium xdotool ffmpeg imagemagick fonts-noto \
  zstd rsync sqlite3 xauth dbus-x11 x11-utils x11-xserver-utils xinput python3 python3-pip python3-venv curl jq
# Live perception (decisions.md 2026-09-21): AT-SPI bus + Python bindings for bot-atspi, and tesseract for
# local OCR of cropped regions (spawned per ask, never resident).
step 7 "screen reading and OCR"
# shellcheck disable=SC2086
apt-get $APT install -y --no-install-recommends \
  at-spi2-core python3-gi gir1.2-atspi-2.0 tesseract-ocr tesseract-ocr-eng
step 8 "desktop"
install -d -m 0755 /etc/bots /usr/local/lib/bots /usr/local/share/bots
install -m 0644 -o root -g root "$HERE/desktop.env" /etc/bots/desktop.env
# Portable install: how many screens fit is THIS machine's memory, not the build Mac's (desktop.env was measured
# on one 8 GB box). Each screen measured PER_SCREEN_MB; 2 GB stays for the host and the Bots. 1 to 3 screens.
per_screen="$(sed -n 's/^PER_SCREEN_MB=//p' /etc/bots/desktop.env)"
mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
screens=$(( (mem_mb - 2048) / ${per_screen:-1726} ))
[ "$screens" -lt 1 ] && screens=1
[ "$screens" -gt 3 ] && screens=3
sed -i "s/^MAX_SCREENS_RECOMMENDED=.*/MAX_SCREENS_RECOMMENDED=$screens/" /etc/bots/desktop.env
install -m 0644 -o root -g root "$HERE/files/tmpfiles-bots.conf" /etc/tmpfiles.d/bots.conf
systemd-tmpfiles --create /etc/tmpfiles.d/bots.conf
for f in bot-desktop-session display-cookie vnc-serve shell-runner atspi-dump.py proc-hidepid; do install -m 0755 -o root -g root "$HERE/files/$f" "/usr/local/lib/bots/$f"; done
for f in box-chrome box-doctor bot-wallpaper; do install -m 0755 -o root -g root "$HERE/files/$f" "/usr/local/bin/$f"; done
for f in bot-display bot-shell bot-snapshot bot-atspi; do install -m 0755 -o root -g root "$HERE/files/$f" "/usr/local/libexec/$f"; done
# Bug #66 follow-up: bots-hidepid.service (/proc hidepid=invisible, group procview sees all) is installed here but
# only ENABLED by box/migrate-per-bot-uid.sh --apply, and disabled again by its rollback.
for u in bot-display@.service bot-chrome@.service bot-vnc@.service bots-hidepid.service; do install -m 0644 -o root -g root "$HERE/files/$u" "/etc/systemd/system/$u"; done
/usr/local/bin/bot-wallpaper generate
install -d -o box -g bots -m 2775 /workspace/.bot /workspace/.bot/terminals /workspace/.bot/screens /workspace/.bot/tools
# Dock: browser, files, terminal — so Take over has a place to type (CMP desktop).
install -d -o box -g box -m 0755 /home/box/.config/plank/dock1/launchers
install -d -m 0755 /usr/local/share/bots/plank
for item in chromium thunar xfce4-terminal; do
  install -m 0644 -o root -g root "$HERE/files/plank-$item.dockitem" "/usr/local/share/bots/plank/${item}.dockitem"
  install -m 0644 -o box -g box "$HERE/files/plank-$item.dockitem" "/home/box/.config/plank/dock1/launchers/${item}.dockitem"
done
install -d -o box -g bots -m 0700 /home/box/chrome-profile /home/box/.chrome-screens
install -d -o bothost -g bothost -m 0700 /home/box/.host/run /home/box/.host/snapshots
# CMP-14: the host (bothost) writes the reference docs at boot; box reads them and can't rewrite them.
install -d -o bothost -g bots -m 0755 /home/box/reference
chown -R bothost:bots /home/box/reference
# Decision 6: box never gets sudo (CMP-02's apt grant is deliberately not installed).
rm -f /etc/sudoers.d/box
# Bug 117: only bothost, box and the Bot uids may connect to the host's auth proxy port (47802, or this Mac user's own
# port from the host's ports drop-in: shared/src/user-ports.ts). The shipped rule is a template; bots-ports renders it for
# the drop-in's port and loads it, here and at every boot, so a re-provision never puts back a rule for the wrong port.
install -d -m 0755 /etc/bots
install -m 0644 -o root -g root "$HERE/files/bots-auth-proxy.nft" /etc/bots/auth-proxy.nft.in
install -m 0755 -o root -g root "$HERE/files/bots-ports" /usr/local/lib/bots/bots-ports
/usr/local/lib/bots/bots-ports load
install -m 0644 -o root -g root "$HERE/files/bots-auth-proxy.service" /etc/systemd/system/bots-auth-proxy.service
systemctl daemon-reload
systemctl enable --now bots-auth-proxy.service
systemctl enable --now bot-display@1.service bot-vnc@1.service bot-chrome@1.service

# Bug #66, decided for new installs (portable install): a box provisioned for the first time runs every Bot
# as its own OS account from the start — nothing to migrate, so the host starts that way. A box that was
# provisioned before keeps whatever it has (box/migrate-per-bot-uid.sh moves one over, and back).
# Fix round 1: a box rebuilt to receive a snapshot takes the mode of the box the snapshot came from — the Mac
# passes PER_BOT_UID=on|off — because an unmigrated snapshot restored onto per-Bot accounts is unreadable to
# every Bot. auto (the default): on for a first provision, left alone after.
per_bot_uid_wanted() {
  case "${PER_BOT_UID:-auto}" in
    on) return 0 ;;
    off) return 1 ;;
    *) [ "$FRESH" = "1" ] ;;
  esac
}
case "${PER_BOT_UID:-auto}" in on|off|auto) ;; *) echo "provision: PER_BOT_UID must be on, off or auto" >&2; exit 1 ;; esac
# Bug 284: a drop-in written before the rename sets only BOTS_PER_BOT_UID=1, and an existing box keeps its mode, so it
# is brought up to both names here (true when it changed it). The host reads the old name for one release only.
per_bot_uid_dropin_names() {
  local f="$1"
  [ -f "$f" ] && grep -qx 'Environment=BOTS_PER_BOT_UID=1' "$f" || return 1
  grep -qx 'Environment=SYNAPSE_PER_BOT_UID=1' "$f" && return 1
  printf '[Service]\nEnvironment=SYNAPSE_PER_BOT_UID=1\nEnvironment=BOTS_PER_BOT_UID=1\n' > "$f"
}
step 9 "Bot accounts"
if per_bot_uid_wanted; then
  install -d -m 0755 /etc/systemd/system/bothost.service.d
  # Bug 284: the old name too, so a host an app downgrade redeploys (it reads only BOTS_PER_BOT_UID) stays walled.
  printf '[Service]\nEnvironment=SYNAPSE_PER_BOT_UID=1\nEnvironment=BOTS_PER_BOT_UID=1\n' > /etc/systemd/system/bothost.service.d/50-per-bot-uid.conf
  if /usr/local/lib/bots/proc-hidepid on; then systemctl enable bots-hidepid.service; fi
  systemctl daemon-reload
fi
if per_bot_uid_dropin_names /etc/systemd/system/bothost.service.d/50-per-bot-uid.conf; then systemctl daemon-reload; fi

# Phase 4: cloudflared for the optional public webhook URL (RTN-11). Pinned and checksummed; optional, so a
# failure here never fails setup.
step 10 "finishing"
if ! command -v cloudflared >/dev/null 2>&1; then
  {
    curl -fsSL --retry 3 -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64.deb" &&
    echo "${CLOUDFLARED_SHA256}  /tmp/cloudflared.deb" | sha256sum -c - >/dev/null &&
    dpkg -i /tmp/cloudflared.deb
  } || echo "provision: warning: cloudflared could not be installed (only the public webhook URL needs it)"
  rm -f /tmp/cloudflared.deb
fi
apt-get clean
# CMP-11: the image version the Mac compares with its bundled box/ files ("The computer is up to date").
# Written LAST, with the provisioned marker, so an interrupted run is never mistaken for a finished one.
(cd "$HERE" && cat provision.sh desktop.env $(find files -type f ! -name '._*' | LC_ALL=C sort) | sha256sum | cut -c1-16) > /etc/bots/image-version.new
mv /etc/bots/image-version.new /etc/bots/image-version
cp /etc/bots/image-version /etc/bots/provisioned

echo "provision: done"
