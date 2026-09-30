#!/usr/bin/env bash
# Ready-made Bots' computer (0.1.5, docs/superpowers/specs/2026-09-29-ready-made-box-design.md). Runs INSIDE a box, as
# root, streamed over orb stdin like provision.sh:
#   strip           the build machine, just before `orb export`: removes everything one install must never share with
#                   another (the host's tokens and keys, its databases, the Bots' data, browser profiles, logs, the
#                   machine id, the build Mac's networks), and stops and disables the host so nothing makes new ones.
#   adopt VERSION   a machine just imported from the image, before the app deploys to it: refuses an image that still
#                   holds any of that (exit 3), then gives this install its own machine id, created marker and screen
#                   count, and enables the host. The host makes this install's own token and keys at its first start
#                   (deploy). VERSION is the image version the app expects (/etc/bots/image-version must match).
#   check           exit 0 only when none of the per-install files are there (the build runs it after strip).
set -euo pipefail
MODE="${1:-}"

# Every path that holds per-install secrets or identity. Directories are emptied and kept (with their owner and mode).
EMPTY_DIRS=(
  /home/box/.host /home/box/agent-data /home/box/chrome-profile /home/box/.chrome-screens /home/box/reference
  /home/box/.bot-cwd /var/lib/bothost /var/lib/boxmcp /var/lib/bots/cc-managed/skills /var/lib/bots/cc-managed/plugins
  /home/box/.claude /tmp /var/tmp
)
# The Bots' desktop services start at boot and write a browser profile: the image ships them off, adopt turns them on.
SERVICES=(bot-display@1.service bot-vnc@1.service bot-chrome@1.service)
# Made again by every boot of an imported machine, for that machine: the machine id (empty in the image; systemd makes
# a new one at this install's first boot), the random seed, and the Mac addresses the firewall resolves (bots-ports load).
BOOT_IDS=(/etc/machine-id /var/lib/dbus/machine-id /var/lib/systemd/random-seed /etc/bots/mac-hosts)
SECRET_FILES=(
  /var/lib/systemd/credential.secret
  /etc/bots/created-by-synapse /home/box/.claude.json /home/box/.claude.json.backup
  /etc/systemd/system/bothost.service.d/10-bind.conf /etc/systemd/system/bothost.service.d/20-ports.conf
)

# Files left in one of the emptied trees (dirs the build made are fine; any file is not).
# $1 = boot: skip what the first boot of an imported machine makes on its own (a new machine id and random seed).
leftovers() {
  local d
  for d in /home/box/.host /home/box/agent-data /home/box/chrome-profile /home/box/.chrome-screens /var/lib/bothost \
    /var/lib/boxmcp /var/lib/bots/cc-managed /home/bots; do
    [ -d "$d" ] && find "$d" -mindepth 1 ! -type d -print -quit
  done
  for f in "${SECRET_FILES[@]}"; do [ -s "$f" ] && echo "$f"; done
  if [ "${1:-}" != boot ]; then for f in "${BOOT_IDS[@]}"; do [ -s "$f" ] && echo "$f"; done; fi
  find /home/box/.claude -mindepth 1 ! -type d -print -quit 2>/dev/null
  ls /etc/ssh/ssh_host_*_key 2>/dev/null
  getent passwd | cut -d: -f1 | grep -E '^bot-[0-9a-f]{12}$' || true
  grep -Eq '^MAC_NETS=.+' /etc/bots/net-guard.conf 2>/dev/null && echo /etc/bots/net-guard.conf
  true
}

strip() {
  systemctl disable --now bothost >/dev/null 2>&1 || true
  systemctl disable --now "${SERVICES[@]}" >/dev/null 2>&1 || true
  systemctl stop 'bot-chrome@*' 'bot-vnc@*' 'bot-display@*' >/dev/null 2>&1 || true
  # Any Bot account a check left behind goes with its home.
  for a in $(getent passwd | cut -d: -f1 | grep -E '^bot-[0-9a-f]{12}$' || true); do /usr/local/libexec/bot-user remove "$a" >/dev/null 2>&1 || userdel -r "$a" || true; done
  rm -rf --one-file-system /home/bots/* 2>/dev/null || true
  rm -f /var/lib/bots/bot-uid-next
  local d
  for d in "${EMPTY_DIRS[@]}"; do
    [ -d "$d" ] && [ ! -L "$d" ] && find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} +
  done
  # What provision.sh made inside the emptied trees, put back as it made them.
  install -d -o box -g bots -m 2775 /home/box/.claude/skills
  install -d -o bothost -g bots -m 0700 /home/box/agent-data/agents /home/box/agent-data/agent-transcripts
  install -d -o bothost -g bothost -m 0700 /home/box/.host/run /home/box/.host/snapshots
  install -d -o boxmcp -g boxmcp -m 0700 /var/lib/boxmcp
  chmod 1777 /tmp /var/tmp
  # The Bots' and the host's work files in /workspace (the folders stay: provision made them).
  find /workspace -mindepth 1 ! -type d -delete
  rm -rf /workspace/.verify-walls
  for f in "${SECRET_FILES[@]}"; do rm -f -- "$f"; done
  # systemd makes a new machine id at the first boot when the file is empty; dbus links to it.
  rm -f /var/lib/dbus/machine-id /var/lib/systemd/random-seed /etc/bots/mac-hosts
  : > /etc/machine-id
  # OrbStack writes the machine's own name at every start; the image carries a neutral one.
  echo synapse-box > /etc/hostname
  sed -i -E 's/^127\.0\.1\.1[[:space:]].*/127.0.1.1\tsynapse-box/' /etc/hosts
  rm -f /etc/ssh/ssh_host_*
  # The build Mac's networks (the app passes each Mac's own at deploy).
  [ -f /etc/bots/net-guard.conf ] && sed -i -E 's/^(MAC_NETS|BOX_NETS)=.*/\1=/' /etc/bots/net-guard.conf
  # Histories, caches, logs, apt lists (apt-get update runs before any later install).
  rm -rf /root/.dbus /home/*/.dbus /root/.bash_history /root/.cache /root/.npm /root/.claude /root/.claude.json /root/.config /root/.local \
    /home/*/.bash_history /home/*/.cache /home/*/.npm /home/box/.local /home/box/.config/chromium /home/box/.Xauthority \
    /home/box/.lesshst /opt/bothost/app.old /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/debconf/*-old
  apt-get clean
  # The journal (its folder is named by the machine id) moves to /run until the next boot, and the disk copy goes.
  journalctl --relinquish-var >/dev/null 2>&1 || true
  rm -rf /var/log/journal/*
  find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
  find /var/log -type f -exec truncate -s 0 {} +
  sync
  local left; left="$(leftovers)"
  if [ -n "$left" ]; then echo "image-prep: still per-install: $left" >&2; exit 3; fi
  echo "image-prep: stripped"
}

adopt() {
  local want="${1:-}"
  [[ "$want" =~ ^[0-9a-f]{16}$ ]] || { echo "image-prep: adopt needs the expected image version" >&2; exit 2; }
  [ "$(cat /etc/bots/image-version 2>/dev/null)" = "$want" ] || { echo "image-prep: this image is not version $want" >&2; exit 3; }
  local left; left="$(leftovers boot)"
  if [ -n "$left" ]; then echo "image-prep: the image holds per-install files; refusing it: $(echo "$left" | head -3 | tr '\n' ' ')" >&2; exit 3; fi
  # This install's own identity (systemd made the machine id at first boot; a missing one is made here).
  [ -s /etc/machine-id ] || { rm -f /etc/machine-id; systemd-machine-id-setup >/dev/null; }
  install -d -m 0755 /var/lib/dbus && ln -sf /etc/machine-id /var/lib/dbus/machine-id
  if command -v sshd >/dev/null 2>&1; then ssh-keygen -A >/dev/null; fi
  install -d -m 0755 /etc/bots
  date -u +%FT%TZ > /etc/bots/created-by-synapse
  # How many screens fit is THIS machine's memory (provision.sh step 8, same formula).
  local per_screen mem_mb screens
  per_screen="$(sed -n 's/^PER_SCREEN_MB=//p' /etc/bots/desktop.env)"
  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  screens=$(( (mem_mb - 2048) / ${per_screen:-1726} ))
  [ "$screens" -lt 1 ] && screens=1
  [ "$screens" -gt 3 ] && screens=3
  sed -i "s/^MAX_SCREENS_RECOMMENDED=.*/MAX_SCREENS_RECOMMENDED=$screens/" /etc/bots/desktop.env
  # The firewall is loaded before anything else runs (fail closed), then the host is enabled; deploy starts it with
  # this Mac user's ports and this install's token.
  /usr/local/lib/bots/bots-ports load >/dev/null
  systemctl enable --now "${SERVICES[@]}" >/dev/null 2>&1
  systemctl enable bothost >/dev/null 2>&1
  echo "image-prep: adopted"
}

case "$MODE" in
  strip) strip ;;
  adopt) adopt "${2:-}" ;;
  check) left="$(leftovers)"; [ -z "$left" ] || { echo "$left"; exit 3; } ;;
  *) echo "usage: image-prep.sh strip | adopt VERSION | check" >&2; exit 2 ;;
esac
