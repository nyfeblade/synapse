/**
 * mac-sandbox-exec-deny (bug 233): a kernel-level backstop under the static hand-off rules.
 *  1. The command sandbox denies exec of launchctl, crontab, at, batch, open, osascript and sfltool, and writes to
 *     ~/Library/LaunchAgents, ~/Library/LaunchDaemons and the background-task-management store — so a hand-off hidden
 *     where the static rules can't see it (a string built at runtime in python/node) fails at exec. A hand-off the user
 *     approved on its card runs UNWRAPPED for that one call, so the approved action still works.
 *  2. `open` of anything but an http(s) URL is a hand-off (asks), whatever the extension: an extensionless executable,
 *     a .fileloc, a symlink to an app, a (percent-encoded) file:// URL.
 * Everything runs in temp dirs; the only real system command run unwrapped is the read-only `launchctl list`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR5, macPlainUrlOpen, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";

let home: string;
let userData: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sxd-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("2. open of anything but an http(s) URL asks", () => {
  it.each([
    "open ./runme", "open runme", "open ~/Desktop/link-to-app", "open x.fileloc", "open report.pdf", "open .",
    "open file:///tmp/x.command", "open 'file:///tmp/x%2Ecommand'", "open FILE:///Applications/Calculator.app",
    "open mailto:a@b.c", "open x-apple.systempreferences:com.apple.preference.security", "open -R ~/Downloads/x",
    // osascript is exec-denied in the sandbox, so every osascript is a hand-off: the card's approval runs it unwrapped.
    `osascript -e 'display notification "hi"'`, `osascript -e 'return 1 + 1'`,
  ])("asks: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull());
  it.each(["open https://example.com", "open 'http://localhost:3000/path?q=1'", "open 'https://example.com/a b'"])(
    "quiet: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).toBeNull());

  // /usr/bin/open is exec-denied in the sandbox, so a web page opens only when the WHOLE command is `open <http(s) URL…>`
  // (nothing else can run beside it): that exact form runs unwrapped, anything more stays wrapped.
  it.each(["open https://example.com", "open 'http://localhost:3000/path?q=1' https://b.test"])("plain URL open: %s", (cmd) => expect(macPlainUrlOpen(cmd)).toBe(true));
  it.each(["open -a Safari https://x.test", "open https://x.test; ls", "open https://x.test && python3 x.py", "open \"$U\"", "open https://x.test > out", "open file:///tmp/x", "echo https://x.test | xargs open", "open"])(
    "not a plain URL open: %s", (cmd) => expect(macPlainUrlOpen(cmd)).toBe(false));
});

describe("1. the profile", () => {
  it("denies exec of the hand-off programs and writes to the launch places, with the home spelled and escaped", () => {
    const weird = path.join(home, 'we"ird\\home');
    fs.mkdirSync(weird);
    const p = ownDataSandboxProfile(userData, weird);
    for (const bin of ["/bin/launchctl", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/batch", "/usr/bin/open", "/usr/bin/osascript", "/usr/bin/sfltool"]) {
      expect(p).toContain(`(literal "${bin}")`);
    }
    expect(p).toMatch(/\(deny process-exec/);
    const esc = weird.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    for (const d of ["Library/LaunchAgents", "Library/LaunchDaemons", "Library/Application Support/com.apple.backgroundtaskmanagementagent"]) {
      expect(p).toContain(`(subpath "${esc}/${d}")`);
    }
  });
});

describe.runIf(process.platform === "darwin")("1. live, under the wrapper (temp dirs only)", () => {
  const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
  async function sh(command: string, approvalId: string | null = null): Promise<{ out: string; code: number | null }> {
    const chunks: string[] = [];
    const r = await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
    return { out: chunks.join(""), code: r.exitCode };
  }

  it("an obfuscated launchctl from python fails at exec", async () => {
    const r = await sh(`python3 -c "import os; print('rc', os.system('launch'+'ctl list'))"`);
    expect(r.out).not.toMatch(/PID\s+Status\s+Label/);
    expect(r.out).toMatch(/not permitted/i);
    expect(r.out).not.toMatch(/rc 0\b/);
  });

  it("an obfuscated launchctl from node fails at exec", async () => {
    const r = await sh(`node -e "try { require('child_process').execFileSync('/bin/launch'+'ctl', ['list'], {stdio:'pipe'}); console.log('RAN') } catch (e) { console.log('BLOCKED', e.code || e.status) }"`);
    expect(r.out).toContain("BLOCKED");
    expect(r.out).not.toContain("RAN");
  });

  it.each(["open -g ./nothing-here", "osascript -e 'return 1'", "crontab -l", "at -l", "sfltool 2>&1 | head -1"])(
    "%s fails at exec, with a message that says why", async (cmd) => {
      const r = await sh(cmd);
      expect(r.out).toMatch(/not permitted/i);
      expect(r.out).toContain(STR5.macHandoffBlocked);
    });

  it("writes into ~/Library/LaunchAgents are denied (a temp home)", async () => {
    const r = await sh(`mkdir -p "${home}/Library/LaunchAgents" 2>&1; echo '<plist/>' > "${home}/Library/LaunchAgents/x.plist" 2>&1; ls "${home}/Library/LaunchAgents" 2>&1`);
    expect(fs.existsSync(path.join(home, "Library", "LaunchAgents", "x.plist"))).toBe(false);
    expect(r.out).toMatch(/not permitted|No such file/i);
  });

  it("an APPROVED hand-off runs unwrapped for that one call", async () => {
    const r = await sh("launchctl list >/dev/null && echo LAUNCHCTL-OK", "approved-1");
    expect(r.out).toContain("LAUNCHCTL-OK");
    const again = await sh("launchctl list >/dev/null && echo LAUNCHCTL-OK");
    expect(again.out).not.toContain("LAUNCHCTL-OK");
  });

  it("an approval id on a command that is NOT a hand-off doesn't unwrap it", async () => {
    fs.writeFileSync(path.join(userData, "probe.txt"), "SECRET-PROBE");
    const r = await sh(`cat ${home}/Library/App*/Bo*/probe.txt`, "approved-2");
    expect(r.out).not.toContain("SECRET-PROBE");
  });

  describe("regressions: ordinary work still runs under the wrapper", () => {
    it.each([
      ["git", "git --version", /git version/],
      ["node", "node -e 'console.log(6*7)'", /42/],
      ["python3", "python3 -c 'print(6*7)'", /42/],
      ["ls", "mkdir -p sub && touch sub/a.txt && ls sub", /a\.txt/],
      ["a script file", "printf '#!/bin/sh\\necho SCRIPT-OK\\n' > s.sh && chmod +x s.sh && ./s.sh", /SCRIPT-OK/],
      ["a pipeline", "printf 'b\\na\\n' | sort | head -1", /^a$/m],
      ["say (to a file)", "say -o spoken.aiff hello && test -s spoken.aiff && echo SAY-OK", /SAY-OK/],
      ["git in a temp repo", "git init -q r && cd r && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x && git log --oneline | wc -l", /\b1\b/],
    ])("%s", async (_n, cmd, want) => {
      const r = await sh(cmd);
      expect(r.out).toMatch(want);
      expect(r.code).toBe(0);
    });
  });
});
