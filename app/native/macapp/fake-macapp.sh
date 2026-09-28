#!/usr/bin/env bash
# FUZZ=1 stand-in for bots-mac: no Accessibility, Automation or Apple-event prompts, deterministic
# replies. Same JSON-lines protocol — one object in, exactly one object out, always echoing `id`.
# The Python goes through -c, not a heredoc: a heredoc would take the stdin the requests arrive on.
set -uo pipefail
for a in "$@"; do
  case "$a" in
    --prompt-accessibility) echo '{"ok":true,"accessibility":true}'; exit 0 ;;
    --perms) echo '{"id":0,"ok":true,"perms":{"accessibility":"granted","contacts":"granted","calendars":"granted","reminders":"granted","automation":{"Messages":"granted","Finder":"granted"}}}'; exit 0 ;;
  esac
done
FAKE_PY=$(cat <<'PY'
import json, sys

def nodes(acted):
    return [
        {"ref": "e1", "role": "button", "name": "Send", "depth": 1, "y": 120, "h": 24,
         "interactive": True, **({"disabled": True} if acted else {})},
        {"ref": "e2", "role": "textbox", "name": "Message", "depth": 1, "y": 80, "h": 32,
         "interactive": True, "value": "hello" if acted else ""},
        {"ref": "e3", "role": "text", "name": "Fake Window", "depth": 0, "y": 0, "h": 18,
         "interactive": False},
    ]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        out = {"id": 0, "ok": False, "error": "That line was not a JSON object.", "code": "badrequest"}
        print(json.dumps(out), flush=True)
        continue
    rid, op, act = req.get("id", 0), req.get("op"), req.get("action", "outline")
    if op == "ping":
        out = {"id": rid, "ok": True, "pong": True}
    elif op == "perms":
        apps = req.get("apps") or ["Finder"]
        out = {"id": rid, "ok": True, "perms": {
            "accessibility": "granted", "contacts": "granted", "calendars": "granted",
            "reminders": "granted", "automation": {a: "granted" for a in apps}}}
    elif op == "osa":
        out = {"id": rid, "ok": True, "result": "{\"fake\":true}"}
    elif op == "ax" and act in ("outline", "press", "set", "menu", "key", "focus"):
        out = {"id": rid, "ok": True, "app": req.get("app") or "Fake App", "window": "Untitled",
               "vh": 900, "nodes": nodes(act != "outline")}
    else:
        out = {"id": rid, "ok": False, "error": "%s is not something this helper knows." % (op or act),
               "code": "badrequest"}
    print(json.dumps(out), flush=True)
PY
)
exec /usr/bin/python3 -c "$FAKE_PY"
