#!/usr/bin/env bash
# Proves box/files/bot-acp-install (0.1.6: Settings → Account → Coding CLIs → Install / Remove) on a THROWAWAY OrbStack
# machine (unique name, deleted on exit), never the owner's `box`. The machine gets what provision.sh gives the helper:
# Node at the provision pin, the helper and bot-acp-as-box as root, the pinned package lists, the real sudoers file,
# bothost, and one Bot account made the way bot-user makes it. It installs from the real npm registry (network needed).
# Usage: box/acp-install-sim.sh      Prints PASS/FAIL per check; exits non-zero if any fails.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
M="synapse-acpinst-$$"
export BOX_MACHINE="$M"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
[ "$M" != "box" ] || exit 2
trap '[ -n "${KEEP:-}" ] || orb delete -f "$M" >/dev/null 2>&1' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
R() { ORB_TIMEOUT="${T:-600}" orb -m "$M" -u root "$@"; }
NODE_VERSION="$(sed -n 's/^NODE_VERSION=//p' "$HERE/provision.sh")"; NODE_SHA256="$(sed -n 's/^NODE_SHA256=//p' "$HERE/provision.sh")"

ORB_TIMEOUT=1200 orb create -a arm64 --cpus 2 --memory 2048 --disk 8G debian:bookworm "$M" >/dev/null 2>&1 || { echo "FAIL create machine"; exit 1; }
R sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils sudo jq util-linux >/dev/null' >/dev/null 2>&1 || { echo "FAIL apt"; exit 1; }
R sh -eu -c "curl -fsSL --retry 3 -o /tmp/node.tar.xz https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz && echo '$NODE_SHA256  /tmp/node.tar.xz' | sha256sum -c - && tar -xJ -C /usr/local --strip-components=1 -f /tmp/node.tar.xz && rm /tmp/node.tar.xz" >/dev/null 2>&1 || { echo "FAIL node"; exit 1; }
tar -C "$HERE/files" -czf - bot-acp-install bot-acp-as-box sudoers-bothost acp-pins | R sh -c 'rm -rf /tmp/f && mkdir /tmp/f && tar -xzf - -C /tmp/f' || { echo "FAIL copy"; exit 1; }
A_ID=simbota
A="bot-$(printf %s "$A_ID" | shasum -a 256 | cut -c1-12)"
# The same lines provision.sh runs for these files.
R bash -eu -c "
  install -d -m 0755 /usr/local/libexec
  install -m 0755 -o root -g root /tmp/f/bot-acp-as-box /usr/local/libexec/bot-acp-as-box
  install -m 0755 -o root -g root /tmp/f/bot-acp-install /usr/local/libexec/bot-acp-install
  install -d -m 0755 -o root -g root /usr/local/lib/synapse-acp /usr/local/lib/synapse-acp-pins
  for pins in /tmp/f/acp-pins/*/; do
    v=\"\$(basename \"\$pins\")\"
    install -d -m 0755 -o root -g root \"/usr/local/lib/synapse-acp-pins/\$v\"
    install -m 0644 -o root -g root \"\$pins/package.json\" \"\$pins/package-lock.json\" \"/usr/local/lib/synapse-acp-pins/\$v/\"
  done
  install -m 0440 -o root -g root /tmp/f/sudoers-bothost /etc/sudoers.d/bothost && visudo -cf /etc/sudoers.d/bothost
  useradd --system -M -d /var/lib/bothost -s /usr/sbin/nologin bothost
  install -d -m 0711 -o root -g root /home/bots
  groupadd -g 60201 $A && useradd -u 60201 -g 60201 -M -d /home/bots/$A -s /usr/sbin/nologin -c 'synapse-bot $A_ID' $A
  install -d -m 0700 -o $A -g $A /home/bots/$A
" >/dev/null 2>&1 && ok "throwaway machine $M set up (Node $NODE_VERSION)" || { bad "set up"; exit 1; }

I() { R runuser -u bothost -- sudo -n /usr/local/libexec/bot-acp-install "$@"; }
ASBOT() { R setpriv --reuid=60201 --regid=60201 --init-groups -- "$@"; }
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}'
acp_init() { printf '%s\n' "$INIT" | T=120 R runuser -u bothost -- timeout 60 sudo -n /usr/local/libexec/bot-acp-as-box "$A" "$A_ID" "$1" acp 2>/dev/null | head -c 20000 | grep -q '"protocolVersion"'; }
# Every file and folder root's and writable by no one else (a link's own mode means nothing; it must be root's too).
root_only() {
  local off; off="$(R find "/usr/local/lib/synapse-acp/$1" \( \( ! -type l -perm /022 \) -o ! -user root -o ! -group root \) -print 2>/dev/null | head -3)"
  if [ -z "$off" ] && R test -d "/usr/local/lib/synapse-acp/$1"; then ok "its install ($1) is root-owned and nobody else can write it"; else bad "its install ($1) is root-owned and nobody else can write it ($off)"; fi
}

# Who may run it: only bothost through sudo. A Bot's account can't; root without sudo isn't the host.
not() { ! "$@"; }
check "a Bot account can't run the installer" not ASBOT sudo -n /usr/local/libexec/bot-acp-install copilot install
check "the installer refuses a caller that isn't bothost via sudo" not R /usr/local/libexec/bot-acp-install copilot install
check "no pinned install for Cursor (no published checksum)" not I cursor install
check "an unknown verb is refused" not I copilot upgrade

# A download that doesn't match its published checksum is refused, and nothing is installed: npm refuses a required
# package (EINTEGRITY); npm skips an optional one silently (the platform binary), and the helper then refuses, because
# the launcher's entry is missing.
LOCK=/usr/local/lib/synapse-acp-pins/copilot/package-lock.json
R cp "$LOCK" /tmp/lock.good
for p in @github/copilot @github/copilot-linux-arm64; do
  R sh -c "jq '.packages[\"node_modules/$p\"].integrity = \"sha512-\" + (\"A\" * 86) + \"==\"' /tmp/lock.good > $LOCK"
  out="$(T=900 I copilot install 2>&1)"; code=$?
  why="$([ "$p" = @github/copilot ] && echo EINTEGRITY || echo 'has no node_modules/@github/copilot-linux-arm64/copilot')"
  if [ $code -ne 0 ] && printf '%s' "$out" | grep -q "$why" && ! R test -e /usr/local/lib/synapse-acp/copilot && [ -z "$(R ls -A /usr/local/lib/synapse-acp)" ]; then
    ok "a wrong checksum on $p is refused ($why) and nothing is installed"
  else bad "a wrong checksum on $p is refused ($code: $(printf '%s' "$out" | tail -2))"; fi
done
R cp /tmp/lock.good "$LOCK"

# Copilot: install, root-owned and read-only to others, runs as the Bot over ACP, the Bot can't change it, remove.
out="$(T=900 I copilot install 2>&1)" && ok "GitHub Copilot installs ($(printf '%s' "$out" | tail -1))" || bad "GitHub Copilot installs ($(printf '%s' "$out" | tail -3))"
root_only copilot
check "it records the pinned version and npm's integrity" R jq -e '.version == "1.0.89" and (.integrity | startswith("sha512-"))' /usr/local/lib/synapse-acp/copilot/.installed.json
check "the launcher is a root-owned file, not a link" R sh -c 'f=/usr/local/lib/synapse-acp/copilot/copilot; [ -f $f ] && [ ! -L $f ] && [ $(stat -c %U $f) = root ]'
check "it answers ACP initialize as the Bot's own account (bot-acp-as-box)" acp_init copilot
check "the Bot can't write into the install" not ASBOT touch /usr/local/lib/synapse-acp/copilot/planted
out="$(I copilot remove 2>&1)" && ok "GitHub Copilot removes ($out)" || bad "GitHub Copilot removes ($out)"
check "after Remove it's gone" not R test -e /usr/local/lib/synapse-acp/copilot
out="$(R runuser -u bothost -- sudo -n /usr/local/libexec/bot-acp-as-box "$A" "$A_ID" copilot acp </dev/null 2>&1)"
if printf '%s' "$out" | grep -q "isn't installed"; then ok "after Remove bot-acp-as-box says it isn't installed"; else bad "after Remove bot-acp-as-box says it isn't installed ($out)"; fi

# Kimi Code: same, through Node.
out="$(T=900 I kimi install 2>&1)" && ok "Kimi Code installs ($(printf '%s' "$out" | tail -1))" || bad "Kimi Code installs ($(printf '%s' "$out" | tail -3))"
root_only kimi
check "it answers ACP initialize as the Bot's own account (bot-acp-as-box)" acp_init kimi
out="$(I kimi remove 2>&1)" && ok "Kimi Code removes ($out)" || bad "Kimi Code removes ($out)"
empty_root() { [ -z "$(R ls -A /usr/local/lib/synapse-acp)" ]; }
check "no staging folder is left behind" empty_root

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
