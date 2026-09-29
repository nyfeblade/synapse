#!/usr/bin/env bash
# Two accounts on one Mac, without a second account: builds a throwaway box that acts as another macOS user
# (SYNAPSE_UID, read by orb.sh) next to this account's real box, then runs the real provision, deploy (whose
# check-gateway proves the host with /hello before sending the token) and verify scripts against it.
# It passes when the test box takes that user's own ports, proves itself, and the real box is untouched.
# Usage: box/two-account-sim.sh [box-dir] [uid]  (box-dir: a packaged app's Contents/Resources/box, default ./box)
set -uo pipefail
B="${1:-$(cd "$(dirname "$0")" && pwd)}"; SIM_UID="${2:-502}"; M="synapse-twoacct-$$"; REAL="${REAL_BOX:-box}"
export BOX_MACHINE="$M" SYNAPSE_UID="$SIM_UID"
LOG="$(mktemp -d)"; trap 'orb delete -f "$M" >/dev/null 2>&1; rm -rf "$LOG"' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
# gateway.json fields other than the token (never printed).
info() { orb -m "$1" -u root sh -c 'cat /home/*/.host/gateway.json 2>/dev/null | head -c 4096' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("port"),d.get("hello"),d.get("startedAt"))'; }
before="$(info "$REAL" 2>/dev/null || echo none)"
want=$((47900 + ((SIM_UID - 502) % 125) * 10))
orb create -a arm64 --cpus 2 --memory 3072 --disk 16G -u synapse-admin debian:bookworm "$M" >"$LOG/create" 2>&1 || { cat "$LOG/create"; exit 1; }
bash "$B/provision-from-mac.sh" >"$LOG/prov" 2>&1 && ok "provision" || { tail -20 "$LOG/prov"; bad "provision"; }
bash "$B/deploy.sh" >"$LOG/deploy" 2>&1 && ok "deploy, host proved itself" || { tail -20 "$LOG/deploy"; bad "deploy"; }
read -r port hello _ <<<"$(info "$M")"
[ "$port" = "$want" ] && ok "test box uses port $want" || bad "test box port $port, want $want"
[ "$hello" = "1" ] && ok "test box answers /hello" || bad "test box has no /hello"
[ "$(curl -s -m5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$want/health")" = 401 ] && ok "test box refuses no token" || bad "test box answered without a token"
bash "$B/verify-box.sh" >"$LOG/verify" 2>&1
for c in "the rule guards this account's proxy port" "another local user can't reach the auth proxy" "the proxy refuses a made-up proxy token"; do
  grep -qF "PASS $c" "$LOG/verify" && ok "$c" || bad "$c"
done
after="$(info "$REAL" 2>/dev/null || echo none)"
[ "$before" = "$after" ] && ok "real box untouched ($REAL)" || bad "real box changed: $before -> $after"
exit $fail
