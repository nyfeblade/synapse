#!/usr/bin/env bash
# Streams shared/ + host/ into the isolated box and runs the given *.box.test.ts files there as bothost with RUN_BOX=1.
# Usage: box/run-box-tests.sh host/test/computer/displays.box.test.ts [...]   (RUN_CLAUDE=1 is passed through)
set -euo pipefail
# shellcheck source=box/orb.sh
source "$(dirname "$0")/orb.sh"  # OrbStack.app's CLI first; /usr/local/bin/orb can dangle into an ejected DMG
export COPYFILE_DISABLE=1  # no macOS AppleDouble ._* files in the stream (they changed the image version)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -gt 0 ] || { echo "usage: $0 <host/test/...box.test.ts>..." >&2; exit 2; }
tar -C "$ROOT" --exclude=node_modules --exclude=dist -czf - package.json tsconfig.base.json shared host | orb -m "$BOX_MACHINE" -u root sh -c '
  set -e; D=/opt/bothost/boxtest; mkdir -p $D; rm -rf $D/shared $D/host; tar -xzf - -C $D
  cd $D && jq ".workspaces = [\"shared\", \"host\"]" package.json > p.json && mv p.json package.json
  printf "export default { test: { projects: [\"shared\", \"host\"] } };\n" > vitest.config.ts
  chown -R bothost:bothost $D'
orb -m "$BOX_MACHINE" -u root runuser -u bothost -- sh -c "cd /opt/bothost/boxtest && npm install --no-audit --no-fund >/tmp/boxtest-npm.log 2>&1 && RUN_BOX=1 RUN_CLAUDE=${RUN_CLAUDE:-} npx vitest run --project host $(printf '%s ' "${@#host/}")"
