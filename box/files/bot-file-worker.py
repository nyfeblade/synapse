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
#   {"op": "glob",  "path": P, "pattern": g}  -> {"ok": true, "kind": "paths", "paths": [...], "cut"?: true}
#   {"op": "grep",  "path": P, "pattern": re, "glob"?: g, "mode"?: "files"|"content"|"count", "ignoreCase"?: bool,
#                   "context"?: n, "limit"?: n}  -> {"ok": true, "kind": "grep", "text": s, "matches": n, "files": n, "cut"?: true}
#   any failure -> {"ok": false, "error": "<why>"}
#
# glob and grep (the Glob and Grep tools) walk a folder as the Bot: a link is never followed into a folder, a linked file
# counts only when its real path passes the walls below, ".git" is skipped, and "node_modules" unless the pattern names
# it. The glob syntax, the limits and the answer text are the same as host/walls/bot-file.ts (tested against both).
#
# Walls: the kernel's, first (this runs as the Bot: another Bot's 0700 home, the host's 0700 private folder and root
# files are closed to it whatever path or link is used). On top, every path is absolute and its REAL path (all links
# resolved) must not be inside another Bot's home, the host's private folder, the managed skills tree, or /proc, /sys
# and /dev. `expect` is the sha256 of the file when the Bot last read or wrote it: an existing file is only written or
# edited when it matches (the CLI's "read it first, and it hasn't changed since" rule).
import base64, hashlib, json, os, re, signal, stat, sys, tempfile

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


# ---- glob and grep (host/walls/bot-file.ts SEARCH_LIMITS and globRegex: keep the two the same) ----
WALK_MAX = 50000
GLOB_MAX = 1000
GREP_FILE_BYTES = 2 * 1024 * 1024
OUTPUT_MAX = 64 * 1024
MATCH_LINE_MAX = 500
CONTEXT_MAX = 10
CONTENT_LIMIT = 250
FILES_LIMIT = 1000
LIMIT_MAX = 5000
RE_SPECIAL = set("\\^$.|?*+()[]{}/")


def escape_re(s):
    return "".join("\\" + c if c in RE_SPECIAL else c for c in s)


def glob_regex(pattern):
    out = ""
    i = 0
    n = len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*" and pattern[i + 1:i + 2] == "*":
            if pattern[i + 2:i + 3] == "/":
                out += "(?:.*/)?"
                i += 3
            else:
                out += ".*"
                i += 2
            continue
        if c == "*":
            out += "[^/]*"
            i += 1
            continue
        if c == "?":
            out += "[^/]"
            i += 1
            continue
        if c == "{":
            end = pattern.find("}", i)
            if end > i:
                out += "(?:" + "|".join(escape_re(x) for x in pattern[i + 1:end].split(",")) + ")"
                i = end + 1
                continue
        if c == "[":
            end = pattern.find("]", i + 2)
            if end > i:
                body = pattern[i + 1:end]
                out += "[" + ("^" + body[1:] if body.startswith("!") else body) + "]"
                i = end + 1
                continue
        out += escape_re(c)
        i += 1
    return re.compile("^" + out + "$", re.S)


def walls_ok(real):
    for d in ALWAYS_DENY + DENY:
        if under(real, d):
            return False
    # The folder of all homes may be walked through (to reach the Bot's own); another Bot's home never.
    return not (under(real, BOTS) and real != BOTS.rstrip("/") and not under(real, HOME))


def walk(given, real, node_modules):
    files = []
    stack = [(given, real, "")]
    seen = 0
    while stack:
        d, dreal, rel = stack.pop()
        try:
            names = sorted(os.listdir(dreal))
        except OSError:
            continue
        sub = []
        for name in names:
            seen += 1
            if seen > WALK_MAX:
                return files, True
            if name == ".git" or (name == "node_modules" and not node_modules):
                continue
            p = os.path.join(dreal, name)
            r = p
            try:
                st = os.lstat(p)
                if stat.S_ISLNK(st.st_mode):
                    r = os.path.realpath(p)
                    st = os.stat(r)
                    if not stat.S_ISREG(st.st_mode):
                        continue
            except OSError:
                continue
            if not walls_ok(r):
                continue
            reln = rel + "/" + name if rel else name
            if stat.S_ISDIR(st.st_mode):
                sub.append((os.path.join(d, name), p, reln))
            elif stat.S_ISREG(st.st_mode):
                files.append({"abs": os.path.join(d, name), "rel": reln, "real": r, "mtime": st.st_mtime_ns / 1e6, "size": st.st_size})
        for x in reversed(sub):
            stack.append(x)
    return files, False


def search_root(p):
    # A search may start at the folder of all homes itself (it walks through to the Bot's own); anything else is walled
    # exactly as for Read.
    if isinstance(p, str) and p.startswith("/") and "\0" not in p and os.path.realpath(p) == BOTS.rstrip("/"):
        real = os.path.realpath(p)
    else:
        real = resolve(p)
    try:
        st = os.stat(real)
    except OSError:
        fail("Path does not exist.")
    return os.path.normpath(p), real, st


def newest_first(f):
    return (-f["mtime"], f["rel"])


def do_glob(req):
    given, real, st = search_root(req.get("path"))
    if not stat.S_ISDIR(st.st_mode):
        fail("path must be a folder.")
    pat = req.get("pattern") if isinstance(req.get("pattern"), str) else ""
    if pat.startswith("/"):
        if not pat.startswith(given + "/"):
            fail("pattern must be relative to path.")
        pat = pat[len(given) + 1:]
    while pat.startswith("./"):
        pat = pat[2:]
    if not pat or len(pat) > 1000:
        fail("pattern is required.")
    rx = glob_regex(pat)
    files, cut = walk(given, real, "node_modules" in pat)
    hits = sorted([f for f in files if rx.match(f["rel"])], key=newest_first)
    res = {"ok": True, "kind": "paths", "paths": [h["abs"] for h in hits[:GLOB_MAX]]}
    if cut or len(hits) > GLOB_MAX:
        res["cut"] = True
    out(res)


def as_int(v, default):
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return default
    return n or default


def do_grep(req):
    given, real, st = search_root(req.get("path"))
    pattern = req.get("pattern")
    if not isinstance(pattern, str) or not pattern or len(pattern) > 1000:
        fail("pattern is required.")
    try:
        rx = re.compile(pattern, re.I if req.get("ignoreCase") else 0)
    except re.error:
        fail("Invalid regular expression: " + pattern)
    mode = req.get("mode") if req.get("mode") in ("content", "count") else "files"
    ctx = max(0, min(as_int(req.get("context"), 0), CONTEXT_MAX))
    limit = max(1, min(as_int(req.get("limit"), CONTENT_LIMIT if mode == "content" else FILES_LIMIT), LIMIT_MAX))
    g = req.get("glob") if isinstance(req.get("glob"), str) and req.get("glob") else None
    cut = False
    if stat.S_ISDIR(st.st_mode):
        files, cut = walk(given, real, "node_modules" in (g or ""))
        grx = glob_regex(g) if g else None
        files = sorted([f for f in files if not grx or grx.match(f["rel"] if "/" in g else f["rel"].rsplit("/", 1)[-1])], key=lambda f: f["rel"])
    elif stat.S_ISREG(st.st_mode):
        files = [{"abs": given, "rel": os.path.basename(given), "real": real, "mtime": st.st_mtime_ns / 1e6, "size": st.st_size}]
    else:
        fail("That is not a regular file.")
    lines_out = []
    state = {"bytes": 0, "cut": cut}

    def emit(line):
        if len(lines_out) >= limit or state["bytes"] + len(line) + 1 > OUTPUT_MAX:
            state["cut"] = True
            return False
        lines_out.append(line)
        state["bytes"] += len(line) + 1
        return True

    def clip(l):
        return l[:MATCH_LINE_MAX] + "…" if len(l) > MATCH_LINE_MAX else l

    matches = 0
    hit_files = []
    for f in files:
        if f["size"] > GREP_FILE_BYTES:
            continue
        try:
            with open(f["real"], "rb") as fh:
                data = fh.read(GREP_FILE_BYTES + 1)
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue
        lines = data.decode("utf-8", errors="replace").split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        hit = [i for i, l in enumerate(lines) if rx.search(l)]
        if not hit:
            continue
        matches += len(hit)
        hit_files.append((f, len(hit)))
        if mode != "content" or state["cut"]:
            continue
        show = set()
        for i in hit:
            for j in range(max(0, i - ctx), min(len(lines) - 1, i + ctx) + 1):
                show.add(j)
        is_hit = set(hit)
        prev = -2
        for j in sorted(show):
            if ctx > 0 and prev != -2 and j != prev + 1 and not emit("--"):
                break
            if ctx > 0 and prev == -2 and lines_out and not emit("--"):
                break
            sep = ":" if j in is_hit else "-"
            if not emit(f["abs"] + sep + str(j + 1) + sep + clip(lines[j])):
                break
            prev = j
    if mode == "files":
        for f in sorted([h[0] for h in hit_files], key=newest_first):
            if not emit(f["abs"]):
                break
    elif mode == "count":
        for f, n in hit_files:
            if not emit(f["abs"] + ":" + str(n)):
                break
    res = {"ok": True, "kind": "grep", "text": "\n".join(lines_out), "matches": matches, "files": len(hit_files)}
    if state["cut"]:
        res["cut"] = True
    out(res)


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
    elif op == "glob":
        do_glob(req)
    elif op == "grep":
        do_grep(req)
    else:
        fail("bad op")
except UnicodeDecodeError:
    fail("The file is not UTF-8 text.")
except PermissionError:
    fail("Permission denied.")
except OSError as e:
    fail("The file couldn't be used (%s)." % (e.strerror or "error"))
