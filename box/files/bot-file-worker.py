# Root-owned (0644), run by bot-file as a Bot's own uid with an empty environment: the file tools (Read, Write, Edit)
# of a Bot on a model provider (spec 2026-09-29 §3). One JSON request on stdin, one JSON answer on stdout.
# The same protocol and rules as host/tools/builtin/file-local.ts (the same-uid fallback); the two are tested against
# the same cases (host/test/tools/builtin/file-tools.test.ts, box/bot-file-sim.sh).
#
#   {"op": "read",  "path": P, "offset"?: n, "limit"?: n}
#       -> {"ok": true, "kind": "text", "text": "<numbered lines>", "lines": n, "total": n, "sha": h, "cut"?: true}
#        | {"ok": true, "kind": "image", "mime": m, "data": "<base64>", "sha": h}
#   {"op": "write", "path": P, "content": s, "expect": h | null}  -> {"ok": true, "sha": h, "created": bool}
#   {"op": "edit",  "path": P, "old": s, "new": s, "all": bool, "expect": h | null}  -> {"ok": true, "sha": h, "count": n}
#   any failure -> {"ok": false, "error": "<why>"}
#
# Walls: the kernel's, first (this runs as the Bot: another Bot's 0700 home, the host's 0700 private folder and root
# files are closed to it whatever path or link is used). On top, every path is absolute and its REAL path (all links
# resolved) must not be inside another Bot's home, the host's private folder, the managed skills tree, or /proc, /sys
# and /dev. `expect` is the sha256 of the file when the Bot last read or wrote it: an existing file is only written or
# edited when it matches (the CLI's "read it first, and it hasn't changed since" rule).
import base64, hashlib, json, os, signal, stat, sys, tempfile

signal.alarm(30)
HOME = sys.argv[1]
BOTS = sys.argv[2] if len(sys.argv) > 2 else "/home/bots"
DENY = [p for p in sys.argv[3].split(":") if p] if len(sys.argv) > 3 else []
MAX_TEXT = 256 * 1024
MAX_IMAGE = 5 * 1024 * 1024
MAX_WRITE = 10 * 1024 * 1024
DEFAULT_LIMIT = 2000
LINE_MAX = 2000
IMAGES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
ALWAYS_DENY = ["/proc", "/sys", "/dev", "/home/box/.host", "/var/lib/bots/cc-managed"]
# box/bot-file-sim.sh only (a root shell running the worker directly; the bot-file wrapper never passes it): no path
# rules at all, to prove the kernel alone keeps a Bot out. It can only lower this process's own rules, never its uid.
if len(sys.argv) > 4 and sys.argv[4] == "--kernel-only":
    ALWAYS_DENY = []


def out(o):
    sys.stdout.write(json.dumps(o, separators=(",", ":")))
    sys.exit(0)


def fail(msg):
    out({"ok": False, "error": msg})


def under(p, root):
    return p == root or p.startswith(root.rstrip("/") + "/")


def check_real(real):
    for d in ALWAYS_DENY + DENY:
        if under(real, d):
            fail("That path is off limits.")
    if under(real, BOTS) and not under(real, HOME):
        fail("That path is another Bot's.")


def resolve(p):
    if not isinstance(p, str) or not p.startswith("/") or "\0" in p or len(p) > 4096:
        fail("file_path must be an absolute path.")
    real = os.path.realpath(p)
    check_real(real)
    return real


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_bytes(real, cap):
    fd = os.open(real, os.O_RDONLY | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        if stat.S_ISDIR(s.st_mode):
            fail("That is a folder, not a file.")
        if not stat.S_ISREG(s.st_mode):
            fail("That is not a regular file.")
        data = os.read(fd, cap + 1)
        while len(data) <= cap:
            more = os.read(fd, cap + 1 - len(data))
            if not more:
                break
            data += more
        return data
    finally:
        os.close(fd)


def do_read(req):
    real = resolve(req.get("path"))
    ext = os.path.splitext(real)[1].lower()
    try:
        if ext in IMAGES:
            data = read_bytes(real, MAX_IMAGE)
            if len(data) > MAX_IMAGE:
                fail("The image is larger than 5 MB.")
            out({"ok": True, "kind": "image", "mime": IMAGES[ext], "data": base64.b64encode(data).decode("ascii"), "sha": sha(data)})
        data = read_bytes(real, MAX_TEXT)
    except FileNotFoundError:
        fail("File does not exist.")
    except PermissionError:
        fail("Permission denied.")
    except IsADirectoryError:
        fail("That is a folder, not a file.")
    cut = len(data) > MAX_TEXT
    if cut:
        data = data[:MAX_TEXT]
    text = data.decode("utf-8", errors="replace")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    offset = max(1, int(req.get("offset") or 1))
    limit = max(1, min(int(req.get("limit") or DEFAULT_LIMIT), DEFAULT_LIMIT))
    chosen = lines[offset - 1:offset - 1 + limit]
    body = "\n".join("%6d\t%s" % (offset + i, (l[:LINE_MAX] + "…") if len(l) > LINE_MAX else l) for i, l in enumerate(chosen))
    res = {"ok": True, "kind": "text", "text": body, "lines": len(chosen), "total": len(lines), "sha": sha(data if not cut else read_sha(real))}
    if cut or offset - 1 + limit < len(lines):
        res["cut"] = True
    out(res)


def read_sha(real):
    h = hashlib.sha256()
    with open(real, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def current(real):
    try:
        with open(real, "rb") as f:
            return f.read(MAX_WRITE + 1)
    except FileNotFoundError:
        return None
    except IsADirectoryError:
        fail("That is a folder, not a file.")
    except PermissionError:
        fail("Permission denied.")


def write_atomic(real, data):
    d = os.path.dirname(real)
    try:
        os.makedirs(d, exist_ok=True)
    except PermissionError:
        fail("Permission denied.")
    check_real(os.path.realpath(d))  # a folder made along the way can't lead out either
    mode = None
    try:
        mode = stat.S_IMODE(os.stat(real).st_mode)
    except FileNotFoundError:
        pass
    try:
        fd, tmp = tempfile.mkstemp(prefix=".bot-file-", dir=d)
    except PermissionError:
        fail("Permission denied.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode if mode is not None else 0o664)
        os.rename(tmp, real)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def guard_expect(req, before):
    if before is None:
        return
    exp = req.get("expect")
    if not exp:
        fail("File has not been read yet. Read it first before writing to it.")
    if exp != sha(before):
        fail("File has been modified since it was read. Read it again before writing to it.")


def do_write(req):
    real = resolve(req.get("path"))
    content = req.get("content")
    if not isinstance(content, str):
        fail("content must be text.")
    data = content.encode("utf-8")
    if len(data) > MAX_WRITE:
        fail("The content is larger than 10 MB.")
    before = current(real)
    guard_expect(req, before)
    write_atomic(real, data)
    out({"ok": True, "sha": sha(data), "created": before is None})


def do_edit(req):
    real = resolve(req.get("path"))
    old, new = req.get("old"), req.get("new")
    if not isinstance(old, str) or not isinstance(new, str):
        fail("old_string and new_string must be text.")
    if old == new:
        fail("old_string and new_string are the same.")
    before = current(real)
    if before is None:
        if old == "":
            data = new.encode("utf-8")
            write_atomic(real, data)
            out({"ok": True, "sha": sha(data), "count": 1})
        fail("File does not exist.")
    guard_expect(req, before)
    text = before.decode("utf-8", errors="strict")
    n = text.count(old) if old else 0
    if n == 0:
        fail("old_string was not found in the file.")
    if n > 1 and not req.get("all"):
        fail("old_string appears %d times. Give more context to make it unique, or set replace_all." % n)
    after = text.replace(old, new) if req.get("all") else text.replace(old, new, 1)
    data = after.encode("utf-8")
    write_atomic(real, data)
    out({"ok": True, "sha": sha(data), "count": n if req.get("all") else 1})


os.umask(0o002)
raw = sys.stdin.buffer.read(MAX_WRITE * 2 + 1)
if len(raw) > MAX_WRITE * 2:
    fail("request too large")
try:
    req = json.loads(raw)
except Exception:
    fail("bad request")
op = req.get("op") if isinstance(req, dict) else None
try:
    if op == "read":
        do_read(req)
    elif op == "write":
        do_write(req)
    elif op == "edit":
        do_edit(req)
    else:
        fail("bad op")
except UnicodeDecodeError:
    fail("The file is not UTF-8 text.")
except PermissionError:
    fail("Permission denied.")
except OSError as e:
    fail("The file couldn't be used (%s)." % (e.strerror or "error"))
