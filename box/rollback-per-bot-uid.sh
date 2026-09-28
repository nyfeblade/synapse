#!/usr/bin/env bash
# Bug #66 rollback: puts every Bot back on the shared uid `box`. ONLY the user runs this.
#   box/rollback-per-bot-uid.sh            dry run: prints every move back, changes nothing
#   box/rollback-per-bot-uid.sh --apply    does it: stops the host, moves every journalled file back (and any session
#                                          a Bot started since), hands staging back to group bots, drops the host's
#                                          SYNAPSE_PER_BOT_UID drop-in, starts the host as before
# The accounts and their (now emptied) homes are kept and nothing runs as them; `bot-user remove <botId>` deletes one.
# Idempotent: running it twice moves nothing the second time. The code needs no rollback: with the flag off the new
# host and helpers behave exactly as before (every Bot as box).
set -euo pipefail
export COPYFILE_DISABLE=1
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
case "${1:-}" in ''|--dry-run|--apply) ;; *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 2 ;; esac
orb -m "$BOX_MACHINE" -u root sh -c 'install -d -m 0700 /run/bots-migrate && cat > /run/bots-migrate/per-bot-uid-migrate && chmod 0700 /run/bots-migrate/per-bot-uid-migrate' \
  < "$HERE/files/per-bot-uid-migrate"
orb -m "$BOX_MACHINE" -u root /run/bots-migrate/per-bot-uid-migrate --rollback "$@" </dev/null
if [ "${1:-}" = --apply ]; then "$HERE/check-gateway.sh"; fi
