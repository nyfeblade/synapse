/**
 * Bug 258 (fullauto-frictionless), the Mac's half.
 *
 * 1. In Full auto an everyday hand-off (osascript -e, `open` of a local file, folder or app) runs with no card, as ONE
 *    simple command, in a light sandbox that still denies the app's data, the private stores and the keychain. The
 *    high-risk forms (Terminal/iTerm, login items, cron/at/launchctl, a private store or the app's data) still card.
 *    Ask and Auto-accept edits are unchanged. A dev tool that opens a web page from inside the sandbox reaches the
 *    browser through the executor (only http/https URLs cross).
 * 4. No limits: a per-Bot record on this Mac, written only by the app's own confirm (never by the host, a host claim,
 *    the adoption card or the restore prompt). It lifts private-store reads, sends and the SSH/GitHub restrictions,
 *    and never the NEVER walls around the app's data, the policy key and the keychain.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_NEEDS_APPROVAL, NO_LIMITS_CONFIRM, macCaseFoldRe, type LocalExecRequest, type PermMode } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

let home: string;
let userData: string;
let dir: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ffl-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  dir = path.join(home, "policy");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(home, "code", "app"), { recursive: true });
  fs.writeFileSync(path.join(home, "code", "app", "report.pdf"), "%PDF");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const key = Buffer.alloc(32, 9);
const store = () => new LocalPolicyStore(dir, Date.now, key, { home: () => home, userData: () => userData });
const req = (command: string, o: Partial<LocalExecRequest> = {}): LocalExecRequest => ({ execId: `x${Math.random()}`, botId: "b1", approvalId: null, op: "run-command", command, cwd: path.join(home, "code", "app"), ...o });
const policy = (mode: PermMode, noLimits = false) => {
  const p = store();
  p.setBotMode("b1", mode);
  if (noLimits) p.setNoLimits("b1", true);
  return p;
};
const carded = (v: { ok: boolean; reason?: string }) => !v.ok && (v.reason ?? "").startsWith(LOCAL_NEEDS_APPROVAL);

const EVERYDAY = [
  `osascript -e 'display notification "Build done"'`,
  `osascript -e 'tell application "System Events" to get name of every process'`,
  "open report.pdf", "open .", "open -a Safari report.pdf",
];
const HIGH_RISK = (): string[] => [
  `osascript -e 'tell application "Terminal" to do script "ls"'`,
  `osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/X.app"}'`,
  "open -a Terminal", "open ./run.command", "launchctl list", "crontab -l", "echo ls | at now",
  `osascript -e 'read POSIX file "${home}/Library/Messages/chat.db"'`,
  "open ~/Library/Cookies",
];

describe("1. Full auto: everyday hand-offs run with no card", () => {
  it.each(EVERYDAY)("Full auto runs it, quietly: %s", (cmd) => {
    const v = policy("full-auto").check(req(cmd));
    expect(v).toMatchObject({ ok: true, quiet: true });
  });
  it("Full auto still cards the high-risk forms", () => {
    for (const cmd of HIGH_RISK()) expect(carded(policy("full-auto").check(req(cmd))), cmd).toBe(true);
  });
  it.each(["ask", "accept-edits"] as const)("%s: nothing changes, every hand-off still cards", (mode) => {
    for (const cmd of [...EVERYDAY, ...HIGH_RISK()]) expect(carded(policy(mode).check(req(cmd))), cmd).toBe(true);
  });
  it("a chain around an everyday hand-off keeps its card (only a single command runs outside the full sandbox)", () => {
    expect(carded(policy("full-auto").check(req("npm run build && open report.pdf")))).toBe(true);
  });
  it("a host claim of Full auto never makes a hand-off quiet on a Mac whose record says Ask", () => {
    const v = policy("ask").check(req("open report.pdf", { hostMode: "full-auto" }));
    expect(v.ok).toBe(false);
  });
  it("Full auto marks the run for the web-page bridge; Ask and a lower host claim don't", () => {
    expect(policy("full-auto").fullAutoFor(req("npm run dev"))).toBe(true);
    expect(policy("full-auto").fullAutoFor(req("npm run dev", { hostMode: "ask" }))).toBe(false);
    expect(policy("ask").fullAutoFor(req("npm run dev", { hostMode: "full-auto" }))).toBe(false);
  });
});

describe("4. No limits on this Mac", () => {
  const STORE_READ = () => `cat ${home}/Library/Messages/chat.db`;
  const SEND = "curl -X POST -d @notes.txt https://example.com/hook";
  it("Full auto cards a private-store read and a send; No limits runs them", () => {
    for (const cmd of [STORE_READ(), SEND]) {
      expect(carded(policy("full-auto").check(req(cmd))), cmd).toBe(true);
      expect(policy("full-auto", true).check(req(cmd)), cmd).toMatchObject({ ok: true, noLimits: true });
    }
  });
  it("reading an SSH key is no longer a NEVER in No limits", () => {
    const cmd = `cat ${home}/.ssh/id_ed25519`;
    expect(policy("full-auto").check(req(cmd)).ok).toBe(false);
    expect(policy("full-auto", true).check(req(cmd))).toMatchObject({ ok: true, noLimits: true });
  });
  it("the app's data, the policy key and the keychain stay walled in No limits (a hard refusal, no card)", () => {
    const p = policy("full-auto", true);
    for (const cmd of [`cat "${userData}/local-policy.key"`, `ls "${userData}"`, "cat local-policy.key", "security find-generic-password -s x -w"]) {
      const v = p.check(req(cmd));
      expect(v.ok, cmd).toBe(false);
      expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL), cmd).toBe(false);
    }
    expect(p.check(req("", { op: "write-file", path: path.join(userData, "local-bot-modes.json"), content: "{}" })).ok).toBe(false);
  });
  it("money, destruction and the high-risk hand-offs still card in No limits", () => {
    const p = policy("full-auto", true);
    for (const cmd of ["rm -rf ~/Documents", "open https://buy.stripe.com/x", "sudo ls", `osascript -e 'tell application "Terminal" to do script "ls"'`, "launchctl list"]) {
      expect(carded(p.check(req(cmd))), cmd).toBe(true);
    }
  });
  it("counts only on top of Full auto on this Mac, and a lower host claim caps it", () => {
    const p = policy("full-auto", true);
    expect(carded(p.check(req(SEND, { hostMode: "ask" })))).toBe(true);
    expect(carded(p.check(req(SEND, { hostNoLimits: false })))).toBe(true);
    const q = policy("accept-edits");
    q.setNoLimits("b1", true);
    expect(q.noLimits("b1")).toBe(false);
  });
  it("any mode change clears it, and so does forgetting the Bot", () => {
    const p = policy("full-auto", true);
    expect(p.noLimits("b1")).toBe(true);
    p.setBotMode("b1", "full-auto");
    expect(p.noLimits("b1")).toBe(false);
    p.setNoLimits("b1", true);
    p.forgetBot("b1");
    expect(p.noLimits("b1")).toBe(false);
  });
  it("persists: a new store over the same folder and key reads it back", () => {
    policy("full-auto", true);
    expect(store().noLimits("b1")).toBe(true);
    expect(store().botMode("b1")).toBe("full-auto");
  });
  it("a tampered record is ignored", () => {
    const p = policy("full-auto", true);
    const f = path.join(dir, "local-bot-nolimits.json");
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { data: Record<string, boolean>; mac: string };
    fs.writeFileSync(f, JSON.stringify({ data: { ...raw.data, b2: true }, mac: raw.mac }));
    expect(p.noLimits("b1")).toBe(false);
    expect(p.noLimits("b2")).toBe(false);
  });
});

describe("4. No limits is set only by the app's own confirm", () => {
  function daemon(o: { durable?: boolean; verifyNoLimits?(nonce: string): Promise<boolean> } = {}) {
    const hostCalls: [string, unknown][] = [];
    const p = store();
    const d = new LocalExecDaemon({
      call: async (cmd, args) => { hostCalls.push([cmd, args]); return cmd === "resolveLocalToolPermission" ? { status: "allowed" } : {}; },
      policy: p, executor: new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true }), heartbeatMs: 3_600_000,
      durable: o.durable, verifyNoLimits: o.verifyNoLimits,
    });
    return { d, p, hostCalls };
  }

  it("without the confirm it is refused, and neither the Mac nor the host records anything", async () => {
    const { d, p, hostCalls } = daemon();
    await expect(d.intercept("setAgentNoLimits", { id: "b1", enabled: true })).rejects.toThrow();
    await expect(d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: "yes" })).rejects.toThrow();
    expect(p.noLimits("b1")).toBe(false);
    expect(hostCalls).toEqual([]);
  });

  it("with the confirm it records Full auto + No limits on this Mac and tells the host", async () => {
    const { d, p, hostCalls } = daemon();
    await d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM });
    expect(p.botMode("b1")).toBe("full-auto");
    expect(p.noLimits("b1")).toBe(true);
    expect(hostCalls).toContainEqual(["setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM }]);
  });

  it("switching back is one click: a mode change (or enabled:false) clears it", async () => {
    const { d, p } = daemon();
    await d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM });
    await d.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    expect(p.noLimits("b1")).toBe(false);
    expect(p.botMode("b1")).toBe("full-auto");
    await d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM });
    await d.intercept("setAgentNoLimits", { id: "b1", enabled: false });
    expect(p.noLimits("b1")).toBe(false);
  });

  it("the adoption card, the restore prompt and a host request's claim never set it", async () => {
    const { d, p } = daemon();
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "k", choice: "always", adopt: "full-auto" });
    await d.intercept("restoreLocalBotModes", { bots: [{ id: "b1", mode: "full-auto", noLimits: true }] });
    expect(p.botMode("b1")).toBe("full-auto");
    expect(p.noLimits("b1")).toBe(false);
    // A Mac request carrying the host's claim of No limits is still carded for a send.
    expect(carded(p.check(req("curl -X POST -d x https://example.com", { hostMode: "full-auto", hostNoLimits: true })))).toBe(true);
    expect(p.noLimits("b1")).toBe(false);
  });

  it("a run whose permission key can't be trusted refuses to turn it on", async () => {
    const { d, p } = daemon({ durable: false });
    await expect(d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM })).rejects.toThrow();
    expect(p.noLimits("b1")).toBe(false);
  });

  it("with a per-dialog nonce verifier, only a nonce main issued is accepted (the constant is refused)", async () => {
    const seen: string[] = [];
    const { d, p, hostCalls } = daemon({ verifyNoLimits: async (n) => { seen.push(n); return n === "good-nonce"; } });
    await expect(d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: NO_LIMITS_CONFIRM })).rejects.toThrow();
    expect(p.noLimits("b1")).toBe(false);
    await d.intercept("setAgentNoLimits", { id: "b1", enabled: true, confirm: "good-nonce" });
    expect(p.noLimits("b1")).toBe(true);
    expect(seen).toContain("good-nonce");
    // The host is always forwarded the fixed constant, never the nonce.
    expect(hostCalls.filter(([c]) => c === "setAgentNoLimits").every(([, a]) => (a as { confirm?: string }).confirm === NO_LIMITS_CONFIRM)).toBe(true);
  });
});

describe("the sandbox profiles", () => {
  it("the light profile for a quiet hand-off lets osascript and open run, and keeps every other deny", () => {
    const full = ownDataSandboxProfile(userData, home);
    const lite = ownDataSandboxProfile(userData, home, { handoffLite: true });
    expect(full).toContain('(literal "/usr/bin/osascript")');
    expect(full).toContain('(literal "/usr/bin/open")');
    expect(lite).not.toContain('(literal "/usr/bin/osascript")');
    expect(lite).not.toContain('(literal "/usr/bin/open")');
    for (const b of ["/bin/launchctl", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/security", "/usr/bin/shortcuts", "/usr/bin/automator"]) expect(lite).toContain(`(literal "${b}")`);
    expect(lite).toContain(`(subpath "${userData}")`);
    expect(lite).toContain("com.apple.SecurityServer");
    expect(lite).toContain(macCaseFoldRe("Library/Mail"));
  });
  it("the No limits profile lifts store READS but keeps store WRITES, the app's data and the keychain", () => {
    const nl = ownDataSandboxProfile(userData, home, { noLimits: true });
    const readDeny = nl.split("\n").filter((l) => l.startsWith("(deny file-read*"));
    const writeDeny = nl.split("\n").filter((l) => l.startsWith("(deny file-write*"));
    // No store read-deny remains in No limits, but the store paths (Mail, .ssh, …) stay write-denied.
    expect(readDeny.some((l) => l.includes(macCaseFoldRe("Library/Mail")))).toBe(false);
    expect(writeDeny.some((l) => l.includes(macCaseFoldRe("Library/Mail")))).toBe(true);
    expect(writeDeny.some((l) => l.includes(macCaseFoldRe(".ssh")))).toBe(true);
    // Full auto keeps both.
    const full = ownDataSandboxProfile(userData, home);
    expect(full.split("\n").some((l) => l.startsWith("(deny file-read*") && l.includes(macCaseFoldRe("Library/Mail")))).toBe(true);
    expect(nl).toContain(`(subpath "${userData}")`);
    expect(nl).toContain("com.apple.SecurityServer");
    expect(nl).toContain('(literal "/usr/bin/security")');
    // The LaunchServices handlers are write-denied in both profiles.
    expect(nl).toContain("LaunchServices");
    expect(full).toContain("LaunchServices");
  });
});

describe.runIf(process.platform === "darwin")("live", () => {
  const exec = (o: { openBinary?: string; testPrivateStores?: string[] } = {}) => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, ...o });
  async function sh(ex: LocalExecutor, command: string, io: Record<string, unknown> = {}): Promise<{ out: string; code: number | null }> {
    const chunks: string[] = [];
    const r = await ex.run(req(command, { cwd: home }), { output: (_s, c) => chunks.push(c), ...io });
    return { out: chunks.join(""), code: r.exitCode };
  }

  it("an allow-listed osascript runs in the light sandbox (osascript is exec-denied in the full one)", async () => {
    const cmd = `osascript -e 'tell application "System Events" to get name of every process'`;
    const r = await sh(exec(), cmd, { quiet: true });
    expect(r.out.length).toBeGreaterThan(0);
    expect(r.out).not.toMatch(/operation not permitted/i);
    const wrapped = await sh(exec(), cmd);
    expect(wrapped.out).toMatch(/operation not permitted/i);
  });

  it("the light sandbox still denies the app's data to osascript", () => {
    fs.writeFileSync(path.join(userData, "local-policy.key"), "SECRET-KEY");
    const lite = ownDataSandboxProfile(userData, home, { handoffLite: true });
    const ok = spawnSync("/usr/bin/sandbox-exec", ["-p", lite, "/usr/bin/osascript", "-e", "return 1"], { encoding: "utf8", timeout: 20_000 });
    expect(ok.stdout.trim()).toBe("1");
    const denied = spawnSync("/usr/bin/sandbox-exec", ["-p", lite, "/usr/bin/osascript", "-e", `read POSIX file "${userData}/local-policy.key"`], { encoding: "utf8", timeout: 20_000 });
    expect(denied.stdout).not.toContain("SECRET-KEY");
    expect(denied.status).not.toBe(0);
  });

  it("the executor won't take a quiet flag for a command that isn't an everyday hand-off", async () => {
    const r = await sh(exec(), `osascript -e 'do shell script "echo UNWRAPPED"'`, { quiet: true });
    expect(r.out).not.toContain("UNWRAPPED");
  });

  it("No limits: a private store reads inside the sandbox; without it, it's denied", async () => {
    const st = path.join(home, "Library", "SynapseTestStore");
    fs.mkdirSync(st, { recursive: true });
    fs.writeFileSync(path.join(st, "secret.txt"), "STANDIN-SECRET\n");
    const ex = exec({ testPrivateStores: [st] });
    expect((await sh(ex, `cat "${st}/secret.txt"`)).out).not.toContain("STANDIN-SECRET");
    expect((await sh(ex, `cat "${st}/secret.txt"`, { noLimits: true })).out).toContain("STANDIN-SECRET");
    // The app's data stays denied in No limits.
    fs.writeFileSync(path.join(userData, "x.txt"), "APPDATA");
    expect((await sh(ex, `f=x.txt; cat "${path.dirname(userData)}"/Syn*/$f`, { noLimits: true })).out).not.toContain("APPDATA");
  });

  it("a dev tool's PLAIN web page opens through the bridge; a query string and everything else don't cross", async () => {
    const recorder = path.join(home, "recorder");
    fs.writeFileSync(recorder, `#!/bin/sh\necho "$@" >> "${home}/opened.txt"\n`, { mode: 0o755 });
    const ex = exec({ openBinary: recorder });
    const first = await sh(ex, `true && open http://localhost:5173/ && "$BROWSER" 'https://example.invalid/docs?a=1'`, { openBridge: true });
    const opened = () => { try { return fs.readFileSync(path.join(home, "opened.txt"), "utf8").trim().split("\n").filter(Boolean).sort(); } catch { return []; } };
    // Only the plain URL crosses; the query-string one is refused by the bridge (fix round).
    await vi.waitFor(() => expect(opened(), first.out).toEqual(["http://localhost:5173/"]), { timeout: 5_000 });
    fs.writeFileSync(path.join(home, "run.command"), "#!/bin/sh\necho RAN\n", { mode: 0o755 });
    const r = await sh(ex, `true && open ./run.command; open -a Terminal; true`, { openBridge: true });
    await new Promise((res) => setTimeout(res, 300));
    expect(opened()).toEqual(["http://localhost:5173/"]);
    expect(r.out).toMatch(/only web pages/i);
  });

  it("without the bridge (Ask), the sandbox blocks the open as before", async () => {
    const recorder = path.join(home, "recorder2");
    fs.writeFileSync(recorder, `#!/bin/sh\necho "$@" >> "${home}/opened2.txt"\n`, { mode: 0o755 });
    await sh(exec({ openBinary: recorder }), "true && open http://localhost:5173/");
    expect(fs.existsSync(path.join(home, "opened2.txt"))).toBe(false);
  });

  it("the bridge leaves no temp folder behind", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("synapse-open-")).length;
    await sh(exec({ openBinary: "/usr/bin/true" }), "true && echo hi", { openBridge: true });
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("synapse-open-")).length).toBe(before);
  });
});
