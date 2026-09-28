import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeUsers } from "./fake-users";

/** Bug #66 follow-up: with --stdout, shell-runner writes only to the file systemd opened for it, never by name. */
describe("bug #66: shell-runner --stdout", () => {
  let f: FakeUsers;
  beforeEach(() => { f = new FakeUsers(); fs.mkdirSync(f.p("workspace/.bot/terminals"), { recursive: true }); });
  afterEach(() => f.cleanup());

  it("output and footer go to stdout (the private terminal file); the cwd note is a random mktemp file, removed after", () => {
    const id = `shell-t${process.pid}`;
    const script = f.p("s.sh");
    fs.writeFileSync(script, `echo hello; echo oops >&2; printf '%s' /some/cwd > "$BOT_SHELL_CWD_FILE"; echo "$BOT_SHELL_CWD_FILE" > ${f.p("cwdpath")}; exit 3\n`);
    const runner = f.install("shell-runner");
    const out = f.p("term.txt");
    fs.writeFileSync(out, "---\nheader\n---\n");
    const fd = fs.openSync(out, "a");
    const r = spawnSync("/bin/bash", [runner, id, script, "--stdout"], { stdio: ["ignore", fd, "pipe"], env: { PATH: `${f.p("shim")}:/usr/bin:/bin`, SHIM_LOG: f.p("calls.log") } });
    fs.closeSync(fd);
    expect(r.status).toBe(0);
    const text = fs.readFileSync(out, "utf8");
    expect(text).toMatch(/^---\nheader\n---\nhello\noops\n\n---\nexit_code: 3\nelapsed_ms: \d+\nended_at: \d+\ncwd: \/some\/cwd\n---\n$/);
    const note = fs.readFileSync(f.p("cwdpath"), "utf8").trim();
    expect(path.basename(note)).not.toContain(id); // random (mktemp), not a name another uid could plant
    expect(fs.existsSync(note)).toBe(false);
    expect(fs.readdirSync(f.p("workspace/.bot/terminals"))).toEqual([]);
  });
});
