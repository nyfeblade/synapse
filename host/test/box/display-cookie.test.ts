import fs from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { Sandbox } from "./sandbox";

// Final secfix round 3 (ruling 1) made /run/bot-x root:bots 0750, so `box` can no longer create files there.
// `xauth add` needs to create its two working files next to the cookie (`<f>-c` and `<f>-l`, the lock link), so
// running it as box in that directory now fails with "timeout in locking authority file" and bot-display@N never
// starts. display-cookie must therefore mint the cookie as root (the directory is root-owned and the cookie path
// is checked not to be a symlink, so nothing box-controlled is followed) and hand it to box:bots 0640 afterwards.
let sbx: Sandbox | null = null;
afterEach(() => { sbx?.cleanup(); sbx = null; });

function sandboxWithRootOnlyRunDir(): Sandbox {
  const s = new Sandbox();
  sbx = s;
  fs.mkdirSync(s.p("run", "bot-x"), { recursive: true });
  const log = `_l=$(printf '%s\\t%s\\t%s' "\${FAKE_UID:-0}" "$(basename "$0")" "$PWD"; for a in "$@"; do printf '\\t%s' "$a"; done); printf '%s\\n' "$_l" >> "$SHIM_LOG"`;
  const w = (name: string, body: string) => {
    fs.writeFileSync(`${s.shim}/${name}`, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(`${s.shim}/${name}`, 0o755);
  };
  // `runuser -u box -- …` drops to box: the command runs with box's rights, which on the box exclude writing in
  // /run/bot-x. Emulated with a sandbox-exec profile that denies writes there, exactly like Sandbox's setpriv shim.
  const prof = `(version 1)(allow default)(deny file-write* (subpath "${s.p("run", "bot-x")}"))`;
  w("runuser", `${log}
while [ $# -gt 0 ]; do case "$1" in -u) shift ;; --) shift; break ;; -*) ;; *) break ;; esac; shift; done
exec /usr/bin/sandbox-exec -p '${prof}' /usr/bin/env FAKE_UID=1001 "$@"`);
  // xauth, with its real locking behavior: it creates <file>-c and hard-links it to <file>-l before rewriting the
  // cookie file, so it needs write permission on the containing directory, not just on the file.
  w("xauth", `${log}
f=""
while [ $# -gt 0 ]; do case "$1" in -f) shift; f="$1" ;; esac; shift; done
[ -n "$f" ] || exit 2
if ! ( : > "$f-c" && /bin/ln "$f-c" "$f-l" ) 2>/dev/null; then
  /bin/rm -f "$f-c" "$f-l" 2>/dev/null
  echo "xauth:  timeout in locking authority file $f" >&2; exit 1
fi
/bin/rm -f "$f-c" "$f-l"
printf 'MIT-MAGIC-COOKIE-1\\n' > "$f"`);
  w("mcookie", `${log}\necho 78f8ef968542251956df908ba3e3fecc`);
  return s;
}

describe("display-cookie (root-owned; /run/bot-x is root:bots 0750)", () => {
  it("mints the cookie even though box cannot write in /run/bot-x, and leaves it box:bots 0640", () => {
    const s = sandboxWithRootOnlyRunDir();
    const r = s.run("display-cookie", ["1"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(/locking authority file/);
    const cookie = s.p("run", "bot-x", "1.xauth");
    expect(fs.readFileSync(cookie, "utf8")).toMatch(/MIT-MAGIC-COOKIE-1/);
    expect(fs.statSync(cookie).mode & 0o777).toBe(0o640);
    const chown = r.log.filter((e) => e.cmd === "chown" && e.args.includes(cookie));
    expect(chown.map((e) => e.args[0])).toContain("box:bots");
    expect(chown.at(-1)?.args[0], "the cookie is handed to box AFTER it is written").toBe("box:bots");
  });

  it("never runs xauth as box, and leaves no lock leftovers", () => {
    const s = sandboxWithRootOnlyRunDir();
    const r = s.run("display-cookie", ["2"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const xauth = r.log.filter((e) => e.cmd === "xauth");
    expect(xauth.length).toBe(1);
    expect(xauth[0]!.uid, "xauth must run as root, not as box").toBe(0);
    expect(r.log.some((e) => e.cmd === "runuser")).toBe(false);
    expect(fs.readdirSync(s.p("run", "bot-x")).sort()).toEqual(["2.xauth"]);
  });

  it("still refuses a symlinked cookie path", () => {
    const s = sandboxWithRootOnlyRunDir();
    fs.symlinkSync(s.p("etc", "shadow"), s.p("run", "bot-x", "3.xauth"));
    const r = s.run("display-cookie", ["3"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/symlink/);
    expect(fs.readFileSync(s.p("etc", "shadow"), "utf8")).toBe("root:SECRET-HASH\n");
  });

  it("refuses a non-numeric display index", () => {
    const s = sandboxWithRootOnlyRunDir();
    expect(s.run("display-cookie", ["1;rm -rf /"]).status).toBe(2);
    expect(s.run("display-cookie", [""]).status).toBe(2);
  });
});
