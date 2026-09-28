#!/usr/bin/env bash
# Mac-side check: /health through the route chosen by spike-p0.sh, and Origin → 403. Waits up to 60 s
# (a cold box takes longer than the 10 s it used to allow). Portable install: machine $BOX_MACHINE (orb.sh).
set -euo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/route.env"
INFO=""
for _ in $(seq 1 120); do
  INFO="$(orb -m "$BOX_MACHINE" -u root cat /home/box/.host/gateway.json 2>/dev/null || true)"
  [ -n "$INFO" ] && break; sleep 0.5
done
[ -n "$INFO" ] || { echo "FAIL gateway.json not written"; exit 1; }
# plutil (macOS) reads JSON: Synapse.app runs this with Finder's PATH, which has no node.
PORT="$(printf '%s' "$INFO" | plutil -extract port raw -o - -)"
TOKEN="$(printf '%s' "$INFO" | plutil -extract token raw -o - -)"
TPID=""
if [ "$GATEWAY_ROUTE" = "ssh-tunnel" ]; then
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "${PORT}:127.0.0.1:${PORT}" "${BOX_MACHINE}@orb" & TPID=$!; sleep 2
fi
trap '[ -n "$TPID" ] && kill "$TPID" 2>/dev/null || true' EXIT
URL="http://${GATEWAY_HOST}:${PORT}"
for _ in $(seq 1 120); do
  if OUT="$(curl -sf --max-time 1.5 -H "Authorization: Bearer ${TOKEN}" "${URL}/health")"; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" -H 'Origin: http://evil.example' "${URL}/health")"
    [ "$CODE" = "403" ] || { echo "FAIL Origin header returned $CODE, expected 403"; exit 1; }
    echo "PASS gateway /health via ${GATEWAY_ROUTE}: ${OUT}"; exit 0
  fi
  sleep 0.5
done
echo "FAIL gateway /health via ${GATEWAY_ROUTE} (${URL})"; exit 1
