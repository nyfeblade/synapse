#!/usr/bin/env python3
# Live perception (decisions.md 2026-09-21): dump this display's AT-SPI tree as compact JSON for the host.
# Runs as box through /usr/local/libexec/bot-atspi (box owns the display's accessibility bus). Read-only:
# it never calls an action, only reads roles, names, values, states and screen extents of showing objects.
# Output: {"windows": [{"app", "pid", "i", "title", "role", "active", "popup", "b": [x,y,w,h], "els": [...]}]}
import json
import signal
import sys

signal.alarm(7)

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as e:  # AT-SPI is not installed: the host falls back to a cropped screenshot
    print(json.dumps({"windows": [], "error": "atspi unavailable: %s" % e}))
    sys.exit(0)

MAX_ELS = 400
MAX_DEPTH = 40
MAX_CHILDREN = 200
SKIP_APPS = {"plank", "xfwm4", "xfce4-panel", "xfdesktop", "picom"}
KEEP = {
    "push button", "toggle button", "menu item", "check menu item", "radio menu item", "check box", "radio button",
    "combo box", "list item", "table cell", "column header", "row header", "page tab", "spin button", "text",
    "password text", "entry", "link", "slider", "tree item", "label", "heading", "alert", "dialog", "icon", "image",
    "canvas", "drawing area", "menu", "status bar", "notification",
}
TEXT_ROLES = {"label", "heading", "status bar", "notification"}

try:
    Atspi.set_timeout(800, 3000)
except Exception:
    pass


def states(o):
    try:
        return [Atspi.StateType(s).value_nick.replace("-", " ") for s in o.get_state_set().get_states()]
    except Exception:
        return []


def extents(o):
    try:
        r = o.get_extents(Atspi.CoordType.SCREEN)
        return [r.x, r.y, r.width, r.height]
    except Exception:
        return [0, 0, 0, 0]


def name_of(o):
    try:
        n = (o.get_name() or "").strip()
        if n:
            return n
        for rel in o.get_relation_set() or []:
            if rel.get_relation_type() == Atspi.RelationType.LABELLED_BY and rel.get_n_targets():
                return (rel.get_target(0).get_name() or "").strip()
    except Exception:
        pass
    return ""


def value_of(o, role):
    if role not in ("text", "entry", "password text", "spin button", "combo box", "slider"):
        return None
    try:
        if role in ("spin button", "slider"):
            v = o.get_value()
            return None if v is None else str(v.get_current_value())
        t = o.get_text()
        if t is not None:
            return t.get_text(0, min(t.get_character_count(), 200))
    except Exception:
        pass
    return None


def walk(o, path, depth, out, meta):
    if depth > MAX_DEPTH or len(out) >= MAX_ELS:
        return
    try:
        n = min(o.get_child_count(), MAX_CHILDREN)
    except Exception:
        return
    for i in range(n):
        if len(out) >= MAX_ELS:
            return
        try:
            c = o.get_child_at_index(i)
        except Exception:
            continue
        if c is None:
            continue
        st = states(c)
        if "showing" not in st and "visible" not in st:
            continue
        try:
            role = c.get_role_name()
        except Exception:
            continue
        key = "%s.%d" % (path, i) if path else str(i)
        if role == "file chooser":
            meta["chooser"] = True
        if role in KEEP:
            name = name_of(c)
            b = extents(c)
            if b[2] > 0 and b[3] > 0 and (role not in TEXT_ROLES or name):
                e = {"k": key, "role": role, "name": name[:120], "states": st, "b": b}
                v = value_of(c, role)
                if v:
                    e["value"] = "[redacted]" if role == "password text" else v
                out.append(e)
        walk(c, key, depth + 1, out, meta)


def main():
    desktop = Atspi.get_desktop(0)
    wins = []
    for ai in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(ai)
            aname = (app.get_name() or "").strip()
            pid = app.get_process_id()
        except Exception:
            continue
        if not aname or aname.lower() in SKIP_APPS:
            continue
        for wi in range(min(app.get_child_count(), 30)):
            try:
                w = app.get_child_at_index(wi)
                st = states(w)
                role = w.get_role_name()
            except Exception:
                continue
            if "showing" not in st and "visible" not in st:
                continue
            els, meta = [], {}
            walk(w, str(wi), 0, els, meta)
            title = name_of(w)
            popup = role in ("menu", "popup menu", "window", "tool tip") and not title and any(e["role"].endswith("menu item") for e in els)
            wins.append({
                "app": aname, "pid": pid, "i": wi, "title": title, "role": "file chooser" if meta.get("chooser") else role,
                "active": "active" in st, "popup": popup, "b": extents(w), "els": els,
            })
    print(json.dumps({"windows": wins}, separators=(",", ":")))


try:
    main()
except Exception as e:
    print(json.dumps({"windows": [], "error": str(e)[:200]}))
