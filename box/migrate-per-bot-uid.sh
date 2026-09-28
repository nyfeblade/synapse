#!/usr/bin/env bash
# Bug #66: moves every Bot from the shared uid `box` to its own OS account. ONLY the user runs this.
#   box/migrate-per-bot-uid.sh             dry run: prints every account and move, changes nothing
#   box/migrate-per-bot-uid.sh --apply     does it: stops the host, makes the accounts, moves each Bot's CLI sessions
#                                          and screen profile into its own 0700 home, switches the host over, starts it
# Before it: box/provision-from-mac.sh (the new root helpers and sudoers rule) and box/deploy.sh (the new host).
# Idempotent and resumable (run it again after an interruption). Undo: box/rollback-per-bot-uid.sh.
# The on-box work is box/files/per-bot-uid-migrate, streamed in and run as root.
set -euo pipefail
export COPYFILE_DISABLE=1
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
case "${1:-}" in ''|--dry-run|--apply) ;; *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 2 ;; esac
orb -m "$BOX_MACHINE" -u root sh -c 'install -d -m 0700 /run/bots-migrate && cat > /run/bots-migrate/per-bot-uid-migrate && chmod 0700 /run/bots-migrate/per-bot-uid-migrate' \
  < "$HERE/files/per-bot-uid-migrate"
orb -m "$BOX_MACHINE" -u root /run/bots-migrate/per-bot-uid-migrate "$@" </dev/null
if [ "${1:-}" = --apply ]; then
  "$HERE/check-gateway.sh"
  echo "Next: box/verify-box.sh (the per-Bot walls section proves one Bot can't read another's files)."
fi
