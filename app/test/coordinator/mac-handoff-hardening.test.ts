/**
 * mac-handoff-hardening (bug 232, the review's probes after bug 229):
 *  1. osascript asks unless it is ONE plain -e whose code names no app (a script file, -l JavaScript, stdin, several
 *     -e, dynamic code, any application / tell / login item all ask).
 *  2. open asks on any -a/-b, any variable or unresolved (glob, substitution) argument, and on .terminal, .workflow,
 *     .scpt, .applescript as well as .command/.sh/.tool/.app.
 *  3. The raw-text hand-off scan runs on EVERY command (interpreter strings included), and also knows LoginHook /
 *     LogoutHook, at / batch, SMAppService and login items.
 *  4. Exempt (unsandboxed) programs run one-shot only: `claude -p`, `codex exec`, `swift build`; an interactive
 *     session is refused with a clear message, its stdin is closed, and send-input to it is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, STR5, macSandboxExempt, macSandboxInteractive, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

let home: string;
let userData: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mhh-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const handoff = (cmd: string) => macUnsandboxedHandoff(cmd, { home });

const ASK: Record<string, string[]> = {
  "1. osascript": [
    "osascript run.scpt",
    "osascript ~/Desktop/job.applescript arg",
    `osascript -l JavaScript -e 'Application("Finder").name()'`,
    `osascript -l JavaScript -e '1+1'`,
    `osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/X.app", hidden:false}'`,
    `osascript -e 'tell application "System Events" to get name of every process'`,
    `osascript -e 'tell application "Finder" to open POSIX file "/tmp/x.command"'`,
    `osascript -e 'tell app "Script Editor" to run document 1'`,
    `osascript -e 'display notification "a"' -e 'tell application "Terminal" to activate'`,
    `osascript -e 'display notification "a"' -e 'return 1'`,
    `echo 'tell application "Terminal" to do script "x"' | osascript`,
    "osascript - <<EOF\ntell application \"Terminal\" to do script \"x\"\nEOF",
    `osascript -e "$CODE"`,
    `osascript -e "$(cat job.txt)"`,
    `osascript -e 'run script (POSIX file "/tmp/a.scpt")'`,
  ],
  "2. open": [
    "open -a Terminal", "open -a Safari page.html", "open -b com.apple.Terminal x", "open -na Terminal", "open -gb com.googlecode.iterm2",
    `open "$F"`, "open $(ls *.command)", "open ~/Desktop/*.command", "open `cat target`",
    "open x.terminal", "open My.workflow", "open job.scpt", "open job.applescript", "open ./run.command", "open dist/My.app",
  ],
  "3. raw scan (interpreter strings) and new hand-offs": [
    `python3 -c "import shutil; shutil.copy('a.plist', '/Users/x/Library/LaunchAgents/a.plist')"`,
    `node -e "require('child_process').exec('launchctl load x.plist')"`,
    `ruby -e 'system("crontab", "jobs.txt")'`,
    `perl -e 'system "osascript -e \\"tell application \\\\\\"Terminal\\\\\\" to do script \\\\\\"ls\\\\\\"\\""'`,
    "defaults write com.apple.loginwindow LoginHook /tmp/x.sh",
    "defaults write com.apple.loginwindow LogoutHook /tmp/x.sh",
    "echo ls | at now + 1 minute", "at -f job.sh now", "batch < job.sh",
    `python3 -c "from ServiceManagement import SMAppService; SMAppService.mainApp().registerAndReturnError_(None)"`,
    "sfltool dumpbtm | grep loginitems",
    "echo launchctl",
  ],
};

describe("probes that must ask (as a hand-off)", () => {
  for (const [group, cmds] of Object.entries(ASK)) {
    it.each(cmds)(`${group}: %s`, (cmd) => expect(handoff(cmd)).not.toBeNull());
  }
  it.each([
    "ls", "git status", "launchctlx", "cat notes.txt", "open https://example.com", // bug 233: local opens and all osascript ask
    "python3 -c 'print(1)'", "npm run batch-build",
    "echo 'meet at 5'",
  ])("stays quiet: %s", (cmd) => expect(handoff(cmd)).toBeNull());
});

describe("the policy: every probe needs a card, in every mode, whatever the grants", () => {
  const key = Buffer.alloc(32, 3);
  const store = (mode: "ask" | "accept-edits" | "full-auto") => {
    const p = new LocalPolicyStore(userData, Date.now, key, { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    p.grant("b1", "run-command");
    p.setBotMode("b1", mode);
    return p;
  };
  // Bug 258 (the plan's intended change), tightened in the fix round to an ALLOW-LIST: in Full auto only a small,
  // fully-parsed set of osascript actions (here, a read-only System Events query) runs with no card. Every other
  // probe still cards in Full auto, and all of them still card in Ask and Auto-accept edits.
  const EVERYDAY_IN_FULL_AUTO = new Set([
    `osascript -e 'tell application "System Events" to get name of every process'`,
    "open -a Safari page.html", // opening a local file with an installed (allowed) app
  ]);
  it.each(["ask", "accept-edits", "full-auto"] as const)("%s", (mode) => {
    const p = store(mode);
    for (const cmd of Object.values(ASK).flat()) {
      const v = p.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: cmd, cwd: home });
      if (mode === "full-auto" && EVERYDAY_IN_FULL_AUTO.has(cmd)) expect(v, cmd).toMatchObject({ ok: true, quiet: true });
      else expect(v.ok, cmd).toBe(false);
    }
  });
});

describe("4. exempt programs are one-shot only", () => {
  // Bug 239: claude and codex are no longer exempt (they run in the sandbox); brew source builds are not exempt either.
  it.each(["swift build", "swift test", "swift run App", "xcodebuild -scheme A build", "npx playwright test"])(
    "one-shot, exempt: %s", (cmd) => { expect(macSandboxExempt(cmd)).not.toBeNull(); expect(macSandboxInteractive(cmd)).toBeNull(); });

  it.each(["swift", "swift repl", "cd x && swift"])(
    "interactive, refused: %s", (cmd) => expect(macSandboxInteractive(cmd)).not.toBeNull());

  it("the policy refuses an interactive session outright (no card) in every mode, with a clear message", () => {
    for (const mode of ["ask", "full-auto"] as const) {
      const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 3), { home: () => home, userData: () => userData });
      p.setBotMode("b1", mode);
      const v = p.check({ execId: "x", botId: "b1", approvalId: "whatever", op: "run-command", command: "swift repl", cwd: home });
      expect(v.ok).toBe(false);
      const reason = (v as { reason: string }).reason;
      expect(reason.startsWith(LOCAL_NEEDS_APPROVAL)).toBe(false);
      expect(reason).toContain(STR5.macExemptInteractive);
    }
  });

  describe.runIf(process.platform === "darwin")("the executor", () => {
    let bin: string;
    let oldPath: string | undefined;
    beforeEach(() => {
      bin = fs.mkdtempSync(path.join(os.tmpdir(), "mhh-bin-"));
      // A fake `swift` that would read commands from stdin for 2 s (an interactive session).
      fs.writeFileSync(path.join(bin, "swift"), "#!/bin/sh\nread line && echo \"GOT:$line\"\nsleep 2\necho done\n", { mode: 0o755 });
      oldPath = process.env.PATH;
      process.env.PATH = `${bin}:${oldPath}`;
    });
    afterEach(() => { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); });

    it("an unsandboxed run gets no stdin, and send-input to it is refused", async () => {
      const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
      const out: string[] = [];
      const run = ex.run({ execId: "s1", botId: "b", approvalId: null, op: "run-command", command: "swift build", cwd: home }, { output: (_s, c) => out.push(c) });
      await new Promise((r) => setTimeout(r, 200));
      await expect(ex.run({ execId: "i1", botId: "b", approvalId: null, op: "send-input", command: "s1", input: "cat secret\n" }, { output: () => {} })).rejects.toThrow(STR5.macExemptNoInput);
      await run;
      expect(out.join("")).not.toContain("GOT:cat secret");
    });

    it("the executor also refuses an interactive exempt session itself", async () => {
      const ex = new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
      await expect(ex.run({ execId: "s2", botId: "b", approvalId: null, op: "run-command", command: "swift", cwd: home }, { output: () => {} })).rejects.toThrow(STR5.macExemptInteractive);
    });
  });
});
