#!/usr/bin/env bash
# Phase 3 spike S3 (docs/superpowers/plans/2026-09-19-phase-3-computer.md Task 1).
# Usage: box/spike-p3.sh [--check-only]   (--check-only runs the checks without installing anything)
set -uo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-full}"
OUT="$ROOT/box/desktop.env"
PKGS="xvfb xfwm4 picom plank thunar xfce4-terminal x11vnc chromium xdotool ffmpeg imagemagick fonts-noto zstd rsync sqlite3 xauth dbus-x11 x11-utils python3"

inner() {
cat <<'INNER'
set -uo pipefail
MODE="$1"; PKGS="$2"
res() { echo "RESULT $1=$2"; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+ — $2}"; }
if [ "$MODE" = full ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $PKGS >/tmp/spike-apt.log 2>&1 \
    && pass "S3-01 packages" || { fail "S3-01 packages" "see /tmp/spike-apt.log"; exit 1; }
else
  for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 || { fail "S3-01 packages" "missing $p"; exit 1; }; done; pass "S3-01 packages"
fi
N=9; D=":$N"; CDP=$((9222+N))
install -d -o box -g bots -m 0750 /run/bot-x
install -d -o bothost -g bothost -m 0700 /run/bothost-vnc
COOKIE=/run/bot-x/$N.xauth
rm -f "$COOKIE"; touch "$COOKIE"; chown box:bots "$COOKIE"; chmod 0640 "$COOKIE"
runuser -u box -- xauth -f "$COOKIE" add "$D" . "$(mcookie)"
# xauth add (run as box) atomically rewrites the file and resets it to box:box 0600, clobbering
# the box:bots 0640 set above — the group-read bit must be re-applied AFTER xauth writes the cookie.
chown box:bots "$COOKIE"; chmod 0640 "$COOKIE"
runuser -u box -- sh -c "Xvfb $D -screen 0 1280x800x24 -nolisten tcp -auth $COOKIE >/tmp/spike-xvfb.log 2>&1 &"
sleep 1.5
runuser -u box -- env DISPLAY=$D XAUTHORITY=$COOKIE sh -c 'xfwm4 >/tmp/spike-xfwm4.log 2>&1 & picom >/dev/null 2>&1 & plank >/dev/null 2>&1 &'
sleep 1.5
# NOTE: `cmd | grep -q PAT` under `set -o pipefail` is racy — when grep matches it exits early and
# the upstream writer can get SIGPIPE, which pipefail then reports as pipeline failure even though
# grep matched. Capture output into a variable first so grep never races a live writer.
XDPY="$(runuser -u box -- env DISPLAY=$D XAUTHORITY=$COOKIE xdpyinfo 2>/dev/null)"
printf '%s' "$XDPY" | grep '1280x800 pixels' >/dev/null && pass "S3-02 Xvfb+xfwm4 as box" || fail "S3-02 Xvfb+xfwm4 as box"
# S3-03: bothost drives and captures a display owned by box, through the group-readable cookie
XDOT="$(runuser -u bothost -- env DISPLAY=$D XAUTHORITY=$COOKIE xdotool mousemove 100 120 getmouselocation 2>/dev/null)"
if printf '%s' "$XDOT" | grep 'x:100 y:120' >/dev/null; then pass "S3-03a xdotool as bothost"; else fail "S3-03a xdotool as bothost"; fi
CAPTURE=none
# NOTE: ffmpeg reads stdin by default (for interactive 'q'-to-quit); since this whole script is itself
# piped in on the remote bash's stdin, an unguarded ffmpeg steals bytes from the rest of the script.
# -nostdin (and </dev/null belt-and-braces) stops it from doing that.
if runuser -u bothost -- env DISPLAY=$D XAUTHORITY=$COOKIE ffmpeg -nostdin -loglevel error -f x11grab -video_size 1280x800 -i $D -frames:v 1 -c:v libwebp -f webp -y /tmp/spike-shot.webp </dev/null 2>/tmp/spike-ffmpeg.log \
   && head -c 12 /tmp/spike-shot.webp | tail -c 4 | grep -q WEBP; then CAPTURE=ffmpeg; pass "S3-03b capture ffmpeg webp";
elif runuser -u bothost -- env DISPLAY=$D XAUTHORITY=$COOKIE sh -c 'import -window root png:- | convert png:- -quality 80 webp:/tmp/spike-shot.webp' \
   && head -c 12 /tmp/spike-shot.webp | tail -c 4 | grep -q WEBP; then CAPTURE=import; pass "S3-03b capture import webp";
else fail "S3-03b capture"; fi
res CAPTURE "$CAPTURE"
# S3-04: Chromium as box with CDP on loopback; sandbox first
SANDBOX=on
start_chromium() {
  runuser -u box -- env DISPLAY=$D XAUTHORITY=$COOKIE HOME=/home/box sh -c "chromium $1 --user-data-dir=/tmp/spike-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=$CDP --no-first-run --no-default-browser-check --window-position=0,0 --window-size=1280,800 about:blank >/tmp/spike-chromium.log 2>&1 &"
  for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1
}
if start_chromium ""; then pass "S3-04 chromium sandboxed as box"; else
  pkill -u box -f spike-profile; sleep 1; SANDBOX=off
  start_chromium "--no-sandbox" && pass "S3-04 chromium --no-sandbox (sandbox FAILED)" || fail "S3-04 chromium" "see /tmp/spike-chromium.log"
fi
res CHROMIUM_SANDBOX "$SANDBOX"
# S3-05: bothost drives Chromium over CDP with playwright-core and reads the AX tree
install -d -o bothost -g bothost /tmp/spike-p3
runuser -u bothost -- sh -c 'cd /tmp/spike-p3 && npm init -y >/dev/null && npm i -s playwright-core@1.63 ws@8 >/tmp/spike-npm.log 2>&1'
cat > /tmp/spike-p3/cdp.mjs <<EOF
import { chromium } from "playwright-core";
const b = await chromium.connectOverCDP("http://127.0.0.1:$CDP");
const ctx = b.contexts()[0]; const page = await ctx.newPage();
await page.goto("data:text/html,<h1>Spike</h1><label>Email <input type=email></label><input type=password value=hunter2><button>Continue</button>");
const s = await ctx.newCDPSession(page);
const { nodes } = await s.send("Accessibility.getFullAXTree");
const shot = await s.send("Page.captureScreenshot", { format: "webp" });
console.log(JSON.stringify({ nodes: nodes.length, roles: [...new Set(nodes.map((n) => n.role?.value))].slice(0, 12), webp: shot.data.length > 100 }));
await b.close();
EOF
chown bothost:bothost /tmp/spike-p3/cdp.mjs
CDPOUT="$(runuser -u bothost -- node /tmp/spike-p3/cdp.mjs 2>&1)"; echo "$CDPOUT"
echo "$CDPOUT" | grep '"webp":true' >/dev/null && echo "$CDPOUT" | grep 'textbox' >/dev/null && pass "S3-05 CDP + AX tree as bothost" || fail "S3-05 CDP + AX tree"
# S3-06: x11vnc as bothost on a unix socket (fallback: tcp localhost)
# NOTE: two real bugs vs. the brief's literal flags, found by running this against Debian 12's x11vnc 0.9.16:
# (1) this build's flag is `-unixsock str`, not `-unixsockonly` (which doesn't exist and is a hard parse error).
# (2) MIT-SHM: x11vnc runs as `bothost` while Xvfb's shared-memory segments are owned by `box`; attaching
#     cross-user fails with "BadAccess" even though the X auth cookie is valid (SysV SHM has its own uid-based
#     IPC permissions, separate from X11 auth) — `-noshm` makes x11vnc fall back to plain XGetImage, which works.
VNC=unix
runuser -u bothost -- sh -c "x11vnc -noshm -display $D -auth $COOKIE -unixsock /run/bothost-vnc/$N.sock -shared -forever -nopw -quiet >/tmp/spike-vnc.log 2>&1 &"
sleep 2
if python3 - "$N" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect(f"/run/bothost-vnc/{sys.argv[1]}.sock"); b = s.recv(12); print(b); sys.exit(0 if b.startswith(b"RFB 003.") else 1)
PY
then pass "S3-06 x11vnc unix socket"; else
  VNC=tcp; pkill -u bothost x11vnc; sleep 1
  runuser -u bothost -- sh -c "x11vnc -noshm -display $D -auth $COOKIE -rfbport $((5900+N)) -localhost -shared -forever -nopw -quiet >/tmp/spike-vnc.log 2>&1 &"; sleep 2
  RFBOUT="$(python3 -c "import socket;s=socket.create_connection(('127.0.0.1',$((5900+N))));print(s.recv(12))")"
  printf '%s' "$RFBOUT" | grep RFB >/dev/null && pass "S3-06 x11vnc tcp fallback (unix FAILED)" || fail "S3-06 x11vnc"
fi
res VNC_TRANSPORT "$VNC"
# S3-07 (server half): a ws server as bothost on 127.0.0.1:47809 splicing to x11vnc; the Mac half runs after this script
cat > /tmp/spike-p3/wsvnc.mjs <<EOF
import net from "node:net"; import { WebSocketServer } from "ws";
const wss = new WebSocketServer({ host: "127.0.0.1", port: 47809 });
wss.on("connection", (ws) => {
  const up = "$VNC" === "unix" ? net.connect("/run/bothost-vnc/$N.sock") : net.connect($((5900+N)), "127.0.0.1");
  up.on("data", (d) => ws.send(d)); ws.on("message", (m) => up.write(m)); ws.on("close", () => up.destroy()); up.on("close", () => ws.close());
});
setTimeout(() => process.exit(0), 60_000);
EOF
chown bothost:bothost /tmp/spike-p3/wsvnc.mjs
runuser -u bothost -- sh -c 'cd /tmp/spike-p3 && node wsvnc.mjs >/tmp/spike-ws.log 2>&1 &'
# S3-08: transient unit as box with an EnvironmentFile; the value must not appear in systemctl show
install -d -o bothost -g bothost -m 0700 /home/box/.host/run
printf 'SPIKE_SECRET=s3cr3t-value-123\n' > /home/box/.host/run/spike.env; chown bothost /home/box/.host/run/spike.env; chmod 0600 /home/box/.host/run/spike.env
systemd-run --quiet --unit=spike-shell --uid=box --gid=box -p EnvironmentFile=/home/box/.host/run/spike.env --collect \
  /bin/bash -c 'echo "$SPIKE_SECRET" > /tmp/spike-shell.out; sleep 5'
sleep 1; rm -f /home/box/.host/run/spike.env
SHOW="$(systemctl show spike-shell)"
if grep -x 's3cr3t-value-123' /tmp/spike-shell.out >/dev/null && ! printf '%s' "$SHOW" | grep 's3cr3t-value-123' >/dev/null \
   && [ "$(stat -c %U /tmp/spike-shell.out)" = box ]; then res SHELL_ENV_HIDDEN pass; pass "S3-08 transient unit env hidden"; else res SHELL_ENV_HIDDEN fail; fail "S3-08"; fi
# S3-09: setpriv children stay in the parent unit's cgroup, and sudo doesn't move them (no pam_systemd in sudo's stack)
CG="$(systemd-run --quiet --wait --pipe --unit=spike-cg /bin/sh -c 'setpriv --reuid=box --regid=box --init-groups cat /proc/self/cgroup')"
if echo "$CG" | grep '/system.slice/spike-cg.service' >/dev/null && ! grep -rs pam_systemd /etc/pam.d/sudo /etc/pam.d/common-session-noninteractive >/dev/null; then
  res SETPRIV_SAME_CGROUP pass; pass "S3-09 cgroup"; else res SETPRIV_SAME_CGROUP fail; fail "S3-09 cgroup" "$CG"; fi
# S3-12: SEC-09 shared logins. Two Chromium instances cannot share one user-data-dir (profile lock), so logins must be
# copied between per-screen profiles over CDP. Check: (a) a second instance on the same profile does not open its own CDP
# port; (b) Storage.getCookies on instance A → Storage.setCookies on instance B (its own profile) round-trips a cookie.
SEC_EXTRA=""; [ "$SANDBOX" = off ] && SEC_EXTRA="--no-sandbox"
runuser -u box -- env DISPLAY=$D XAUTHORITY=$COOKIE HOME=/home/box sh -c "chromium $SEC_EXTRA --user-data-dir=/tmp/spike-profile --remote-debugging-port=$((CDP+1)) about:blank >/tmp/spike-chromium2.log 2>&1 &"
sleep 4
if curl -fs "http://127.0.0.1:$((CDP+1))/json/version" >/dev/null 2>&1; then res PROFILE_SHARED_LIVE yes; else res PROFILE_SHARED_LIVE no; fi
runuser -u box -- env DISPLAY=$D XAUTHORITY=$COOKIE HOME=/home/box sh -c "chromium $SEC_EXTRA --user-data-dir=/tmp/spike-profile-b --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=$((CDP+2)) about:blank >/tmp/spike-chromium3.log 2>&1 &"
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$((CDP+2))/json/version" >/dev/null 2>&1 && break; sleep 0.5; done
cat > /tmp/spike-p3/cookies.mjs <<EOF
import { chromium } from "playwright-core";
const a = await chromium.connectOverCDP("http://127.0.0.1:$CDP"); const b = await chromium.connectOverCDP("http://127.0.0.1:$((CDP+2))");
const sa = await a.newBrowserCDPSession(); const sb = await b.newBrowserCDPSession();
await sa.send("Storage.setCookies", { cookies: [{ name: "spike", value: "v1", domain: "example.com", path: "/", secure: true, expires: Date.now() / 1000 + 3600 }] });
const { cookies } = await sa.send("Storage.getCookies"); await sb.send("Storage.setCookies", { cookies: cookies.filter((c) => c.name === "spike") });
const got = (await sb.send("Storage.getCookies")).cookies.find((c) => c.name === "spike");
console.log(JSON.stringify({ copied: got?.value === "v1" })); await a.close(); await b.close();
EOF
chown bothost:bothost /tmp/spike-p3/cookies.mjs
COOKIEOUT="$(runuser -u bothost -- node /tmp/spike-p3/cookies.mjs 2>&1)"; echo "$COOKIEOUT" > /tmp/spike-cookies.log
printf '%s' "$COOKIEOUT" | grep '"copied":true' >/dev/null && { res COOKIE_COPY pass; pass "S3-12 CDP cookie copy across profiles"; } || { res COOKIE_COPY fail; fail "S3-12 CDP cookie copy"; }
pkill -u box -f 'spike-profile-b' || true
# S3-10: resources of one screen (all box processes started by this spike)
PER=$(ps -u box -o rss=,args= | grep -E 'Xvfb :9|xfwm4|picom|plank|spike-profile' | awk '{s+=$1} END {print int(s/1024)}')
MEM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
REC=$(( (MEM * 4 / 10) / (PER > 0 ? PER : 1) )); [ "$REC" -gt 12 ] && REC=12
res PER_SCREEN_MB "$PER"; res MAX_SCREENS_RECOMMENDED "$REC"; echo "INFO MemTotal_MB=$MEM nproc=$(nproc)"
# S3-11: wallpaper generation and WebP support in ImageMagick
convert -size 1280x800 gradient:'#f2f2f2-#d2d2d2' /tmp/spike-wall.png && pass "S3-11 wallpaper generation" || fail "S3-11 wallpaper generation"
res CHROMIUM_BIN "$(command -v chromium)"
INNER
}

cleanup() {
  orb -m "$BOX_MACHINE" -u root sh -c 'pkill -u box -f "spike-profile|Xvfb :9|xfwm4|picom|plank" ; pkill -u bothost -f "x11vnc|wsvnc.mjs"; systemctl stop spike-shell 2>/dev/null; rm -rf /tmp/spike-p3 /tmp/spike-profile /run/bot-x/9.xauth /run/bothost-vnc/9.sock' >/dev/null 2>&1 || true
}
trap cleanup EXIT

LOG="$(mktemp)"
inner | orb -m "$BOX_MACHINE" -u root bash -s -- "$MODE" "$PKGS" 2>&1 | tee "$LOG"
# S3-07 (Mac half): the WebSocket upgrade must survive OrbStack's localhost forwarding
WS=fail
if [ "$MODE" = full ] && node -e '
  const ws = new WebSocket("ws://127.0.0.1:47809/"); ws.binaryType = "arraybuffer";
  const t = setTimeout(() => process.exit(1), 8000);
  ws.onmessage = (e) => { const s = Buffer.from(e.data).toString(); console.log("banner", JSON.stringify(s)); clearTimeout(t); process.exit(s.startsWith("RFB 003.") ? 0 : 1); };
  ws.onerror = () => process.exit(1);'; then WS=pass; echo "PASS S3-07 WebSocket over the localhost route"; else echo "FAIL S3-07 WebSocket over the localhost route"; fi
if [ "$MODE" = full ]; then
  { echo "# Written by box/spike-p3.sh on $(date -u +%FT%TZ). Read by provision.sh, DisplayManager and vnc-bridge."
    grep '^RESULT ' "$LOG" | sed 's/^RESULT //'
    echo "WS_OVER_ROUTE=$WS"; } > "$OUT"
  echo "wrote $OUT"
fi
grep -q '^FAIL' "$LOG" && exit 1 || exit 0
