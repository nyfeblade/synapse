#!/usr/bin/env bash
# P0-01: can we move bytes into the isolated box without shared folders?
# P0-02: which Mac→box route reaches a server in the box?  Writes box/route.env.
# P0-03: what RAM/vCPU does the box really see (ORIG-16 caps)?
set -uo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
ROOT="$(cd "$(dirname "$0")" && pwd)"
M="$BOX_MACHINE"

echo "== P0-01 transfer"
if [ "$(printf hello | orb -m $M -u root sh -c 'cat > /tmp/p0-transfer && cat /tmp/p0-transfer')" = "hello" ]; then
  echo "PASS P0-01 stdin stream transfer (deploy uses this)"
else
  echo "FAIL P0-01 stdin stream transfer — fallback: scp over ssh ${M}@orb"; exit 1
fi
echo hello > /tmp/p0-push.txt
if orb push -m $M /tmp/p0-push.txt /tmp/ >/dev/null 2>&1; then echo "INFO P0-01 orb push works (not required)"; else echo "INFO P0-01 orb push unavailable in isolated mode (expected; not required)"; fi

echo "== P0-02 gateway route"
orb -m $M -u root sh -c 'pkill -f p0-route-server || true'
orb -m $M -u root sh -c 'nohup /usr/local/bin/node -e "require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(47899,\"127.0.0.1\")" p0-route-server >/dev/null 2>&1 &'
orb -m $M -u root sh -c 'nohup /usr/local/bin/node -e "require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(47898,\"0.0.0.0\")" p0-route-server >/dev/null 2>&1 &'
sleep 1
ROUTE=""; BIND=""; HOST=""
if [ "$(curl -s --max-time 2 http://127.0.0.1:47899)" = "ok" ]; then
  ROUTE=localhost; BIND=127.0.0.1; HOST=127.0.0.1; echo "PASS P0-02 localhost forwarding of a 127.0.0.1 listener"
elif [ "$(curl -s --max-time 2 http://${M}.orb.local:47898)" = "ok" ]; then
  ROUTE=orb-hostname; BIND=0.0.0.0; HOST=${M}.orb.local; echo "PASS P0-02 ${M}.orb.local to a 0.0.0.0 listener"
else
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -N -L 47897:127.0.0.1:47899 "${M}@orb" &
  TPID=$!; sleep 2
  if [ "$(curl -s --max-time 2 http://127.0.0.1:47897)" = "ok" ]; then
    ROUTE=ssh-tunnel; BIND=127.0.0.1; HOST=127.0.0.1; echo "PASS P0-02 ssh tunnel via ${M}@orb"
  fi
  kill $TPID 2>/dev/null || true
fi
orb -m $M -u root sh -c 'pkill -f p0-route-server || true'
if [ -z "$ROUTE" ]; then echo "FAIL P0-02 no route works — stop and ask the user"; exit 1; fi
printf 'GATEWAY_ROUTE=%s\nHOST_BIND=%s\nGATEWAY_HOST=%s\n' "$ROUTE" "$BIND" "$HOST" > "$ROOT/route.env"
echo "wrote box/route.env ($ROUTE)"

echo "== P0-03 resources"
orb -m $M -u root sh -c 'echo "vCPU $(nproc)"; awk "/MemTotal/ {printf \"RAM %.1f GiB\n\", \$2/1048576}" /proc/meminfo'
echo "INFO the supervisor derives maxLive/maxRunning from these at runtime (Task 16)."
