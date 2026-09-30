/**
 * 0.1.4 first-run, reproduced on a throwaway OrbStack box provisioned from scratch:
 *  - The Bots' browser crashed: `install -d -o box …/.config/plank/dock1/launchers` gave only the LAST level to box, so
 *    ~/.config was root's, Chromium couldn't make ~/.config/chromium, crashpad got no database ("--database is
 *    required") and bot-chrome@1 died with SIGTRAP every 2 s.
 *  - Checks failed on a fresh setup: box-doctor's log was one shared /tmp file that the host (bothost) created first,
 *    and dash exits on a failed `: > file`, so box's doctor printed nothing; verify-box's session check made
 *    ~/.claude/projects/-workspace as root (then the CLI, as box, couldn't save a session), and it failed on the
 *    user-memory folder a new box doesn't have yet.
 * These pin the scripts' text and run the doctor's log setup for real.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SseHub } from "../../gateway/sse-hub";
import { BoxStatus } from "../../computer/box-status";

const box = (f: string) => fs.readFileSync(path.resolve(__dirname, "../../../box", f), "utf8");

describe("a new box: the Bots' browser starts", () => {
  const prov = box("provision.sh");
  it("every level of ~/.config down to plank's launchers is made as box, never through a link", () => {
    const loop = /for d in \/home\/box\/\.config \/home\/box\/\.config\/plank \/home\/box\/\.config\/plank\/dock1 \/home\/box\/\.config\/plank\/dock1\/launchers; do\n\s+if \[ -L "\$d" \];.*\n\s+install -d -o box -g box -m 0755 "\$d"/;
    expect(prov).toMatch(loop);
    // No single `install -d -o box` of a deep path under ~/.config is left (it would make the parents root's again).
    expect(prov).not.toMatch(/install -d -o box -g box -m 0755 \/home\/box\/\.config\/\S+\/\S+/);
    // Before Chromium is started.
    expect(prov.search(loop)).toBeLessThan(prov.indexOf("systemctl enable --now bot-display@1.service bot-vnc@1.service bot-chrome@1.service"));
  });
  it("a root-owned ~/.claude/projects left by an older verify-box is given back to box", () => {
    expect(prov).toMatch(/for d in \/home\/box\/\.claude\/projects \/home\/box\/\.claude\/projects\/-workspace; do\n\s+if \[ -d "\$d" \] && \[ ! -L "\$d" \] && \[ "\$\(stat -c %U "\$d"\)" = root \]; then chown box:bots "\$d"; chmod 2775 "\$d"; fi/);
  });
});

describe("a new box: the checks pass", () => {
  it("verify-box makes the session dirs as box, and a new box's missing user-memory isn't a failure", () => {
    const v = box("verify-box.sh");
    const del = v.split("\n").find((l) => l.includes('"delete-session deletes the session file and its <uuid>/ dir"'))!;
    expect(del).toContain("runuser -u box -g bots -- mkdir -p $VD/$VU");
    expect(del).not.toMatch(/install -d -o box/);
    expect(v).toContain(`check "user memory readable by box" orb -m $M -u box sh -c 'test ! -e /home/box/agent-data/user-memory || ls /home/box/agent-data/user-memory'`);
  });

  it("box-doctor keeps one log per account and never dies on a log it can't write", () => {
    const doctor = box("files/box-doctor");
    const setup = doctor.split("\n").find((l) => l.startsWith("L="))!;
    expect(setup).toContain("/tmp/box-doctor.$(id -u).log");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
    try {
      // The box's /bin/sh is dash (which exits on the failed redirection); use it when this machine has it.
      const shell = fs.existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";
      const run = (line: string) => {
        const locked = path.join(dir, "locked.log");
        fs.rmSync(locked, { force: true });
        fs.writeFileSync(locked, "someone else's\n");
        fs.chmodSync(locked, 0o444); // as another account's file looks to this one
        const sh = `${line.replace(/"\/tmp\/box-doctor\.\$\(id -u\)\.log"|\/tmp\/box-doctor\.log/, `"${locked}"`)}\necho "alive $L"\n`;
        return spawnSync(shell, ["-c", sh], { encoding: "utf8" });
      };
      if (process.getuid?.() !== 0) {
        // The old line: dash exits at the failed redirection and prints nothing after it (seen on the box).
        if (shell === "/bin/dash") expect(run(`L=/tmp/box-doctor.log; : > "$L" 2>/dev/null || L=/dev/null`).stdout).not.toContain("alive");
        // The new one: carries on, logging to /dev/null.
        expect(run(setup).stdout.trim()).toBe("alive /dev/null");
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("the host counts a doctor that reported nothing as failed, not as a clean pass", async () => {
    const hub = new SseHub();
    const s = new BoxStatus({ hub, exec: async () => ({ code: 2, stdout: Buffer.from(""), stderr: "cannot create /tmp/box-doctor.log" }), snapshots: () => ({ latestAt: null, running: false }), busyBotIds: () => [], now: () => 1 });
    expect((await s.runDoctor()).failed).toEqual(["box-doctor"]);
    const ok = new BoxStatus({ hub, exec: async () => ({ code: 0, stdout: Buffer.from("PASS chromium\n"), stderr: "" }), snapshots: () => ({ latestAt: null, running: false }), busyBotIds: () => [], now: () => 1 });
    expect((await ok.runDoctor()).failed).toEqual([]);
  });
});
