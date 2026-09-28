/**
 * policy-key-followup (bug 229, after bug 225's key file went live):
 *  1. Programs that start a sandbox of their own fail inside sandbox-exec ("sandbox_apply: Operation not permitted"):
 *     the failure is named plainly, and a small known list runs WITHOUT the wrapper — behind the static NEVER rules and
 *     always with the user's card, in every mode (the sandbox isn't there to guard the key).
 *  2. Reset permissions refuses while the key file is sound.
 *  3. Hand-offs that run code outside the sandbox later (launchctl, LaunchAgents writes, crontab, open of a script or
 *     an app, osascript telling Terminal/iTerm to run something) always ask, Full auto included.
 *  4. The app-data NEVER rule matches the folder as a whole path segment, never a prefix (BotsSync is not Bots).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, STR5, evaluateFixedRules, localBindTarget, macSandboxExempt, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";
import { POLICY_KEY_FILE } from "../../src/coordinator/local-exec/policy-key";
import { createLocalDaemon, disposeScratchPolicy } from "../../src/coordinator/local-exec/wiring";

let home: string;
let userData: string;
let tmpRoot: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pkf-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "probe.txt"), "SECRET-PROBE");
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkf-scratch-"));
});
afterEach(() => {
  disposeScratchPolicy();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
async function sh(command: string): Promise<{ out: string; code: number | null }> {
  const chunks: string[] = [];
  const r = await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return { out: chunks.join(""), code: r.exitCode };
}

describe.runIf(process.platform === "darwin")("1. nested sandboxes", () => {
  it("a program that applies its own sandbox fails with a clear, named error (not a bare sandbox_apply line)", async () => {
    const r = await sh(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(STR5.macNestedSandbox);
  });

  it("the sandbox still guards the app data for everything else (a glob names nothing the static rules know)", async () => {
    const r = await sh(`cat ${home}/Library/App*/Bo*/probe.txt`);
    expect(r.out).not.toContain("SECRET-PROBE");
  });

  it("bug 236: a known-list tool CHAINED with anything else stays inside the sandbox", async () => {
    // Only a single simple command runs unwrapped (the unwrapped case: exempt-tool-pinning.test.ts, mac-unwrapped-shell.test.ts).
    const r = await sh(`swift --version >/dev/null 2>&1; cat ${home}/Library/App*/Bo*/probe.txt`);
    expect(r.out).not.toContain("SECRET-PROBE");
  });
});

describe("1. the known list", () => {
  it.each([
    "swift build", "swift test --parallel", "cd pkg && swift build -c release", "xcodebuild -scheme App build",
    // bug 239: brew source builds, claude and codex are no longer exempt
    "npx playwright test", "pnpm exec playwright test", "playwright install chromium", "npx electron .", "electron .",
    "chromium --headless",
  ])("exempt: %s", (cmd) => expect(macSandboxExempt(cmd)).not.toBeNull());

  it.each(["ls", "brew install wget", "brew install --build-from-source ffmpeg", "claude -p hi", "codex exec hi", "brew list", "python3 build.py", "echo swift", "cat swift.txt", "$(echo swift) build", "npm test"])(
    "not exempt: %s", (cmd) => expect(macSandboxExempt(cmd)).toBeNull());
});

describe("1 + 3. always a card, in every mode, whatever the grants", () => {
  const key = Buffer.alloc(32, 5);
  const store = () => {
    const p = new LocalPolicyStore(userData, Date.now, key, { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    p.grant("b1", "run-command");
    return p;
  };
  const req = (command: string) => ({ execId: "x", botId: "b1", approvalId: null, op: "run-command" as const, command, cwd: home });
  const STRICT = [
    "swift build", "npx playwright test", "xcodebuild build",
    "launchctl load ~/Library/LaunchAgents/x.plist", "launchctl bootstrap gui/501 x.plist", "crontab -l", "crontab jobs.txt",
    "echo '<plist/>' > ~/Library/LaunchAgents/com.x.plist", "cp x.plist ~/Library/LaunchAgents/", "tee ~/Library/LaunchAgents/a.plist < x",
    "open ./run.command", "open build/go.sh", "open -a Terminal job.tool", "open dist/My.app", "open -n ~/Desktop/Tool.app --args x",
    `osascript -e 'tell application "Terminal" to do script "ls"'`,
    `osascript -e 'tell application "iTerm2" to tell current session of current window to write text "ls"'`,
    `osascript -l JavaScript -e 'Application("Terminal").doScript("ls")'`,
  ];

  it.each(["ask", "accept-edits", "full-auto"] as const)("mode %s", (mode) => {
    const p = store();
    p.setBotMode("b1", mode);
    for (const cmd of STRICT) {
      const v = p.check(req(cmd));
      expect(v.ok, cmd).toBe(false);
      expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL), cmd).toBe(true);
    }
    if (mode === "full-auto") expect(p.check(req(`ls ${home}`))).toEqual({ ok: true }); // the control: ordinary work stays quiet
  });

  it("the card's approval runs it once", () => {
    const p = store();
    p.setBotMode("b1", "full-auto");
    // Bug 235: the approval is for the tool its card showed (pinned), so the card is shown first, with a known `swift`.
    const bin = fs.mkdtempSync(path.join(home, "bin-"));
    fs.writeFileSync(path.join(bin, "swift"), "#!/bin/sh\n", { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(p.check(req("swift build")).ok).toBe(false); // the card
      p.recordApproval("a1", { botId: "b1", expiresAt: Date.now() + 60_000, bind: bindHash("run-command", localBindTarget(req("swift build"))) });
      expect(p.check({ ...req("swift build"), approvalId: "a1" })).toMatchObject({ ok: true });
      expect(p.check({ ...req("swift build"), approvalId: "a1" }).ok).toBe(false);
    } finally { process.env.PATH = oldPath; }
  });

  it.each(["open https://example.com", "launchctlx"])( // bug 232: "echo launchctl" asks; bug 233: any osascript and any local open ask
    "no hand-off: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).toBeNull());
});

describe("2. Reset permissions refuses while the key file is sound", () => {
  it("nothing is reset, grants and key stay", async () => {
    const w = createLocalDaemon({ userData, log: () => {}, call: async () => ({}), tmpRoot, heartbeatMs: 3_600_000 });
    expect(w.durable).toBe(true);
    await w.daemon.intercept("setLocalMacAppAllowed", { id: "cos", allowed: true });
    const keyBefore = fs.readFileSync(path.join(userData, POLICY_KEY_FILE));
    await expect(w.daemon.intercept("resetLocalPolicy", {})).rejects.toThrow(STR5.localPolicyResetRefused);
    expect(fs.readFileSync(path.join(userData, POLICY_KEY_FILE))).toEqual(keyBefore);
    const again = createLocalDaemon({ userData, log: () => {}, call: async () => ({}), tmpRoot, heartbeatMs: 3_600_000 });
    expect(((await again.daemon.intercept("getLocalMacAppAllowed", { id: "cos" })) as { result: { allowed: boolean } }).result.allowed).toBe(true);
  });
});

describe("4. the app-data NEVER matches a whole path segment only", () => {
  const ctx = () => ({ home, projectDirs: [], userData, realpath: (p: string) => fs.realpathSync.native(p) });
  const verdict = (command: string) => evaluateFixedRules({ side: "mac", kind: "command", command, cwd: home }, ctx()).verdict;
  it.each([
    `ls "${home}/Library/Application Support/SynapseSync"`,
    `cat "${home}/Library/Application Support/Synapse-backup/notes.txt"`,
    `cd "${home}/Library/Application Support" && ls SynapseSync`,
    `ls ~/Library/Application\\ Support/Synapseford`,
  ])("not the app's data: %s", (cmd) => expect(verdict(cmd)).not.toBe("never"));
  it.each([
    `ls "${home}/Library/Application Support/Synapse"`,
    `ls "${home}/Library/Application Support/Synapse/"`,
    `cat "${home}/Library/Application Support/Synapse/computers.json"`,
    `ls ~/Library/Application\\ Support/Synapse`,
    `cd ~/Library && cat "Application Support/Synapse/local-tool-grants.json"`,
    `ls ${home}/Library/Application\\ Support/Synapse;echo`,
  ])("the app's data: %s", (cmd) => expect(verdict(cmd)).toBe("never"));
});
