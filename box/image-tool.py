#!/usr/bin/env python3
"""Ready-made Bots' computer (box/build-image.sh). Two filters over an OrbStack export (a tar, decompressed):

  seal         stdin -> stdout. Rewrites OrbStack's own record (_orbstack/v1/config.json) so the image carries no id,
               name or time of the build machine: a neutral name, a zero id, a fixed export time. Every other byte of
               the tar passes through untouched.
  leak-check PATTERNS
               reads the image on stdin. PATTERNS has one per line: "t:<text>" or "x:<hex>" (build secrets and ids,
               none may be found) and "c:<text>" (controls, each must be found, proving the scan saw the image).
               Prints only counts, never a pattern. Exit 1 on a leak, 4 when a control is missing.
"""
import json
import sys

CONFIG = "_orbstack/v1/config.json"
BLOCK = 512


def octal(n, width):
    return (("%0" + str(width - 1) + "o") % n).encode() + b"\0"


def pax_records(data):
    out, i = {}, 0
    while i < len(data):
        sp = data.index(b" ", i)
        n = int(data[i:sp])
        k, _, v = data[sp + 1:i + n - 1].partition(b"=")
        out[k.decode()] = v.decode(errors="replace")
        i += n
    return out


def seal():
    src, dst = sys.stdin.buffer, sys.stdout.buffer
    pending = b""  # a pax header waiting for the entry it describes
    pax = {}
    while True:
        hdr = src.read(BLOCK)
        if len(hdr) < BLOCK:
            sys.exit("seal: the export ended before OrbStack's record")
        if hdr == b"\0" * BLOCK:
            sys.exit("seal: no OrbStack record in the export")
        name = hdr[0:100].rstrip(b"\0").decode()
        prefix = hdr[345:500].rstrip(b"\0").decode() if hdr[257:262] == b"ustar" else ""
        typ = hdr[156:157]
        size = int(hdr[124:136].rstrip(b"\0 ").decode() or "0", 8)
        body = src.read((size + BLOCK - 1) // BLOCK * BLOCK)
        if typ == b"x":
            pending, pax = hdr + body, pax_records(body[:size])
            continue
        if typ in (b"g", b"L", b"K"):
            sys.exit("seal: GNU or global tar headers before OrbStack's record are not expected")
        full = pax.get("path") or ((prefix + "/" + name) if prefix else name)
        if "size" in pax and int(pax["size"]) != size:
            sys.exit("seal: a large entry before OrbStack's record is not expected")
        if full.lstrip("./") == CONFIG:
            cfg = json.loads(body[:size])
            rec = cfg.get("record", {})
            rec["id"] = "0" * 26
            rec["name"] = "synapse-box"
            rec["state"] = "stopped"
            cfg["record"] = rec
            cfg["exported_at"] = "2026-01-01T00:00:00Z"
            data = json.dumps(cfg, separators=(",", ":")).encode()
            h = bytearray(hdr)
            h[124:136] = octal(len(data), 12)
            h[136:148] = octal(0, 12)  # mtime
            h[148:156] = b" " * 8
            h[148:156] = ("%06o" % sum(h)).encode() + b"\0 "
            # Its pax header (times) is dropped with the old record.
            dst.write(bytes(h))
            dst.write(data + b"\0" * ((BLOCK - len(data) % BLOCK) % BLOCK))
            break
        dst.write(pending + hdr + body)
        pending, pax = b"", {}
    while True:
        chunk = src.read(8 << 20)
        if not chunk:
            break
        dst.write(chunk)
    dst.flush()


def leak_check(path):
    pats, controls = [], []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        kind, _, val = line.partition(":")
        if not val:
            continue
        if kind == "t":
            pats.append(("text", val.encode()))
        elif kind == "x":
            pats.append(("bytes", bytes.fromhex(val)))
        elif kind == "c":
            controls.append(val.encode())
    if not pats or not controls:
        sys.exit("leak-check: needs patterns and at least one control")
    keep = max(len(p) for p in [p for _, p in pats] + controls) - 1
    found, seen = {}, set()
    tail = b""
    src = sys.stdin.buffer
    total = 0
    while True:
        chunk = src.read(8 << 20)
        if not chunk:
            break
        total += len(chunk)
        buf = tail + chunk
        for i, (kind, p) in enumerate(pats):
            if i not in found and buf.find(p) >= 0:
                found[i] = kind
        for i, c in enumerate(controls):
            if i not in seen and buf.find(c) >= 0:
                seen.add(i)
        tail = buf[-keep:]
    if found:
        print(f"leak-check: LEAK: {len(found)} of {len(pats)} build secrets/ids found ({', '.join(sorted(set(found.values())))})")
        sys.exit(1)
    if len(seen) != len(controls):
        print(f"leak-check: only {len(seen)} of {len(controls)} controls found; the scan did not see the image")
        sys.exit(4)
    print(f"leak-check: none of {len(pats)} build secrets/ids in {total} bytes ({len(controls)} controls found)")


if __name__ == "__main__":
    if sys.argv[1:2] == ["seal"]:
        seal()
    elif sys.argv[1:2] == ["leak-check"] and len(sys.argv) == 3:
        leak_check(sys.argv[2])
    else:
        sys.exit("usage: image-tool.py seal | leak-check PATTERNS")
