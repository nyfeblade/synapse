#!/usr/bin/env bash
# Mac-side check: /health through the route chosen by spike-p0.sh, and Origin → 403. Waits up to 60 s
# (a cold box takes longer than the 10 s it used to allow). Portable install: machine $BOX_MACHINE (orb.sh).
set -euo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/route.env"
TRIES="${SYNAPSE_CHECK_TRIES:-120}"
# Two accounts on one Mac: the host must be up on THIS Mac user's port (orb.sh). A gateway.json from before the
# restart names the old port, so it's read again until it names this one.
WANT="$SYNAPSE_GATEWAY_PORT"
INFO=""; PORT=""
for _ in $(seq 1 "$TRIES"); do
  # Each read is bounded (10 s, orb.sh): the hang (bug 435) shows up right after the host restarts; the loop reads again.
  INFO="$(ORB_TIMEOUT=10 orb -m "$BOX_MACHINE" -u root cat /home/box/.host/gateway.json 2>/dev/null || true)"
  # plutil (macOS) reads JSON: Synapse.app runs this with Finder's PATH, which has no node.
  if [ -n "$INFO" ]; then PORT="$(printf '%s' "$INFO" | plutil -extract port raw -o - - 2>/dev/null || true)"; fi
  [ -n "$INFO" ] && [ "$PORT" = "$WANT" ] && break; sleep 0.5
done
[ -n "$INFO" ] || { echo "FAIL gateway.json not written"; exit 1; }
[ "$PORT" = "$WANT" ] || { echo "FAIL the host is on port ${PORT:-none}, not this account's port $WANT"; exit 1; }
TOKEN="$(printf '%s' "$INFO" | plutil -extract token raw -o - -)"
# This runs on the Mac, where another account can read any process's arguments with ps: the token goes to curl as a
# config line on stdin (-K -), never as an argument. printf is a builtin.
auth_header() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }
TPID=""
if [ "$GATEWAY_ROUTE" = "ssh-tunnel" ]; then
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L "${PORT}:127.0.0.1:${PORT}" "${BOX_MACHINE}@orb" & TPID=$!; sleep 2
fi
trap '[ -n "$TPID" ] && kill "$TPID" 2>/dev/null || true' EXIT
URL="http://${GATEWAY_HOST}:${PORT}"
WRONG_HOST="FAIL ${URL}: Synapse is running in another account on this Mac and is using this account's connection. Quit Synapse there, then retry."
# Proof of host (host/gateway/server.ts): a host that writes "hello": 1 answers /hello?nonce=N with
# HMAC-SHA256(key = token, "synapse-hello:" + N). It is checked BEFORE the token is sent, so whatever else answers the
# port (another account's host, or anyone who bound it during the restart) never gets it. An older host has no /hello.
HELLO="$(printf '%s' "$INFO" | plutil -extract hello raw -o - - 2>/dev/null || true)"
if [ "$HELLO" = "1" ]; then
  PROVEN=""
  for _ in $(seq 1 "$TRIES"); do
    N="$(openssl rand -hex 16)"
    ANSWER="$(curl -s --max-time 1.5 "${URL}/hello?nonce=${N}" || true)"
    if [ -n "$ANSWER" ]; then
      GOT="$(printf '%s' "$ANSWER" | plutil -extract proof raw -o - - 2>/dev/null || true)"
      EXPECT="$(synapse_hello_hmac "$N")"
      if [ -n "$GOT" ] && [ "$GOT" = "$EXPECT" ]; then PROVEN=1; break; fi
      echo "$WRONG_HOST"; exit 1
    fi
    sleep 0.5
  done
  [ -n "$PROVEN" ] || { echo "FAIL gateway /hello via ${GATEWAY_ROUTE} (${URL})"; exit 1; }
fi
for _ in $(seq 1 "$TRIES"); do
  if OUT="$(auth_header | curl -K - -sf --max-time 1.5 "${URL}/health")"; then
    CODE="$(auth_header | curl -K - -s -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' "${URL}/health")"
    [ "$CODE" = "403" ] || { echo "FAIL Origin header returned $CODE, expected 403"; exit 1; }
    echo "PASS gateway /health via ${GATEWAY_ROUTE}: ${OUT}"; exit 0
  fi
  # Something answered and refused this box's own token: another account's host holds the port.
  CODE="$(auth_header | curl -K - -s --max-time 1.5 -o /dev/null -w '%{http_code}' "${URL}/health" || true)"
  if [ "$CODE" = "401" ]; then echo "$WRONG_HOST"; exit 1; fi
  sleep 0.5
done
echo "FAIL gateway /health via ${GATEWAY_ROUTE} (${URL})"; exit 1
