#!/usr/bin/env bash
# Proves box/files/bot-file's walls on a THROWAWAY OrbStack machine (unique name, deleted on exit), never the owner's
# `box`: two Bot accounts made the way bot-user makes them (reserved uids, GECOS "synapse-bot <id>", 0700 homes under
# /home/bots), bothost with the one sudoers line, and the host's 0700 private folder. Each wall is checked twice: through
# the helper (kernel + path rules) and with the worker's path rules switched off (the kernel alone).
# Usage: box/bot-file-sim.sh      Prints PASS/FAIL per check; exits non-zero if any fails.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
M="synapse-botfile-$$"
export BOX_MACHINE="$M"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
[ "$M" != "box" ] || exit 2
trap 'orb delete -f "$M" >/dev/null 2>&1' EXIT
fail=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
R() { orb -m "$M" -u root "$@"; }

orb create -a arm64 --cpus 1 --memory 1024 --disk 4G debian:bookworm "$M" >/dev/null 2>&1 || { echo "FAIL create machine"; exit 1; }
R sh -c 'DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y python3 sudo >/dev/null' >/dev/null 2>&1 || { echo "FAIL install python3 and sudo"; exit 1; }
R sh -c 'cat > /tmp/bot-file' < "$HERE/files/bot-file" && R sh -c 'cat > /tmp/bot-file-worker.py' < "$HERE/files/bot-file-worker.py" || { echo "FAIL copy helper"; exit 1; }
A_ID=simbota; B_ID=simbotb
A="bot-$(printf %s "$A_ID" | shasum -a 256 | cut -c1-12)"; B="bot-$(printf %s "$B_ID" | shasum -a 256 | cut -c1-12)"
R sh -eu -c "
  install -d -m 0755 /usr/local/libexec /home/bots /home/box
  install -m 0755 -o root -g root /tmp/bot-file /usr/local/libexec/bot-file
  install -m 0644 -o root -g root /tmp/bot-file-worker.py /usr/local/libexec/bot-file-worker.py
  useradd --system -M -d /var/lib/bothost -s /usr/sbin/nologin bothost
  useradd -m -d /home/box -s /bin/bash box 2>/dev/null || true
  install -d -m 0700 -o bothost /home/box/.host && echo HOST-SECRET > /home/box/.host/vault.key && chown bothost /home/box/.host/vault.key && chmod 600 /home/box/.host/vault.key
  chmod 0711 /home/box
  groupadd -g 60201 $A && useradd -u 60201 -g 60201 -M -d /home/bots/$A -s /usr/sbin/nologin -c 'synapse-bot $A_ID' $A
  groupadd -g 60202 $B && useradd -u 60202 -g 60202 -M -d /home/bots/$B -s /usr/sbin/nologin -c 'synapse-bot $B_ID' $B
  install -d -m 0700 -o $A -g $A /home/bots/$A && install -d -m 0700 -o $B -g $B /home/bots/$B
  echo B-SECRET > /home/bots/$B/secret.txt && chown $B:$B /home/bots/$B/secret.txt
  echo mine > /home/bots/$A/mine.txt && chown $A:$A /home/bots/$A/mine.txt
  ln -s /home/bots/$B/secret.txt /home/bots/$A/sneaky && ln -s /home/box/.host /home/bots/$A/hostdir && chown -h $A:$A /home/bots/$A/sneaky /home/bots/$A/hostdir
  install -d -m 2775 /workspace && ln -sfn /home/bots/$B /workspace/into-b
  printf 'Defaults!/usr/local/libexec/bot-file env_reset, !use_pty, secure_path=\"/usr/sbin:/usr/bin:/sbin:/bin\"\nbothost ALL=(root) NOPASSWD: /usr/local/libexec/bot-file *\n' > /etc/sudoers.d/bothost && chmod 440 /etc/sudoers.d/bothost
" >/dev/null 2>&1 && ok "throwaway machine $M set up" || { bad "set up"; exit 1; }

# The helper as the host calls it: sudo -n bot-file <account> <botId>, one JSON request.
H() { printf '%s' "$3" | R runuser -u bothost -- sudo -n /usr/local/libexec/bot-file "$1" "$2"; }
# The worker as A with NO path rules (BOTS points nowhere, nothing denied): only the kernel stands in the way.
K() { printf '%s' "$1" | R setpriv --reuid=60201 --regid=60201 --init-groups -- env -i /usr/bin/python3 -I -S /usr/local/libexec/bot-file-worker.py /home/bots/$A /nonexistent "" --kernel-only; }
has() { grep -q "$1"; }
HA=/home/bots/$A; HB=/home/bots/$B

own_read() { H $A $A_ID "{\"op\":\"read\",\"path\":\"$HA/mine.txt\"}" | grep -q 'mine'; }
own_write() { H $A $A_ID "{\"op\":\"write\",\"path\":\"$HA/new/w.txt\",\"content\":\"hi\",\"expect\":null}" | grep -q '"ok":true' && [ "$(R stat -c %u:%g $HA/new/w.txt)" = 60201:60201 ]; }
check "A reads its own file" own_read
check "A writes in its own home, as A" own_write
for req in "{\"op\":\"read\",\"path\":\"$HB/secret.txt\"}" "{\"op\":\"read\",\"path\":\"$HA/sneaky\"}" "{\"op\":\"read\",\"path\":\"$HA/../$B/secret.txt\"}" \
  "{\"op\":\"read\",\"path\":\"$HA/hostdir/vault.key\"}" "{\"op\":\"read\",\"path\":\"/home/box/.host/vault.key\"}" "{\"op\":\"read\",\"path\":\"/workspace/into-b/secret.txt\"}" \
  "{\"op\":\"write\",\"path\":\"$HB/planted\",\"content\":\"x\",\"expect\":null}" "{\"op\":\"write\",\"path\":\"/home/box/.host/planted\",\"content\":\"x\",\"expect\":null}" \
  "{\"op\":\"edit\",\"path\":\"$HA/sneaky\",\"old\":\"B\",\"new\":\"A\",\"all\":false,\"expect\":null}"; do
  short="$(printf '%s' "$req" | sed -E 's#/home/bots/bot-[0-9a-f]+#~#g' | cut -c1-70)"
  out="$(H $A $A_ID "$req" 2>&1)"
  if printf '%s' "$out" | grep -q '"ok":false' && ! printf '%s' "$out" | grep -qE 'B-SECRET|HOST-SECRET'; then ok "helper refuses: $short"; else bad "helper refuses: $short ($out)"; fi
  kout="$(K "$req" 2>&1)"
  if printf '%s' "$kout" | grep -q 'Permission denied' && ! printf '%s' "$kout" | grep -qE 'B-SECRET|HOST-SECRET'; then ok "kernel alone refuses: $short"; else bad "kernel alone refuses: $short ($kout)"; fi
done
R test ! -e $HB/planted && R test ! -e /home/box/.host/planted && ok "nothing was planted" || bad "nothing was planted"
R grep -qx B-SECRET $HB/secret.txt && ok "B's file is untouched" || bad "B's file is untouched"
wrong_id() { ! H $A $B_ID "{\"op\":\"read\",\"path\":\"$HA/mine.txt\"}"; }
not_bot() { ! H box $A_ID '{"op":"read","path":"/etc/hostname"}'; }
not_bothost() { ! R runuser -u box -- sudo -n /usr/local/libexec/bot-file $A $A_ID </dev/null; }
empty_env() { ! R runuser -u bothost -- env SECRET_TOKEN=leak sh -c "printf '%s' '{\"op\":\"read\",\"path\":\"/proc/self/environ\"}' | sudo -n /usr/local/libexec/bot-file $A $A_ID" | grep -q leak; }
check "refused: A's account under B's id" wrong_id
check "refused: not a Bot account" not_bot
check "refused: a caller other than bothost" not_bothost
check "the worker's env is empty (and /proc is refused)" empty_env
R test "$(R stat -c %a $HA)" = 700 && ok "homes stay 0700" || bad "homes stay 0700"
echo "machine $M is deleted on exit"
exit $fail
