import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { localBindTarget } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor, macExecEnv } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";

let dir: string;
let home: string;
let userData: string;
const key = Buffer.alloc(32, 7);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locsec-"));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lochome-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
});
const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData });
/** Ruling A: a Mac policy that knows the test home, with ~/W (the local root) added as an auto-run root. Final secfix
 *  round 3 (ruling 2): ~ itself can no longer be a root. */
const homedPolicy = () => {
  const p = new LocalPolicyStore(dir, () => 1000, key, { home: () => home, userData: () => userData });
  fs.mkdirSync(path.join(home, "W"), { recursive: true });
  p.update({ localRoot: path.join(home, "W"), addAutoRunRoot: path.join(home, "W") });
  return p;
};
const io = { output: () => {} };

describe("I3: the Mac's within() refuses the protected places", () => {
  it.each([
    [".ssh/authorized_keys"], ["Library/Keychains/login.keychain-db"], ["Library/LaunchAgents/x.plist"], [".zshrc"], [".bash_profile"],
    ["Library/Application Support/Synapse/computers.json"],
  ])("write-file / copy-from-box into %s is refused", async (p) => {
    await expect(exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: p, content: "x" }, io)).rejects.toThrow(/protected/);
    await expect(exec().run({ execId: "c", botId: "b", approvalId: null, op: "copy-from-box", path: p, boxPath: "/workspace/a" }, { ...io, readBox: async function* () { yield Buffer.from("x"); } })).rejects.toThrow(/protected/);
    expect(fs.existsSync(path.join(home, p))).toBe(false);
  });

  it("reads and copies of keys out of ~/.ssh are refused too; ordinary files work", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
    await expect(exec().run({ execId: "r", botId: "b", approvalId: null, op: "read-file", path: ".ssh/id_rsa" }, io)).rejects.toThrow(/protected/);
    await expect(exec().run({ execId: "c", botId: "b", approvalId: null, op: "copy-to-box", path: "~/.ssh/id_rsa", boxPath: "/workspace/k" }, { ...io, uploadBox: async () => {} })).rejects.toThrow(/protected/);
    await exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "notes/a.txt", content: "ok" }, io);
    expect(fs.readFileSync(path.join(home, "notes", "a.txt"), "utf8")).toBe("ok");
  });

  it("a symlink into a protected place is refused", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "innocent"));
    await expect(exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "innocent/authorized_keys", content: "x" }, io)).rejects.toThrow(/protected/);
  });
});

describe("I4: the Mac exec env is a minimal allowlist", () => {
  it("only HOME USER PATH LANG TERM SHELL TMPDIR BOT_AGENT are passed; the app's own env never reaches the command", async () => {
    process.env.SYNAPSE_TEST_SECRET = "hunter2";
    expect(Object.keys(macExecEnv({ ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1" })).sort()).toEqual(["BOT_AGENT", "HOME", "LANG", "PATH", "SHELL", "TERM", "USER", ...(process.env.TMPDIR ? ["TMPDIR"] : [])].sort());
    const out: string[] = [];
    await exec().run({ execId: "e", botId: "b", approvalId: null, op: "run-command", command: "env" }, { output: (_s, c) => out.push(c) });
    expect(out.join("")).not.toContain("SYNAPSE_TEST_SECRET");
    expect(out.join("")).toContain("BOT_AGENT=1");
  });
});

describe("I3: computers.json and local-tool-approvals.json are HMAC'd", () => {
  it("a tampered policy file is rejected (back to Ask), a good one is kept", () => {
    const p = new LocalPolicyStore(dir, () => 1000, key);
    p.update({ executionPolicy: "never" });
    expect(new LocalPolicyStore(dir, () => 1000, key).current().executionPolicy).toBe("never");
    const f = path.join(dir, "computers.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"never"', '"always"'));
    expect(new LocalPolicyStore(dir, () => 1000, key).current().executionPolicy).toBe("ask");
    fs.writeFileSync(f, JSON.stringify({ computers: [{ computerId: "x", label: "x", isCurrent: true, executionPolicy: "always", localRoot: "/" }] }));
    expect(new LocalPolicyStore(dir, () => 1000, key).current().executionPolicy).toBe("ask");
    expect(new LocalPolicyStore(dir, () => 1000, Buffer.alloc(32, 9)).current().executionPolicy).toBe("ask");
  });

  it("a forged approval file doesn't approve anything", () => {
    const p = new LocalPolicyStore(dir, () => 1000, key);
    const req = { execId: "e", botId: "b", approvalId: "forged", op: "run-command" as const, command: "ls" };
    fs.writeFileSync(path.join(dir, "local-tool-approvals.json"), JSON.stringify({ forged: { botId: "b", expiresAt: 9e15, bind: createHash("sha256").update(`run-command\0${localBindTarget(req)}`).digest("hex") } }));
    expect(p.check(req)).toMatchObject({ ok: false });
  });
});

describe("Minors: once-approvals bound to hash(op + target); Always is per-Bot + per-op; delivered requests don't re-run", () => {
  it("an Allow once for one command can't run a different command", async () => {
    const policy = new LocalPolicyStore(dir, () => 1000, key);
    const d = new LocalExecDaemon({ call: async () => ({ status: "allowed" }), policy, executor: exec(), heartbeatMs: 60_000 });
    await d.intercept("resolveLocalToolPermission", { id: "b", askId: "a1", choice: "once", action: "run-command", target: "ls ~/Documents" });
    expect(policy.check({ execId: "e", botId: "b", approvalId: "a1", op: "run-command", command: "rm -rf ~" })).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b", approvalId: "a1", op: "run-command", command: "ls ~/Documents" })).toEqual({ ok: true });
  });

  it("an Always answer never flips the whole Mac to Always allow", async () => {
    const policy = homedPolicy(); // ruling A: home is an auto-run root here
    const d = new LocalExecDaemon({ call: async () => ({ status: "always" }), policy, executor: exec(), heartbeatMs: 60_000 });
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "a2", choice: "always", action: "run-command", target: "brew update" });
    expect(policy.current().executionPolicy).toBe("ask");
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "run-command", command: "ls Documents" })).toEqual({ ok: true });
    expect(policy.check({ execId: "e", botId: "b2", approvalId: null, op: "run-command", command: "ls Documents" })).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "copy-from-box", path: "a", boxPath: "b" })).toMatchObject({ ok: false });
  });

  it("a request delivered before a restart is not run again", async () => {
    const policy = new LocalPolicyStore(dir, () => 1000, key);
    policy.update({ executionPolicy: "always", localRoot: home });
    const calls: [string, unknown][] = [];
    const mk = () => new LocalExecDaemon({ call: async (c, a) => { calls.push([c, a]); return {}; }, policy, executor: exec(), heartbeatMs: 60_000 });
    // Ruling A: a write under Always still needs its card's approval.
    policy.recordApproval("ap1", { botId: "b", expiresAt: 10_000, bind: bindHash("run-command", localBindTarget({ op: "run-command", command: "echo hi >> ran.txt" })) });
    const req = { execId: "once1", botId: "b", approvalId: "ap1", op: "run-command" as const, command: "echo hi >> ran.txt" };
    mk().onEvent({ channel: "local-exec", payload: req });
    await new Promise((r) => setTimeout(r, 300));
    mk().onEvent({ channel: "local-exec", payload: req });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.readFileSync(path.join(home, "ran.txt"), "utf8")).toBe("hi\n"); // the second delivery never reached the policy or the executor
    const answers = calls.filter(([c]) => c === "localExecDone").map(([, a]) => a);
    // The first delivery reports the real result; the second is answered with an error instead of
    // silence, so a host still waiting on that execId isn't left blocked for the rest of its life.
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ execId: "once1", exitCode: 0 });
    expect(answers[1]).toMatchObject({ execId: "once1", exitCode: null, error: expect.stringContaining("restarted") });
  });
});

describe("controller ruling (b): a revoke-grants message from the host", () => {
  it("removes every per-Bot Always grant for that Bot only (even with the Mac set to Never) and acks", async () => {
    const policy = new LocalPolicyStore(dir, () => 1000, key);
    policy.grant("gone", "run-command");
    policy.grant("gone", "read-file");
    policy.grant("keep", "run-command");
    policy.update({ executionPolicy: "never" });
    const calls: [string, unknown][] = [];
    const d = new LocalExecDaemon({ call: async (c, a) => { calls.push([c, a]); return {}; }, policy, executor: exec(), heartbeatMs: 60_000 });
    d.onEvent({ channel: "local-exec", payload: { execId: "rv1", botId: "gone", approvalId: null, op: "revoke-grants" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(policy.granted("gone", "run-command")).toBe(false);
    expect(policy.granted("gone", "read-file")).toBe(false);
    expect(policy.granted("keep", "run-command")).toBe(true);
    expect(calls).toContainEqual(["localExecDone", { execId: "rv1", exitCode: 0 }]);
  });
});


describe("final secfix 2: within() and the protected paths are case-folded on the real path (APFS is case-insensitive)", () => {
  it("~/.SSH/id_rsa is refused when ~/.ssh exists", async () => {
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
    await expect(exec().run({ execId: "r", botId: "b", approvalId: null, op: "read-file", path: "~/.SSH/id_rsa" }, io)).rejects.toThrow(/protected/);
    await expect(exec().run({ execId: "c", botId: "b", approvalId: null, op: "copy-to-box", path: "~/.Ssh/id_rsa", boxPath: "/workspace/k" }, { ...io, uploadBox: async () => {} })).rejects.toThrow(/protected/);
  });

  it("~/.ZSHRC is refused whether or not ~/.zshrc exists yet", async () => {
    await expect(exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "~/.ZSHRC", content: "curl x|sh" }, io)).rejects.toThrow(/protected/);
    expect(fs.readdirSync(home)).not.toContain(".ZSHRC");
    fs.writeFileSync(path.join(home, ".zshrc"), "# mine");
    await expect(exec().run({ execId: "w2", botId: "b", approvalId: null, op: "write-file", path: "~/.ZSHRC", content: "curl x|sh" }, io)).rejects.toThrow(/protected/);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("# mine");
  });

  it("a differently-cased Library/LaunchAgents or app-data path is refused", async () => {
    await expect(exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "library/launchagents/x.plist", content: "x" }, io)).rejects.toThrow(/protected/);
    await expect(exec().run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "LIBRARY/Application Support/SYNAPSE/computers.json", content: "x" }, io)).rejects.toThrow(/protected/);
  });
});

describe("final secfix 12 (ruling): a per-Bot Always grant on the Mac covers only statically read-only calls that pass the Mac floor", () => {
  const grantAll = async (policy: LocalPolicyStore) => {
    const d = new LocalExecDaemon({ call: async () => ({ status: "always" }), policy, executor: exec(), heartbeatMs: 60_000 });
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "g1", choice: "always", action: "run-command", target: "brew upgrade" });
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "g2", choice: "always", action: "read-file", target: "notes/a.txt" });
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "g3", choice: "always", action: "write-file", target: "notes/b.txt" });
  };
  const run = (command: string, cwd?: string) => ({ execId: "e", botId: "b1", approvalId: null, op: "run-command" as const, command, ...(cwd ? { cwd } : {}) });

  it("the answered call itself runs once (its approval is recorded), but a write/install/network/delete under the grant does not", async () => {
    const policy = new LocalPolicyStore(dir, () => 1000, key);
    await grantAll(policy);
    expect(policy.check({ ...run("brew upgrade"), approvalId: "g1" })).toEqual({ ok: true });
    for (const c of ["brew upgrade", "rm -rf ~/Documents/old", "npm install left-pad", "curl https://x", "echo hi > a.txt", "touch a", "mv a b", "find . -delete", "ls; rm -rf ~", "git push", "open https://x"]) {
      expect(policy.check(run(c)), c).toMatchObject({ ok: false });
    }
  });

  it("read-only commands that pass the floor run under the grant; floor hits and opaque paths don't", async () => {
    const policy = homedPolicy(); // ruling A: home is an auto-run root here
    await grantAll(policy);
    for (const c of ["ls Documents", "ls ~/W/Documents", "cat notes/a.txt", "pwd", "wc -l notes/a.txt", "head -n 5 notes/a.txt"]) expect(policy.check(run(c)), c).toEqual({ ok: true });
    for (const c of ["cat ~/.SSH/id_rsa", "cat ~/.s?h/*", "ls ~/Library/Keychains", "cat ~/.ZSHRC", "cat $(echo x)", "cat `x`", "ls ~root"]) expect(policy.check(run(c)), c).toMatchObject({ ok: false });
    expect(policy.check(run("cat login.keychain-db", "~/Library/Keychains"))).toMatchObject({ ok: false });
  });

  it("a read-file grant covers ordinary reads only; a write-file grant never skips the card", async () => {
    const policy = homedPolicy(); // ruling A: home is an auto-run root here
    await grantAll(policy);
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "read-file", path: "notes/a.txt" })).toEqual({ ok: true });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "read-file", path: "~/.SSH/id_rsa" })).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "copy-to-box", path: "notes/a.txt", boxPath: "a" })).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "write-file", path: "notes/b.txt", content: "x" })).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "copy-from-box", path: "notes/b.txt", boxPath: "a" })).toMatchObject({ ok: false });
  });
});

describe("final secfix round 2 (ruling A): Mac Always is an allowlist by location, on real paths", () => {
  const run = (command: string, cwd?: string, botId = "b1") => ({ execId: "e", botId, approvalId: null, op: "run-command" as const, command, ...(cwd ? { cwd } : {}) });
  const mk = () => new LocalPolicyStore(dir, () => 1000, key, { home: () => home, userData: () => userData });

  it("a new computer has no auto-run roots; computer-wide Always auto-runs nothing until a folder is added", () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, "Projects"));
    policy.update({ executionPolicy: "always", localRoot: home });
    expect(policy.current().autoRunRoots).toEqual([]);
    expect(policy.check(run("ls", "~/Projects"))).toMatchObject({ ok: false });
    policy.update({ addAutoRunRoot: path.join(home, "Projects") });
    expect(policy.current().autoRunRoots).toEqual([path.join(home, "Projects")]);
    expect(policy.check(run("ls", "~/Projects"))).toEqual({ ok: true });
    expect(policy.check(run("echo hi > x", "~/Projects"))).toMatchObject({ ok: false }); // a write still needs a card
    expect(policy.check(run("ls ~/Documents", "~/Projects"))).toMatchObject({ ok: false });
    policy.update({ removeAutoRunRoot: path.join(home, "Projects") });
    expect(policy.check(run("ls", "~/Projects"))).toMatchObject({ ok: false });
  });

  it("a per-Bot Always grant uses the same predicate", async () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, "Projects"));
    policy.update({ localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
    const d = new LocalExecDaemon({ call: async () => ({ status: "always" }), policy, executor: exec(), heartbeatMs: 60_000 });
    await d.intercept("resolveLocalToolPermission", { id: "b1", askId: "g1", choice: "always", action: "run-command", target: "ls" });
    expect(policy.check(run("cat a.txt", "~/Projects"))).toEqual({ ok: true });
    expect(policy.check(run("cat a.txt", "~/Projects", "b2"))).toMatchObject({ ok: false });
  });

  it("refuses roots that are /, under ~/Library, inside a dot-dir, or missing", () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, ".ssh"));
    for (const r of ["/", path.join(home, "Library"), path.join(home, ".ssh"), path.join(home, "nope")]) {
      policy.update({ addAutoRunRoot: r });
      expect(policy.current().autoRunRoots, r).toEqual([]);
    }
  });

  it("the review's probes go to a card on the Mac, including a symlink inside the root that points at ~/.ssh", () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
    fs.mkdirSync(path.join(home, "Library", "Keychains"), { recursive: true });
    fs.mkdirSync(path.join(home, "Projects"));
    fs.symlinkSync(path.join(home, ".ssh"), path.join(home, "Projects", "keys"));
    policy.update({ executionPolicy: "always", localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
    for (const [c, cwd] of [
      ["cat ~/.ſsh/id_rsa", "~"], ["ls ~/Library/Keychains", "~"], ["ls ~/Library//Keychains", "~"], ["ls ~/Library/./Keychains", "~"],
      ["ls Keychains", "~/Library/"], ["cat /U*/x/.s?h/id_rsa", "~"], ["cat $PWD/.s?h/id_rsa", "~"], ["cat \".s\"?h/id_rsa", "~"],
      ["cat ~/.aws/credentials", "~"], ["cat ~/.netrc", "~"], ["date 010112002030", "~"], ["cat Projects/keys/id_rsa", "~"], ["cat keys/id_rsa", "~/Projects"],
      ["cat Projects/KEYS/id_rsa", "~"],
    ] as const) expect(policy.check(run(c, cwd)), c).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "read-file", path: "Projects/keys/id_rsa" })).toMatchObject({ ok: false });
    expect(policy.check(run("ls Projects", "~"))).toMatchObject({ ok: false }); // ~ is not a root (secfix round 3)
    expect(policy.check(run("ls", "~/Projects"))).toEqual({ ok: true });
  });
});

describe("final secfix round 3 (ruling 2): an auto-run root is a strict subfolder of ~ (or of /Volumes/<name>)", () => {
  const mk = () => new LocalPolicyStore(dir, () => 1000, key, { home: () => home, userData: () => userData });
  const run = (command: string, cwd?: string) => ({ execId: "e", botId: "b1", approvalId: null, op: "run-command" as const, command, ...(cwd ? { cwd } : {}) });

  it("refuses ~, its ancestors and the system folders; accepts ~/Projects", () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, "Projects"));
    const vol = fs.readdirSync("/Volumes").map((v) => path.join("/Volumes", v));
    for (const r of [home, path.dirname(home), "/Users", "/private", "/var", "/private/var", "/Applications", "/opt", "/", "/Volumes", ...vol]) {
      policy.update({ addAutoRunRoot: r });
      expect(policy.current().autoRunRoots, r).toEqual([]);
    }
    policy.update({ addAutoRunRoot: path.join(home, "Projects") });
    expect(policy.current().autoRunRoots).toEqual([path.join(home, "Projects")]);
  });

  it("a stored root whose realpath no longer equals the stored value is ignored at check time", () => {
    const policy = mk();
    fs.mkdirSync(path.join(home, "Projects"));
    fs.writeFileSync(path.join(home, "Projects", "a.txt"), "a");
    policy.update({ executionPolicy: "always", localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
    expect(policy.check(run("cat a.txt", "~/Projects"))).toEqual({ ok: true });
    // swap the folder for a link to a folder the user never added (~/Documents)
    fs.mkdirSync(path.join(home, "Documents"));
    fs.writeFileSync(path.join(home, "Documents", "a.txt"), "TAX");
    fs.renameSync(path.join(home, "Projects"), path.join(home, "Projects.old"));
    fs.symlinkSync(path.join(home, "Documents"), path.join(home, "Projects"));
    expect(policy.check(run("cat a.txt", "~/Projects"))).toMatchObject({ ok: false });
    expect(policy.check({ execId: "e", botId: "b1", approvalId: null, op: "read-file", path: "Projects/a.txt" })).toMatchObject({ ok: false });
  });

  it("a stored root of ~ from an older build (computers.json) is ignored", () => {
    const policy = mk();
    policy.update({ executionPolicy: "always", localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
    const f = path.join(dir, "computers.json");
    // re-sign a tampered-by-old-build file the way the store would have written it
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { data: { computers: { autoRunRoots: string[] }[] } };
    raw.data.computers[0]!.autoRunRoots = [home];
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    fs.writeFileSync(f, JSON.stringify({ data: raw.data, mac: createHmac("sha256", key).update(`computers.json\0${JSON.stringify(raw.data)}`).digest("hex") }));
    expect(policy.current().autoRunRoots).toEqual([home]);
    expect(policy.check(run("ls", "~"))).toMatchObject({ ok: false });
  });
});
