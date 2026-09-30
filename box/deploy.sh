#!/usr/bin/env bash
# Streams the built host into /opt/bothost/app in the isolated box (no shared folders).
# Inside Synapse.app (Contents/Resources/box) it streams the prebuilt host-dist.tgz that
# app/scripts/package.mjs bundled: no npm, no repo. From the repo it builds host/dist first.
# Portable install: the machine is $BOX_MACHINE (orb.sh).
set -euo pipefail
export COPYFILE_DISABLE=1  # no macOS AppleDouble ._* files in the stream (they changed the image version)
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
if [ -f "$HERE/host-dist.tgz" ]; then
  host_stream() { cat "$HERE/host-dist.tgz"; }
else
  ROOT="$(cd "$HERE/.." && pwd)"
  (cd "$ROOT" && npm run build -w @synapse/host)
  host_stream() { tar -C "$ROOT/host/dist" -czf - .; }
fi
BIND="127.0.0.1"
if [ -f "$HERE/route.env" ]; then BIND="$(grep -E '^HOST_BIND=' "$HERE/route.env" | cut -d= -f2)"; fi
echo "::step 1/3 copying the Bots' software"
# Bounded like every orb call (orb.sh, bug 435): 15 min covers a cold npm install.
host_stream | ORB_TIMEOUT=900 orb -m "$BOX_MACHINE" -u root sh -c '
  set -e
  rm -rf /opt/bothost/app.new && mkdir -p /opt/bothost/app.new
  tar -xzf - -C /opt/bothost/app.new
  echo "::step 2/3 installing its packages"
  if [ -f /opt/bothost/app/package.json ] && cmp -s /opt/bothost/app/package.json /opt/bothost/app.new/package.json && [ -d /opt/bothost/app/node_modules ]; then
    cp -a /opt/bothost/app/node_modules /opt/bothost/app.new/
  else
    cd /opt/bothost/app.new
    if ! /usr/local/bin/npm install --omit=dev --no-audit --no-fund >/tmp/bothost-npm.log 2>&1; then
      echo "npm install failed:" >&2; tail -n 30 /tmp/bothost-npm.log >&2; exit 1
    fi
  fi
  chown -R bothost:bothost /opt/bothost/app.new
  rm -rf /opt/bothost/app.old
  if [ -d /opt/bothost/app ]; then mv /opt/bothost/app /opt/bothost/app.old; fi
  mv /opt/bothost/app.new /opt/bothost/app
'
# HOST_BIND goes in its own drop-in: /etc/bothost.env holds the host's other switches, which a deploy
# must never wipe.
printf '[Service]\nEnvironment=HOST_BIND=%s\nEnvironment=WEBHOOK_HOST=%s.orb.local\n' "$BIND" "$BOX_MACHINE" | ORB_TIMEOUT=60 orb -m "$BOX_MACHINE" -u root sh -c \
  'install -d -m 0755 /etc/systemd/system/bothost.service.d && cat > /etc/systemd/system/bothost.service.d/10-bind.conf && systemctl daemon-reload'
# Two accounts on one Mac: this Mac user's own ports (orb.sh). A box that was on another account's ports moves here.
box_apply_ports
echo "::step 3/3 starting the Bots' software"
ORB_TIMEOUT=180 orb -m "$BOX_MACHINE" -u root systemctl restart bothost
"$HERE/check-gateway.sh"
