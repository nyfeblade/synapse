#!/usr/bin/env bash
# Streams box/files + provision.sh into the isolated box over orb stdin (no shared folders) and runs it as root.
# Portable install: the machine is $BOX_MACHINE (orb.sh). Safe to run again at any point: a provision left
# behind by an interrupted run is stopped first, and provision.sh itself resumes.
set -euo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
export COPYFILE_DISABLE=1  # no macOS AppleDouble ._* files in the stream (they changed the image version)
ROOT="$(cd "$(dirname "$0")" && pwd)"
# The bracket keeps pkill from matching its own command line.
ORB_TIMEOUT=30 orb -m "$BOX_MACHINE" -u root pkill -f '^bash /tmp/prov/provision[.]sh' >/dev/null 2>&1 || true
# PER_BOT_UID (on|off|auto): a box rebuilt to receive a snapshot takes that snapshot's per-Bot-account mode.
PER_BOT_UID="${PER_BOT_UID:-auto}"
case "$PER_BOT_UID" in on|off|auto) ;; *) echo "provision-from-mac: PER_BOT_UID must be on, off or auto" >&2; exit 2 ;; esac
# The whole in-box provision is one orb call: bounded at 60 min, bug 435. The app stops the whole script a little
# later (SCRIPT_LIMITS.provision, 65 min: this stream plus the short calls around it), so this limit fires first.
tar -C "$ROOT" -czf - provision.sh files desktop.env | ORB_TIMEOUT=3600 orb -m "$BOX_MACHINE" -u root sh -c \
  "rm -rf /tmp/prov && mkdir -p /tmp/prov && tar -xzf - -C /tmp/prov && PER_BOT_UID=$PER_BOT_UID bash /tmp/prov/provision.sh"
# Two accounts on one Mac: this Mac user's own ports (orb.sh), again after provision.sh reinstalled the shipped
# firewall rule. The host picks them up at deploy's restart.
box_apply_ports
