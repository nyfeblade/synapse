#!/usr/bin/env bash
# Ready-made Bots' computer (0.1.5): builds the prebuilt image a new install downloads instead of provisioning from
# scratch (docs/superpowers/specs/2026-09-29-ready-made-box-design.md). On a throwaway OrbStack machine it runs the
# real provision, deploy and verify-box, strips every per-install secret and id (image-prep.sh strip), exports the
# machine, seals OrbStack's record (image-tool.py seal: no build id, name or time), recompresses it, proves the result
# holds nothing of the build machine's (its token, keys, machine id, OrbStack id, name, addresses), and writes the
# manifest the app pins (<out-dir>/image.json: version, SHA-256, size, URL). It never uploads anything. A release uploads
# the image as the manifest's URL says, then copies image.json into box/ (it ships in the signed app) and commits it.
# Usage: box/build-image.sh [out-dir]   (default: <repo>/.box-image, git-ignored)
#   KEEP_MACHINE=1 keeps the build machine; ZSTD_LEVEL (default 19) trades build time for download size.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../.box-image}"
# A uid whose ports no real account on this Mac uses (orb.sh: 47900 + 124*10), so the build never takes the owner's.
export SYNAPSE_UID="${SYNAPSE_UID:-626}"
export BOX_MACHINE="synapse-imgbuild-$$"
export COPYFILE_DISABLE=1
M="$BOX_MACHINE"
# shellcheck source=box/orb.sh
source "$HERE/orb.sh"
LOG="$(mktemp -d)"
cleanup() {
  [ "${KEEP_MACHINE:-0}" = 1 ] || ORB_TIMEOUT=180 orb delete -f "$M" >/dev/null 2>&1 || true
  rm -rf "$LOG"
}
trap cleanup EXIT
mkdir -p "$OUT"
say() { echo "build-image: $*"; }
t() { date +%s; }

# The same recipe as provision.sh's /etc/bots/image-version and the app's bundledImageVersion.
# shellcheck disable=SC2046
VERSION="$(cd "$HERE" && cat provision.sh desktop.env $(find files -type f ! -name '._*' | LC_ALL=C sort) | shasum -a 256 | cut -c1-16)"
free_kb="$(df -k "$OUT" | awk 'NR==2 {print $4}')"
[ "$free_kb" -gt $((12 * 1024 * 1024)) ] || { say "needs 12 GB free next to $OUT"; exit 1; }

T0=$(t)
say "creating $M"
# Every orb call is bounded (orb.sh, bug 435: a stuck orb is killed); the long ones get limits sized like the app's.
ORB_TIMEOUT=1200 orb create --isolated -a arm64 --cpus 2 --memory 4096 --disk 64G -u synapse-admin debian:bookworm "$M" >"$LOG/create" 2>&1 || { cat "$LOG/create"; exit 1; }
orb -m "$M" -u root sh -c 'install -d -m 0755 /etc/bots && date -u +%FT%TZ > /etc/bots/created-by-synapse'
say "provisioning"
bash "$HERE/provision-from-mac.sh" >"$LOG/prov" 2>&1 || { tail -30 "$LOG/prov"; exit 1; }
T1=$(t)
say "deploying the host"
bash "$HERE/deploy.sh" >"$LOG/deploy" 2>&1 || { tail -30 "$LOG/deploy"; exit 1; }
HOST_BUILD="$(orb -m "$M" -u root cat /opt/bothost/app/build-id.txt)"
say "verifying"
bash "$HERE/verify-box.sh" >"$LOG/verify" 2>&1 || { grep -E '^(FAIL|SKIP)' "$LOG/verify"; exit 1; }
T2=$(t)
[ "$(orb -m "$M" -u root cat /etc/bots/image-version)" = "$VERSION" ] || { say "image version mismatch"; exit 1; }

# What this build machine made that must not ship, read into a file only this user can read and never printed:
# every value in gateway.json, every token-like string in the host's small files, its binary keys (hex), the machine
# id, and OrbStack's id, name and addresses for the machine.
umask 077
orb -m "$M" -u root python3 - >"$LOG/pats" <<'EOF'
import glob, json, os, re
out = set()
try:
    for k, v in json.load(open("/home/box/.host/gateway.json")).items():
        if isinstance(v, str) and len(v) >= 16:
            out.add("t:" + v)
except Exception:
    pass
for f in glob.glob("/home/box/.host/**/*", recursive=True):
    if not os.path.isfile(f) or os.path.getsize(f) >= 4096:
        continue
    b = open(f, "rb").read()
    toks = re.findall(rb"[A-Za-z0-9_+/=-]{24,}", b)
    for m in toks:
        out.add("t:" + m.decode())
    if not toks and 16 <= len(b) <= 256 and not b.isascii():
        out.add("x:" + b.hex())
out.add("t:" + open("/etc/machine-id").read().strip())
print("\n".join(sorted(out)))
EOF
orb info "$M" -f json | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("record",d); [print("t:"+str(x)) for x in (r.get("id"), r.get("name"), d.get("ip4"), d.get("ip6")) if x]' >>"$LOG/pats"
# Controls: strings that ARE in every image, so a scan that saw nothing can't pass.
printf 'c:%s\nc:bothost:x:\n' "$VERSION" >>"$LOG/pats"
umask 022
say "$(grep -c '^[tx]:' "$LOG/pats") build secrets and ids to look for"

say "stripping per-install data"
ORB_TIMEOUT=300 orb -m "$M" -u root bash -s strip <"$HERE/image-prep.sh"
FILE="$OUT/synapse-box-$VERSION-arm64.tar.zst"
RAW="$OUT/.export-$$.tar.zst"
rm -f "$FILE" "$RAW"
# Exported running: OrbStack pauses it, so a shutdown writes nothing new (no random seed, no journal).
say "exporting"
T3=$(t)
ORB_TIMEOUT=1800 orb export "$M" "$RAW" >"$LOG/export" 2>&1 || { cat "$LOG/export"; rm -f "$RAW"; exit 1; }
T4=$(t)
say "sealing and compressing (zstd -${ZSTD_LEVEL:-19})"
zstd -dcq "$RAW" | python3 "$HERE/image-tool.py" seal | zstd -q -T0 "-${ZSTD_LEVEL:-19}" -o "$FILE"
rm -f "$RAW"
T5=$(t)

say "checking the image for build secrets"
zstd -dcq "$FILE" | python3 "$HERE/image-tool.py" leak-check "$LOG/pats" || { rm -f "$FILE"; exit 1; }
# Files (not folders) under the per-install trees.
if zstd -dcq "$FILE" | tar -tvf - | awk '$1 !~ /^d/ {print $9}' | grep -E '^(\./)?rootfs/(home/box/\.host/|etc/ssh/ssh_host_.*_key$|home/box/\.claude\.json$|home/bots/.|home/box/chrome-profile/.|home/box/agent-data/|var/lib/bothost/.|var/log/journal/.)' | head -5 | grep .; then
  say "LEAK: per-install files in the image"; rm -f "$FILE"; exit 1
fi

SHA="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"
BYTES="$(stat -f %z "$FILE")"
UNPACKED="$(zstd -dcq "$FILE" | wc -c | tr -d ' ')"
cat >"$OUT/image.json" <<EOF
{
  "format": 1,
  "imageVersion": "$VERSION",
  "hostBuild": "$HOST_BUILD",
  "arch": "arm64",
  "url": "https://github.com/nyfeblade/synapse/releases/download/box-$VERSION/$(basename "$FILE")",
  "sha256": "$SHA",
  "bytes": $BYTES,
  "unpackedBytes": $UNPACKED
}
EOF
say "done: $FILE (manifest: $OUT/image.json)"
say "size $BYTES bytes (unpacked $UNPACKED), sha256 $SHA"
say "timings: provision $((T1 - T0)) s, deploy+verify $((T2 - T1)) s, export $((T4 - T3)) s, seal+compress $((T5 - T4)) s"
