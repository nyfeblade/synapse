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
# Bug 435: every orb call is bounded. OrbStack 2.2.3's agent now and then leaves a finished command unreaped (seen
# within minutes of the box host restarting) and the orb client then waits forever. ORB_TIMEOUT (seconds, default 120)
# sets the limit per call: `ORB_TIMEOUT=3600 orb ...` for a long one. On timeout orb gets TERM, then KILL (a stuck orb
# ignores TERM, and a bare alarm; only KILL ends it: seen live on a throwaway machine), and the call
# exits 124 with "OrbStack didn't answer" on stderr (the app's setup error keys on it). ORB_TIMEOUT_MARK, when set,
# names a file each timeout appends a line to (verify-box uses it so a negated check can't pass on a hang).
# perl is on every Mac (no modules loaded: ~3 ms a call); its fork/wait adds no polling to the normal path. stdin passes through (tar | orb ...).
orb() {
  perl -e '
    my ($t, $mark) = (shift, shift);
    my $pid = fork; defined $pid or die "orb: fork: $!\n";
    # Its own process group (not from a terminal: job control needs the terminal group), so the kill reaches all of it.
    my $g = -t STDIN ? 0 : 1;
    if (!$pid) { setpgrp(0, 0) if $g; exec { $ARGV[0] } @ARGV; print STDERR "orb: $ARGV[0]: $!\n"; exit 127 }
    my $who = $g ? -$pid : $pid;
    for my $s (qw(TERM INT HUP)) { $SIG{$s} = sub { kill $s, $who } }
    my $ok = eval { local $SIG{ALRM} = sub { die "t\n" }; alarm $t; my $w; do { $w = waitpid($pid, 0) } until $w == $pid || $w == -1; alarm 0; 1 };
    if (!$ok) {
      kill "TERM", $who;
      for (1 .. 15) { last if waitpid($pid, 1) == $pid; select(undef, undef, undef, 0.1) }
      kill "KILL", $who; waitpid($pid, 0);
      my @a = @ARGV[1 .. ($#ARGV < 5 ? $#ARGV : 5)];
      print STDERR "OrbStack didn\x27t answer within $t s (orb @a)\n";
      if ($mark ne "" && open(my $f, ">>", $mark)) { print $f "@a\n"; close $f }
      exit 124;
    }
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "${ORB_TIMEOUT:-120}" "${ORB_TIMEOUT_MARK:-}" "$ORB" "$@"
}
export -f orb
# Two macOS accounts on one Mac: each account's OrbStack forwards its machine's ports to the Mac's shared 127.0.0.1,
# so each Mac user gets their own (shared/src/user-ports.ts computes the same numbers; a test keeps them in step).
# uid 501 keeps 47800-47802 (every existing single-user install); any other uid gets 47900 + ((uid-502) mod 125)*10.
# The app passes them; a hand run computes them from the uid running it.
_synapse_uid="${SYNAPSE_UID:-$(id -u)}"
if [ "$_synapse_uid" = 501 ]; then _synapse_base=47800; else _synapse_base=$(( 47900 + (((_synapse_uid - 502) % 125 + 125) % 125) * 10 )); fi
SYNAPSE_GATEWAY_PORT="${SYNAPSE_GATEWAY_PORT:-$_synapse_base}"
SYNAPSE_WEBHOOK_PORT="${SYNAPSE_WEBHOOK_PORT:-$((_synapse_base + 1))}"
SYNAPSE_AUTH_PROXY_PORT="${SYNAPSE_AUTH_PROXY_PORT:-$((_synapse_base + 2))}"
unset _synapse_uid _synapse_base
export SYNAPSE_GATEWAY_PORT SYNAPSE_WEBHOOK_PORT SYNAPSE_AUTH_PROXY_PORT
# The in-box step (as root) is box/files/bots-ports (`apply`): it loads the auth proxy's firewall rule for the new port
# first, then writes the host's ports drop-in. Provision installs the same script for every boot (`load`).
SYNAPSE_BOX_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SYNAPSE_BOX_SCRIPTS
box_ports_script() { cat "$SYNAPSE_BOX_SCRIPTS/files/bots-ports"; }
# Bug 364: the streamed script is installed first (the boot service and the host's `check` run the installed copy), then run.
box_apply_ports() {
  box_ports_script | orb -m "$BOX_MACHINE" -u root sh -c 'install -d -m 0755 /usr/local/lib/bots && cat > /usr/local/lib/bots/bots-ports.new && chmod 0755 /usr/local/lib/bots/bots-ports.new && mv /usr/local/lib/bots/bots-ports.new /usr/local/lib/bots/bots-ports'
  # Bug 365: the Mac's own networks (SYNAPSE_MAC_NETS, from the app) go in when the app passed them, even empty.
  orb -m "$BOX_MACHINE" -u root /usr/local/lib/bots/bots-ports apply "$SYNAPSE_GATEWAY_PORT" "$SYNAPSE_WEBHOOK_PORT" "$SYNAPSE_AUTH_PROXY_PORT" ${SYNAPSE_MAC_NETS+"$SYNAPSE_MAC_NETS"}
}
export -f box_ports_script box_apply_ports
# The /hello proof (host/gateway/server.ts): HMAC-SHA256(key = $TOKEN, "synapse-hello:" + nonce), hex. Built from plain
# SHA-256 (RFC 2104) so the key never goes into a process's arguments (check-gateway.sh runs on the Mac, where another
# account can read them with ps): only shell builtins touch the key; openssl gets the padded key and data on stdin.
synapse_hello_hmac() {
  local nonce="$1" key="$TOKEN" khex="" c i b ipad="" opad=""
  if [ "${#key}" -gt 64 ]; then
    khex="$(printf '%s' "$key" | openssl dgst -sha256 | awk '{print $NF}')"
  else
    for ((i = 0; i < ${#key}; i++)); do
      printf -v c '%02x' "'${key:i:1}"
      khex="$khex$c"
    done
  fi
  while [ "${#khex}" -lt 128 ]; do khex="${khex}00"; done
  for ((i = 0; i < 128; i += 2)); do
    b=$((16#${khex:i:2}))
    printf -v c '\\x%02x' $((b ^ 0x36)); ipad="$ipad$c"
    printf -v c '\\x%02x' $((b ^ 0x5c)); opad="$opad$c"
  done
  # shellcheck disable=SC2059
  { printf "$opad"; { printf "$ipad"; printf 'synapse-hello:%s' "$nonce"; } | openssl dgst -sha256 -binary; } | openssl dgst -sha256 | awk '{print $NF}'
}
export -f synapse_hello_hmac
