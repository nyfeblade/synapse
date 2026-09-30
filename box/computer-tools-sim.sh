#!/usr/bin/env bash
# Proves Synapse's provider-neutral computer and browser tools on a THROWAWAY OrbStack machine (unique name, deleted on
# exit), never the owner's `box`: a real X display (Xvfb :7 with a window manager), a real Chromium with CDP, xdotool,
# ffmpeg and tesseract, as on the Bots' computer. It then runs host/test/computer/computer-tools.orb.test.ts on the Mac:
# screenshot, read the screen as text, click and type into a test page in that Chromium, read the result back (from the
# accessibility tree, OCR and a CDP snapshot), and a provider child (ProviderBrain, fake model) doing the same.
# Usage: box/computer-tools-sim.sh     Exits non-zero if the machine can't be set up or any check fails.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
M="synapse-cua-${CUA_SIM_ID:-$$}"
export BOX_MACHINE="$M"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
[ "$M" != "box" ] || exit 2
# KEEP_MACHINE=1 keeps it for a rerun (CUA_SIM_ID=<its number> reuses it); it is still a throwaway machine.
[ "${KEEP_MACHINE:-0}" = 1 ] || trap 'ORB_TIMEOUT=180 orb delete -f "$M" >/dev/null 2>&1' EXIT
ID="${CUA_SIM_ID:-$$}"
CDP=$((19300 + ID % 500))
WEB=$((19900 + ID % 90))
R() { orb -m "$M" -u root "$@"; }

if ! orb list 2>/dev/null | grep -q "^$M "; then
echo "creating $M"
ORB_TIMEOUT=600 orb create -a arm64 --cpus 2 --memory 2048 --disk 8G debian:bookworm "$M" >/tmp/cua-create.$$ 2>&1 || { echo "FAIL create machine: $(tail -3 /tmp/cua-create.$$)"; rm -f /tmp/cua-create.$$; exit 1; }; rm -f /tmp/cua-create.$$
echo "installing Xvfb, a window manager, Chromium, xdotool, ffmpeg, tesseract"
ORB_TIMEOUT=1200 R sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends xvfb openbox chromium xdotool x11-utils ffmpeg tesseract-ocr tesseract-ocr-eng python3 fonts-dejavu-core >/dev/null' || { echo "FAIL install"; exit 1; }
R sh -euc '
  useradd -m -s /bin/bash sim
  install -d -o sim -g sim /home/sim/site
  cat > /home/sim/site/greeter.html <<HTML
<!doctype html><html><head><meta charset="utf-8"><title>Greeter</title>
<style>body{font:28px DejaVu Sans,sans-serif;margin:60px} input{font-size:28px;width:420px} button{font-size:28px} #out{font-size:56px;margin-top:40px}</style></head>
<body><form id="f"><label for="name">Your name</label><br><input id="name" name="name" autocomplete="off"> <button type="submit">Greet me</button></form>
<h1 id="out" role="status"></h1>
<script>document.getElementById("f").addEventListener("submit",(e)=>{e.preventDefault();document.getElementById("out").textContent="Hello, "+document.getElementById("name").value+"!";});</script>
</body></html>
HTML
  chown sim:sim /home/sim/site/greeter.html
' || { echo "FAIL write the test page"; exit 1; }
fi
# Xvfb, the window manager, the page server and Chromium, as `sim` (the display's owner), left running in the machine.
orb -m "$M" -u sim sh -c "pgrep -x Xvfb >/dev/null && exit 0; cd /home/sim && (nohup Xvfb :7 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &) && sleep 1 && (DISPLAY=:7 nohup openbox >/tmp/openbox.log 2>&1 &) && (cd site && nohup python3 -m http.server $WEB --bind 127.0.0.1 >/tmp/web.log 2>&1 &) && sleep 1 && (DISPLAY=:7 nohup chromium --no-sandbox --disable-gpu --no-first-run --no-default-browser-check --password-store=basic --user-data-dir=/home/sim/cr --remote-debugging-port=$CDP --window-position=0,0 --window-size=1280,800 about:blank >/tmp/chromium.log 2>&1 &)" || { echo "FAIL start the display"; exit 1; }
for i in $(seq 1 60); do curl -fs "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "http://127.0.0.1:$CDP/json/version" >/dev/null || { echo "FAIL Chromium's CDP isn't reachable from the Mac on 127.0.0.1:$CDP"; R tail -5 /tmp/chromium.log; exit 1; }
echo "PASS throwaway machine $M: display :7, Chromium CDP on $CDP, test page on 127.0.0.1:$WEB"
cd "$HERE/.." && CUA_SIM_HOME="$HOME" CUA_SIM_MACHINE="$M" CUA_SIM_CDP="$CDP" CUA_SIM_PAGE="http://127.0.0.1:$WEB/greeter.html" ORB="$ORB" npx vitest run --reporter verbose host/test/computer/computer-tools.orb.test.ts
