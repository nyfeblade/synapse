#!/usr/bin/env bash
# Two accounts on one Mac, without a second account: builds a throwaway box that acts as another macOS user
# (SYNAPSE_UID, read by orb.sh) next to this account's real box, then runs the real provision, deploy (whose
# check-gateway proves the host with /hello before sending the token) and verify scripts against it.
# It passes when the test box takes that user's own ports, proves itself, and the real box is untouched.
# Usage: box/two-account-sim.sh [box-dir] [uid]  (box-dir: a packaged app's Contents/Resources/box, default ./box)
set -uo pipefail
B="${1:-$(cd "$(dirname "$0")" && pwd)}"; SIM_UID="${2:-502}"; M="synapse-twoacct-$$"; REAL="${REAL_BOX:-box}"
export BOX_MACHINE="$M" SYNAPSE_UID="$SIM_UID"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"  # OrbStack.app's CLI first, as every box script does
LOG="$(mktemp -d)"; trap 'ORB_TIMEOUT=180 orb delete -f "$M" >/dev/null 2>&1; rm -rf "$LOG"' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
# gateway.json fields other than the token (never printed).
info() { orb -m "$1" -u root sh -c 'cat /home/*/.host/gateway.json 2>/dev/null | head -c 4096' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("port"),d.get("hello"),d.get("startedAt"))'; }
before="$(info "$REAL" 2>/dev/null || echo none)"
want=$((47900 + ((SIM_UID - 502) % 125) * 10))
ORB_TIMEOUT=1200 orb create -a arm64 --cpus 2 --memory 3072 --disk 16G -u synapse-admin debian:bookworm "$M" >"$LOG/create" 2>&1 || { cat "$LOG/create"; exit 1; }
bash "$B/provision-from-mac.sh" >"$LOG/prov" 2>&1 && ok "provision" || { tail -20 "$LOG/prov"; bad "provision"; }
bash "$B/deploy.sh" >"$LOG/deploy" 2>&1 && ok "deploy, host proved itself" || { tail -20 "$LOG/deploy"; bad "deploy"; }
read -r port hello _ <<<"$(info "$M")"
[ "$port" = "$want" ] && ok "test box uses port $want" || bad "test box port $port, want $want"
[ "$hello" = "1" ] && ok "test box answers /hello" || bad "test box has no /hello"
[ "$(curl -s -m5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$want/health")" = 401 ] && ok "test box refuses no token" || bad "test box answered without a token"
bash "$B/verify-box.sh" >"$LOG/verify" 2>&1
for c in "the rule guards this account's proxy port" "another local user can't reach the auth proxy" "the proxy refuses a made-up proxy token" \
  "the Mac guard is loaded" "root in the box reaches a Mac listener (control)" "a Bot account can't reach the Mac (host.orb.internal)" \
  "a Bot account can't reach the Mac (host.docker.internal)" "a Bot account can't reach the Mac (0.250.250.254)" \
  "box can't reach the Mac (host.docker.internal)" "box and the Bots are kept off the LAN (rule)" "a Bot account still resolves names (DNS allowed)" \
  "boxmcp can't reach the Mac" "a Bot account can't reach the Mac ([fd07:b51a:cc66:f0::fe])" "the host can confirm the firewall (bots-ports check)"; do
  grep -qF "PASS $c" "$LOG/verify" && ok "$c" || bad "$c"
done
# Bug 362: every "can't reach the Mac" check passed, the IPv6 one included (none may FAIL).
grep -q "^FAIL .*reach the Mac" "$LOG/verify" && bad "every Mac-reach check" || ok "every Mac-reach check"
# Bug 366: a Mac or LAN check that couldn't be proven (SKIP) is a failure here, not a pass.
grep -E "^SKIP .*(Mac|LAN)" "$LOG/verify" && bad "no Mac or LAN check skipped" || ok "no Mac or LAN check skipped"
# 0.1.4 Local network (Settings, owner only). A throwaway LAN INSIDE the test box: a network namespace behind a veth
# pair (10.77.0.2 and fd77::2 answer TCP, UDP and ping; 10.77.0.3 stands in for the Mac's own LAN address, passed in
# as the app does with `bots-ports mac-nets`). Nothing here reaches a device on the owner's network. A Bot is a uid in
# the Bot range; root is the control that proves each path exists.
BOT=60777
R() { orb -m "$M" -u root "$@"; }
as_uid() { local u="$1"; shift; R setpriv --reuid="$u" --regid="$u" --clear-groups -- "$@"; }
lanflag() { R /usr/local/lib/bots/bots-ports local-network 2>/dev/null; }
R sh -c 'ip netns add synlan && ip link add synlan0 type veth peer name synlan1 && ip link set synlan1 netns synlan &&
  ip addr add 10.77.0.1/24 dev synlan0 && ip -6 addr add fd77::1/64 dev synlan0 nodad && ip link set synlan0 up &&
  ip netns exec synlan sh -c "ip link set lo up; ip addr add 10.77.0.2/24 dev synlan1; ip addr add 10.77.0.3/24 dev synlan1; ip -6 addr add fd77::2/64 dev synlan1 nodad; ip link set synlan1 up"' >"$LOG/lan" 2>&1 \
  && ok "test LAN namespace up" || { cat "$LOG/lan"; bad "test LAN namespace up"; }
# Listeners in the namespace: HTTP (IPv4 and IPv6) on 8080, a line logger on TCP 9000 and UDP 9001. Killed below.
R sh -c 'nohup ip netns exec synlan python3 -c "
import socket,socketserver,threading,http.server
class H(http.server.BaseHTTPRequestHandler):
  def do_GET(s): s.send_response(200); s.end_headers(); s.wfile.write(b\"lan\")
  def log_message(s,*a): pass
class S6(http.server.ThreadingHTTPServer): address_family=socket.AF_INET6
def srv(): S6((\"::\",8080),H).serve_forever()
class L(socketserver.StreamRequestHandler):
  def handle(s):
    for l in s.rfile: open(\"/run/synlan-tcp.log\",\"ab\").write(l)
def tcp(): socketserver.ThreadingTCPServer.allow_reuse_address=True; socketserver.ThreadingTCPServer((\"0.0.0.0\",9000),L).serve_forever()
threading.Thread(target=srv,daemon=True).start(); threading.Thread(target=tcp,daemon=True).start()
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); u.bind((\"0.0.0.0\",9001))
while True: d,_=u.recvfrom(64); open(\"/run/synlan-udp.log\",\"ab\").write(d)
" >/dev/null 2>&1 & echo $! > /run/synlan.pid'
sleep 2
# A Mac listener on the Mac's 127.0.0.1 (what OrbStack forwards the Mac's addresses to), fixed answer, 5 minutes.
MPF="$(mktemp "$LOG/mp.XXXX")"
python3 -c 'import http.server,sys,threading
class H(http.server.BaseHTTPRequestHandler):
  def do_GET(s): s.send_response(200); s.end_headers(); s.wfile.write(b"mac")
  def log_message(s,*a): pass
s=http.server.HTTPServer(("127.0.0.1",0),H)
open(sys.argv[1],"w").write(str(s.server_address[1]));threading.Timer(300,s.shutdown).start();s.serve_forever()' "$MPF" </dev/null >/dev/null 2>&1 &
MPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$MPF" ] && break; sleep 0.5; done
MP="$(cat "$MPF")"
http_ok() { as_uid "$1" curl -sfg -m 3 -o /dev/null "http://$2/"; }
udp_ok() { R rm -f /run/synlan-udp.log; as_uid "$1" bash -c "echo $2 > /dev/udp/10.77.0.2/9001" >/dev/null 2>&1; sleep 1; R grep -qx "$2" /run/synlan-udp.log 2>/dev/null; }
ping_ok() { as_uid "$1" ping -c 1 -W 2 "$2" >/dev/null 2>&1; }
lan_blocked() {  # $1: label
  http_ok 0 10.77.0.2:8080 && ! http_ok $BOT 10.77.0.2:8080 && ok "$1: a Bot can't reach the LAN (TCP, IPv4)" || bad "$1: a Bot can't reach the LAN (TCP, IPv4)"
  http_ok 0 "[fd77::2]:8080" && ! http_ok $BOT "[fd77::2]:8080" && ok "$1: a Bot can't reach the LAN (TCP, IPv6)" || bad "$1: a Bot can't reach the LAN (TCP, IPv6)"
  udp_ok 0 u-root && ! udp_ok $BOT u-bot && ok "$1: a Bot can't send UDP to the LAN" || bad "$1: a Bot can't send UDP to the LAN"
  ping_ok 0 10.77.0.2 && ! ping_ok $BOT 10.77.0.2 && ok "$1: a Bot can't ping the LAN" || bad "$1: a Bot can't ping the LAN"
  ! http_ok box 10.77.0.2:8080 && ok "$1: box can't reach the LAN" || bad "$1: box can't reach the LAN"
}
[ "$(lanflag)" = off ] && ok "Local network is off by default" || bad "Local network is off by default (got '$(lanflag)')"
lan_blocked "off"
R /usr/local/lib/bots/bots-ports mac-nets "10.77.0.3/32" >/dev/null 2>&1 && ok "the app's Mac-address list goes in (10.77.0.3 as the Mac)" || bad "mac-nets 10.77.0.3/32"
# bothost has no way to flip it (its one sudoers line is `check`).
! R runuser -u bothost -- sudo -n /usr/local/lib/bots/bots-ports local-network on >/dev/null 2>&1 && [ "$(lanflag)" = off ] \
  && ok "the host (bothost) can't turn Local network on" || bad "the host (bothost) can't turn Local network on"
[ "$(R /usr/local/lib/bots/bots-ports local-network on 2>/dev/null)" = on ] && ok "Local network turns on live (no reprovision)" || bad "Local network turns on live"
http_ok $BOT 10.77.0.2:8080 && ok "on: a Bot reaches the LAN (TCP, IPv4)" || bad "on: a Bot reaches the LAN (TCP, IPv4)"
http_ok $BOT "[fd77::2]:8080" && ok "on: a Bot reaches the LAN (TCP, IPv6)" || bad "on: a Bot reaches the LAN (TCP, IPv6)"
udp_ok $BOT u-bot-on && ok "on: a Bot sends UDP to the LAN" || bad "on: a Bot sends UDP to the LAN"
ping_ok $BOT 10.77.0.2 && ok "on: a Bot pings the LAN" || bad "on: a Bot pings the LAN"
http_ok box 10.77.0.2:8080 && ok "on: box reaches the LAN" || bad "on: box reaches the LAN"
http_ok 0 10.77.0.3:8080 && ! http_ok $BOT 10.77.0.3:8080 && ! ping_ok $BOT 10.77.0.3 && ok "on: a Bot still can't reach the Mac's own LAN address" || bad "on: a Bot still can't reach the Mac's own LAN address"
R curl -sf -m 3 -o /dev/null "http://host.docker.internal:$MP/" && ok "on: root reaches a Mac listener (control)" || bad "on: root reaches a Mac listener (control)"
for a in host.orb.internal host.docker.internal 0.250.250.254 "[fd07:b51a:cc66:f0::fe]"; do
  ! http_ok $BOT "$a:$MP" && ! http_ok box "$a:$MP" && ok "on: a Bot still can't reach the Mac ($a)" || bad "on: a Bot still can't reach the Mac ($a)"
done
! ping_ok $BOT 0.250.250.254 && ok "on: a Bot still can't ping the Mac" || bad "on: a Bot still can't ping the Mac"
R sh -c 'nft list chain inet bots_mac_guard bots | grep -q "@boxnet4 goto deny" && nft list set inet bots_mac_guard lan4 | grep -q 198.18.0.0/15 && nft list set inet bots_mac_guard lan4 | grep -q 169.254.0.0/16' \
  && ok "on: OrbStack's machines and link-local stay blocked (rule)" || bad "on: OrbStack's machines and link-local stay blocked (rule)"
# OrbStack's machine network (192.168.139.0/24 today) is inside 192.168/16: its router answers root's ping, never a Bot's.
GW="$(R ip -o -4 route show default | awk '{print $3; exit}')"
ping_ok 0 "$GW" && ! ping_ok $BOT "$GW" && ! http_ok $BOT "$GW:$MP" && ok "on: a Bot can't reach OrbStack's machine network ($GW)" || bad "on: a Bot can't reach OrbStack's machine network ($GW)"
as_uid $BOT getent hosts example.com >/dev/null && ok "on: a Bot still resolves names (DNS)" || bad "on: a Bot still resolves names (DNS)"
R runuser -u bothost -- sudo -n /usr/local/lib/bots/bots-ports check && ok "on: the host confirms the firewall (bots-ports check)" || bad "on: bots-ports check"
# A connection a Bot opened while it was on is cut when it goes off (TCP 9000 logs each line that arrives).
R rm -f /run/synlan-tcp.log
as_uid $BOT bash -c 'exec 3<>/dev/tcp/10.77.0.2/9000; echo before >&3; sleep 5; echo after >&3; sleep 1; echo later >&3' >/dev/null 2>&1 &
HOLD=$!
sleep 2
[ "$(R /usr/local/lib/bots/bots-ports local-network off 2>/dev/null)" = off ] && ok "Local network turns off live" || bad "Local network turns off live"
wait "$HOLD" 2>/dev/null
R grep -qx before /run/synlan-tcp.log && ! R grep -qx after /run/synlan-tcp.log && ok "off: a Bot's open LAN connection is cut" || bad "off: a Bot's open LAN connection is cut"
lan_blocked "off again"
R runuser -u bothost -- sudo -n /usr/local/lib/bots/bots-ports check && ok "off again: the host confirms the firewall" || bad "off again: bots-ports check"
# The app's tamper check reads loaded + configured state; root flipping it behind the app shows, and the app's re-apply
# (`local-network off`) closes it again.
st() { R /usr/local/lib/bots/bots-ports local-network state 2>/dev/null; }
[ "$(st)" = "off off" ] && ok "state reads loaded and configured (off off)" || bad "state reads loaded and configured (got '$(st)')"
R sh -c 'sed -i s/^LAN_BLOCK=on$/LAN_BLOCK=off/ /etc/bots/net-guard.conf && /usr/local/lib/bots/bots-ports load' >/dev/null 2>&1
[ "$(st)" = "on on" ] && http_ok $BOT 10.77.0.2:8080 && ok "tamper (root turned it on) shows in state" || bad "tamper shows in state (got '$(st)')"
[ "$(R /usr/local/lib/bots/bots-ports local-network off 2>/dev/null)" = off ] && [ "$(st)" = "off off" ] && ! http_ok $BOT 10.77.0.2:8080 \
  && ok "the app's re-apply closes it again" || bad "the app's re-apply closes it again"
# Fail closed: a turn-on whose reload fails goes back to blocking and reads back off.
out="$(R env NFT=/bin/false /usr/local/lib/bots/bots-ports local-network on 2>/dev/null)"; st=$?
[ "$st" != 0 ] && [ "$out" = off ] && [ "$(lanflag)" = off ] && R grep -qx LAN_BLOCK=on /etc/bots/net-guard.conf && ! http_ok $BOT 10.77.0.2:8080 \
  && ok "a failed turn-on reads back off and stays blocked" || bad "a failed turn-on reads back off and stays blocked (exit $st, '$out')"
# Configured blocked but loaded open (a reload that never happened): check refuses, so the host pauses the Bots.
R sh -c 'sed -i s/^LAN_BLOCK=on$/LAN_BLOCK=off/ /etc/bots/net-guard.conf && /usr/local/lib/bots/bots-ports load && sed -i s/^LAN_BLOCK=off$/LAN_BLOCK=on/ /etc/bots/net-guard.conf'
! R runuser -u bothost -- sudo -n /usr/local/lib/bots/bots-ports check && ok "check refuses a guard that doesn't match the config" || bad "check refuses a guard that doesn't match the config"
R /usr/local/lib/bots/bots-ports load >/dev/null 2>&1
R runuser -u bothost -- sudo -n /usr/local/lib/bots/bots-ports check && ok "check passes again once reloaded" || bad "check passes again once reloaded"
kill "$MPID" 2>/dev/null; wait "$MPID" 2>/dev/null
R sh -c 'kill $(cat /run/synlan.pid) 2>/dev/null; ip netns pids synlan | xargs -r kill; ip netns del synlan; ip link del synlan0 2>/dev/null; rm -f /run/synlan*'
after="$(info "$REAL" 2>/dev/null || echo none)"
[ "$before" = "$after" ] && ok "real box untouched ($REAL)" || bad "real box changed: $before -> $after"
exit $fail
