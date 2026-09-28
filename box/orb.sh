# shellcheck shell=bash
# Sourced by every box script that calls orb. Resolves the OrbStack CLI once, best first:
# OrbStack.app's own CLI (in /Applications or ~/Applications), then /usr/local/bin/orb (can be a dangling
# symlink into an ejected installer DMG), Homebrew's, OrbStack's per-user bin, then orb on PATH. The app
# passes ORB (app/src/main/orb-path.ts, same list, same order).
if [ -z "${ORB:-}" ]; then
  for _orb in /Applications/OrbStack.app/Contents/MacOS/bin/orb $HOME/Applications/OrbStack.app/Contents/MacOS/bin/orb /usr/local/bin/orb /opt/homebrew/bin/orb $HOME/.orbstack/bin/orb; do
    if [ -x "$_orb" ] && [ -f "$_orb" ]; then ORB="$_orb"; break; fi
  done
  unset _orb
  ORB="${ORB:-orb}"
fi
export ORB
# Portable install: the OrbStack machine the scripts work on. The app always passes it (a new install's
# machine is "synapse-box"; a Mac that already had "box" keeps it). A hand run defaults to "box".
BOX_MACHINE="${BOX_MACHINE:-box}"
export BOX_MACHINE
orb() { command "$ORB" "$@"; }
export -f orb
