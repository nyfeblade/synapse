/**
 * mac-keychain-guard:
 *  1. `security find-generic-password -s "Claude Code-credentials" -w` (and every other keychain READ) is a fixed
 *     never-allow in any mode; every other `security` subcommand asks; the sandbox profile exec-denies /usr/bin/security
 *     and denies mach-lookup of the Security server, so a copied binary or python keyring can't reach securityd either.
 *  (Part 2 — the Bots' claude sign-in — became a token flow: mac-credentials.test.ts.)
 * HOME is a temp dir; the keychain is never read — `security` and `claude` are stubbed on a temp PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFixedRules } from "@synapse/shared";
import { KEYCHAIN_BINARIES, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let bin: string;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mkg-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${FIXED_PATH}`;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const ctx = () => ({ home, projectDirs: [], userData, realpath: (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } } });
const verdict = (command: string) => evaluateFixedRules({ side: "mac", kind: "command", command, cwd: home }, ctx());

describe("1. the security tool", () => {
  it.each([
    `security find-generic-password -s "Claude Code-credentials" -w`,
    "security find-generic-password -ws login",
    "security find-internet-password -s example.com",
    "security dump-keychain",
    "security export -k login.keychain",
    "security find-key",
    "security", // bare / unknown args: fail closed to never
  ])("keychain read is NEVER, in any mode: %s", (cmd) => expect(verdict(cmd).verdict).toBe("never"));

  it.each(["security list-keychains", "security find-identity -v -p codesigning", "security add-trusted-cert cert.pem", "security unlock-keychain"])(
    "every other security use asks: %s", (cmd) => expect(verdict(cmd).verdict).toBe("always-ask"));

  it("the sandbox profile exec-denies /usr/bin/security and denies the Security server mach-lookup", () => {
    const p = ownDataSandboxProfile(userData, home);
    expect(KEYCHAIN_BINARIES).toContain("/usr/bin/security");
    expect(p).toContain(`(literal "/usr/bin/security")`);
    expect(p).toMatch(/\(deny mach-lookup[^)]*"com\.apple\.SecurityServer"/);
  });

  it("the Mac policy refuses a keychain read even with a grant / Full auto (never overrides)", () => {
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 1), { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    p.grant("b1", "run-command");
    p.setBotMode("b1", "full-auto");
    const v = p.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: `security find-generic-password -s "Claude Code-credentials" -w`, cwd: home });
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toMatch(/never|keychain/i);
  });

  it.runIf(process.platform === "darwin")("live: a keychain read is refused before anything runs (a stub security is never called)", async () => {
    // The stub would print a secret if it ran; the policy refuses the command, so it never does.
    fs.writeFileSync(path.join(bin, "security"), "#!/bin/sh\necho LEAKED-SECRET\n", { mode: 0o755 });
    const daemonPolicy = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 1), { home: () => home, userData: () => userData });
    daemonPolicy.setBotMode("b1", "full-auto");
    const v = daemonPolicy.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: "security find-generic-password -ws login", cwd: home });
    expect(v.ok).toBe(false);
  });
});

