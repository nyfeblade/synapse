import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalGate, safeReadFs } from "../../approvals/approval-gate";
import { scrubTokenShapes } from "../../secrets/token-shapes";
import { PendingWakes } from "../../background/pending-wakes";
import { canonicalPathInfo, ShellService } from "../../background/shells";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { HostConfig } from "../../config";
import { realInside, plainRealpaths } from "../../coding/sdk-child";
import { SseHub } from "../../gateway/sse-hub";
import { CircuitBreaker } from "../../review/circuit";
import { VerdictCache } from "../../review/cache";
import { ReviewLog } from "../../review/log";
import type { ModelReviewer } from "../../review/model-reviewer";
import { Reviewer } from "../../review/reviewer";
import { newSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { BOT_UID_MIN, botUserName } from "../../walls/bot-uid";
import { type FsQuery, HomeSnapshot, SnapshotFs, sudoFsQuery } from "../../walls/home-fs";
import { FakeUsers } from "../box/fake-users";
import { tmpConfig } from "../helpers";
import { execFileSync } from "node:child_process";
import { enrichShell } from "../../review/static";

/**
 * Bug 231 round 1 (security review of 3846054e): the fast path was void on the box. The gate's DevCommandFs was plain
 * fs as bothost, which gets EACCES inside every Bot's 0700 home, so every ~/code command went to the model. The gate
 * now reads the home AS the Bot through the root helper box/files/bot-fs-query, in one batch per decision, and fails
 * closed (model review) whenever the helper can't answer.
 */
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* best effort */ } } });

const me = { uid: process.getuid!(), gid: process.getgid!() };

/**
 * A Bot whose home H the test process CANNOT read (mode 000), exactly like bothost on the box. The files live in the
 * FakeUsers home R of the same account; the fake helper maps H <-> R and runs the REAL bot-fs-query script (its
 * account checks and its python worker) against R, as the box's sudo would run it against H.
 */
function homeSetup(o: { helper?: "real" | "none" | "down" } = {}) {
  const f = new FakeUsers();
  cleanups.push(() => f.cleanup());
  const base = tmpConfig();
  initLayout(base);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(base.dataRoot, "settings.json"));
  const homes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "homes-")));
  const cfg: HostConfig = { ...base, perBotUid: true, botHomes: homes };
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  expect(f.run("bot-user", ["ensure", id]).status).toBe(0);
  const u = botUserName(id);
  const R = f.p("home/bots", u);
  const app = path.join(R, "code", "app");
  fs.mkdirSync(path.join(app, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(app, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
  fs.writeFileSync(path.join(app, ".git", "hooks", "pre-commit.sample"), "");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  fs.mkdirSync(path.join(app, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(app, "node_modules", ".bin", "vitest"), "");
  fs.writeFileSync(path.join(app, "src", "a.ts"), "");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
  fs.mkdirSync(path.join(app, "lib"));
  fs.symlinkSync("/nonexistent-231", path.join(app, "lib", "dangle"));
  fs.symlinkSync("/etc", path.join(app, "lib", "escape"));
  const H = path.join(homes, u);
  fs.mkdirSync(H);
  fs.chmodSync(H, 0o000);
  cleanups.push(() => { fs.chmodSync(H, 0o700); fs.rmSync(homes, { recursive: true, force: true }); });
  expect(() => fs.readdirSync(H), "the test process can't read the Bot's home, like bothost").toThrow(/EACCES/);

  let helperCalls = 0;
  let helperMs = 0;
  const real: FsQuery = async (botId, ops) => {
    helperCalls++;
    const t0 = performance.now();
    const mapped = ops.map(([op, p]) => [op, p === H || p.startsWith(`${H}/`) ? R + p.slice(H.length) : p]);
    const r = f.run("bot-fs-query", [u, botId], {}, JSON.stringify({ ops: mapped }));
    helperMs += performance.now() - t0;
    if (r.status !== 0) return null;
    return (JSON.parse(r.stdout.split(R).join(H)) as { r: never[] }).r;
  };
  const homeFs: FsQuery | undefined = o.helper === "none" ? undefined : o.helper === "down" ? async () => { helperCalls++; return null; } : real;

  let modelCalls = 0;
  const modelInputs: string[] = [];
  const model: ModelReviewer = {
    review: async (input: unknown) => {
      modelCalls++;
      modelInputs.push(JSON.stringify(input));
      return { decision: "block", risk_tier: 2, floor_category: null, matched_ask_rule_ids: [], matched_allow_rule_ids: [], injection_suspected: false, confidence: 0.9, reason: "Needs a look.", proposed_allow_rule: null };
    },
  };
  let t = 0;
  const reviewer = new Reviewer({
    settings, model, cache: new VerdictCache(() => t), circuit: new CircuitBreaker(() => t),
    log: new ReviewLog(path.join(cfg.hostPrivate, "reviewer.log.jsonl"), () => t), now: () => t++, timeZone: () => "UTC", workspace: cfg.workspace,
  });
  const slot = newSlot({ botId: id, requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 0 });
  const gate = new ApprovalGate({ cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, onDeferredResolution: () => {},
    botAccount: () => ({ ...me, home: H }), homeFs, redact: (_b, text) => text.split("vault-secret-231").join("[secret:MY_KEY]") });
  let n = 0;
  let gateMs = 0;
  const run = async (command: string, wd = "~/code/app") => {
    const before = modelCalls, calls0 = helperCalls, h0 = helperMs, t0 = performance.now();
    const d = await gate.preToolUse(id, { toolName: "mcp__bot__Shell", input: { command, working_directory: wd }, toolUseId: `tu${n++}` });
    gateMs += performance.now() - t0 - (helperMs - h0);
    gate.expireAll(id, "session_end");
    return { d, fast: d.decision === "allow" && modelCalls === before, model: modelCalls - before, helper: helperCalls - calls0 };
  };
  return { run, H, R, f, u, id, cfg, app, modelInputs, helperMs: () => helperMs, helperCalls: () => helperCalls, gateMs: () => gateMs };
}

describe("bug 231 round 1: the fast path in ~/code, end to end through bot-fs-query", () => {
  it("control: with plain fs (bothost's view) a ~/code command can't be proven the Bot's own and goes to the model", async () => {
    const s = homeSetup({ helper: "none" });
    expect((await s.run("npm test")).fast).toBe(false);
  });

  it("through the helper the project's dev commands are fast, with one helper call per decision", async () => {
    const s = homeSetup();
    for (const cmd of ["npm test", "npm run typecheck", "npx vitest run", "npx vitest run src/a.ts", "tsc --noEmit", "git status", "git diff"]) {
      const r = await s.run(cmd);
      expect(r.fast, cmd).toBe(true);
      expect(r.helper, `${cmd}: helper calls`).toBe(1);
    }
    const n = s.helperCalls();
    process.stdout.write(`[bug 231] bot-fs-query (FakeUsers shims + local python): ${(s.helperMs() / n).toFixed(1)} ms per call, ${n} calls for 7 decisions; gate's own work around it ${(s.gateMs() / 7).toFixed(1)} ms per decision\n`);
  });

  it("fails closed when the helper is down: model review, never 'not there'", async () => {
    const s = homeSetup({ helper: "down" });
    const r = await s.run("npm test");
    expect(r.fast).toBe(false);
    expect(r.model).toBe(1);
  });

  it("a read through a link that doesn't resolve asks (item 4), and one that leads out of the tree isn't fast", async () => {
    const s = homeSetup();
    const dangling = await s.run("cat lib/dangle");
    expect(dangling.d.decision).not.toBe("allow");
    expect(dangling.model, "asks without a model call, like a credential read").toBe(0);
    expect(dangling.d.decision === "deny" || dangling.d.decision === "ask" ? dangling.d.reason : "").toMatch(/link that couldn't be checked/);
    expect((await s.run("cat lib/escape/hosts")).fast).toBe(false);
  });

  it("a cwd inside the home that can't be resolved as the Bot is never judged as its raw text (item 3)", async () => {
    const s = homeSetup();
    const r = await s.run("npm test", "~/code/ghost");
    expect(r.fast).toBe(false);
  });

  it("a workspace command makes no helper call at all", async () => {
    const s = homeSetup();
    expect((await s.run("ls", "/tmp")).helper).toBe(0);
  });
});

const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

describe("bug 231 round 2 (B1): a script's head never carries a credential into the reviewer prompt", () => {
  it("a script that is a link to ~/.config/gh/hosts.yml is denied as unbound; nothing reaches the reviewer", async () => {
    const s = homeSetup();
    fs.mkdirSync(path.join(s.R, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(s.R, ".config", "gh", "hosts.yml"), `github.com:\n  oauth_token: ${TOKEN}\n`);
    fs.symlinkSync("../../.config/gh/hosts.yml", path.join(s.app, "run.sh"));
    const r = await s.run("bash run.sh");
    expect(r.d.decision, "bug 71 ruling: a refused read of an existing script is an attack signal: denied").toBe("deny");
    expect(r.model).toBe(0);
    expect(s.modelInputs.join("")).not.toContain(TOKEN);
  });

  it("a link on an intermediate folder is denied too", async () => {
    const s = homeSetup();
    fs.mkdirSync(path.join(s.R, "stash"));
    fs.writeFileSync(path.join(s.R, "stash", "x.sh"), `echo ${TOKEN}\n`);
    fs.symlinkSync("../../stash", path.join(s.app, "tools"));
    const r = await s.run("bash tools/x.sh");
    expect(r.d.decision, "bug 71 ruling: a refused read of an existing script is an attack signal: denied").toBe("deny");
    expect(s.modelInputs.join("")).not.toContain(TOKEN);
  });

  it("a hard link to a secret under a script name is denied", async () => {
    const s = homeSetup();
    fs.mkdirSync(path.join(s.R, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(s.R, ".config", "gh", "hosts.yml"), `oauth_token: ${TOKEN}\n`);
    fs.linkSync(path.join(s.R, ".config", "gh", "hosts.yml"), path.join(s.app, "h.sh"));
    const r = await s.run("bash h.sh");
    expect(r.d.decision, "bug 71 ruling: a refused read of an existing script is an attack signal: denied").toBe("deny");
    expect(s.modelInputs.join("")).not.toContain(TOKEN);
  });

  it("in /workspace, a script that is a link into the host's private folder is denied (predates bug 231)", async () => {
    const s = homeSetup();
    fs.mkdirSync(s.cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(path.join(s.cfg.hostPrivate, "leak.sh"), `echo ${TOKEN}\n`);
    const wsApp = path.join(s.cfg.workspace, "app");
    fs.mkdirSync(wsApp, { recursive: true });
    fs.symlinkSync(path.join(s.cfg.hostPrivate, "leak.sh"), path.join(wsApp, "run.sh"));
    const r = await s.run("bash run.sh", wsApp);
    expect(r.d.decision, "bug 71 ruling: a refused read of an existing script is an attack signal: denied").toBe("deny");
    expect(s.modelInputs.join("")).not.toContain(TOKEN);
    expect(safeReadFs(s.cfg)(path.join(wsApp, "run.sh"))).toBeNull();
    fs.writeFileSync(path.join(wsApp, "ok.sh"), "echo hi\n");
    expect(safeReadFs(s.cfg)(path.join(wsApp, "ok.sh"))).toBe("echo hi\n");
  });

  it("a token-shaped string or a vault secret in a real script's head is redacted before the reviewer sees it", async () => {
    const s = homeSetup();
    fs.writeFileSync(path.join(s.app, "deploy.sh"), `curl -H "Authorization: token ${TOKEN}" https://api.github.com\nexport K=vault-secret-231\n`);
    const r = await s.run("bash deploy.sh");
    expect(r.model, "reviewed by the model").toBe(1);
    const seen = s.modelInputs.join("");
    expect(seen).toContain("[redacted]");
    expect(seen).toContain("[secret:MY_KEY]");
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain("vault-secret-231");
    expect(scrubTokenShapes(`a ${TOKEN} b sk-ant-${"x".repeat(30)} AKIAABCDEFGHIJKLMNOP`)).toBe("a [redacted] b [redacted] [redacted]");
  });
});

describe("bug 231 round 3: safeReadFs has no check-then-read race and never blocks", () => {
  function ws() {
    const cfg = tmpConfig();
    initLayout(cfg);
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(path.join(cfg.hostPrivate, "leak.sh"), `echo ${TOKEN}\n`);
    fs.mkdirSync(path.join(cfg.hostPrivate, "dd"));
    fs.writeFileSync(path.join(cfg.hostPrivate, "dd", "ok.sh"), `echo ${TOKEN}\n`);
    const app = fs.realpathSync(cfg.workspace) + "/app";
    fs.mkdirSync(path.join(app, "d"), { recursive: true });
    fs.writeFileSync(path.join(app, "ok.sh"), "echo fine\n");
    fs.writeFileSync(path.join(app, "d", "ok.sh"), "echo fine\n");
    return { cfg, app };
  }

  it("a file swapped for a link into the host's private folder after the check is not read", () => {
    const { cfg, app } = ws();
    const read = safeReadFs(cfg, { afterCheck: (real) => { fs.unlinkSync(real); fs.symlinkSync(path.join(cfg.hostPrivate, "leak.sh"), real); } });
    expect(read(path.join(app, "ok.sh"))).toBeNull();
  });

  it("a folder on the way swapped for a link after the check is not read either", () => {
    const { cfg, app } = ws();
    const read = safeReadFs(cfg, { afterCheck: () => { fs.renameSync(path.join(app, "d"), path.join(app, "d.old")); fs.symlinkSync(path.join(cfg.hostPrivate, "dd"), path.join(app, "d")); } });
    const got = read(path.join(app, "d", "ok.sh"));
    expect(got === null || !got.includes(TOKEN)).toBe(true);
    expect(got).toBeNull();
  });

  it("a FIFO, there from the start or swapped in after the check, is refused without blocking", () => {
    const { cfg, app } = ws();
    execFileSync("mkfifo", [path.join(app, "f.sh")]);
    const t0 = Date.now();
    expect(safeReadFs(cfg)(path.join(app, "f.sh"))).toBeNull();
    const read = safeReadFs(cfg, { afterCheck: (real) => { fs.unlinkSync(real); execFileSync("mkfifo", [real]); } });
    expect(read(path.join(app, "ok.sh"))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("reads only /workspace, box's ~/code and the plain system folders (an allowlist)", () => {
    const { cfg, app } = ws();
    expect(safeReadFs(cfg)(path.join(app, "ok.sh"))).toBe("echo fine\n");
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "outside-")));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.writeFileSync(path.join(tmp, "x.sh"), "echo x\n");
    expect(safeReadFs(cfg)(path.join(tmp, "x.sh"))).toBeNull();
    const sys = ["/etc/hosts", "/usr/share/misc/ascii", "/usr/share/dict/README"].find((f) => {
      try { const r = fs.realpathSync(f); const st = fs.lstatSync(r); return st.nlink === 1 && st.size < 1_000_000 && ["/usr/", "/etc/"].some((x) => r.startsWith(x)); } catch { return false; }
    });
    if (sys) expect(safeReadFs(cfg)(sys), sys).not.toBeNull();
  });

  it("a token glued to an identifier is scrubbed, and a token cut at the 8000-char head is never half-shown", () => {
    expect(scrubTokenShapes(`MY_${TOKEN}_suffix`)).toBe("MY_[redacted]_suffix");
    expect(scrubTokenShapes(`x_sk-ant-${"a".repeat(30)}`)).toBe("x_[redacted]");
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cut-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "long.sh"), `${"a".repeat(7989)}\n${TOKEN}\n`);
    const e = enrichShell("bash long.sh", { cwd: dir, readFile: (f) => fs.readFileSync(f, "utf8") });
    expect(e.enrichment!.head).not.toContain("ghp_");
  });
});

describe("bug 231 round 1: canonicalPath never passes an unreadable path through as verified (item 3)", () => {
  it("EACCES is unverifiable; ENOENT keeps its text; a resolver's null is unverifiable", () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canon-")));
    const locked = path.join(d, "locked");
    fs.mkdirSync(path.join(locked, "in"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    cleanups.push(() => { fs.chmodSync(locked, 0o700); fs.rmSync(d, { recursive: true, force: true }); });
    expect(canonicalPathInfo("/workspace", path.join(locked, "in"))).toEqual({ path: path.join(locked, "in"), verified: false });
    expect(canonicalPathInfo("/workspace", path.join(d, "missing"))).toEqual({ path: path.join(d, "missing"), verified: true });
    expect(canonicalPathInfo("/workspace", "/home/bots/x/code", () => null).verified).toBe(false);
    expect(canonicalPathInfo("/workspace", "/home/bots/x/code", () => "/home/bots/x/code")).toEqual({ path: "/home/bots/x/code", verified: true });
  });
});

describe("bug 231 round 1: the Shell never runs in a home folder it couldn't resolve as the Bot (item 3)", () => {
  it("resolves ~/code through the helper, and refuses when the helper can't answer", async () => {
    const base = tmpConfig();
    initLayout(base);
    const cfg: HostConfig = { ...base, perBotUid: true, botHomes: "/home/bots" };
    const started: string[] = [];
    const spawner = { start: async (_id: string, cwd: string) => { started.push(cwd); throw new Error("stop here"); }, stop: async () => {}, status: async () => "stopped" as const };
    const mk = (realAsBot: (b: string, p: string[]) => Promise<(string | null)[] | null>) => new ShellService({
      cfg, spawner, pending: new PendingWakes(path.join(cfg.hostPrivate, "pw.json"), () => 0), revivals: { complete: () => {} } as never,
      hub: new SseHub(), envInputs: () => ({}), enqueueHidden: () => {}, realAsBot,
    });
    const home = `/home/bots/${botUserName("b1")}`;
    const down = await mk(async () => null).run("b1", { command: "ls", working_directory: "~/code/app" });
    expect(down.isError).toBe(true);
    expect(down.text).toMatch(/couldn't check the folder/);
    expect(started).toEqual([]);
    await mk(async () => [`${home}/code/app`]).run("b1", { command: "ls", working_directory: "~/code/app" }).catch(() => null);
    expect(started, "resolved as the Bot, then started there").toEqual([`${home}/code/app`]);
  });
});

describe("bug 231 round 1: the snapshot fs never turns a miss into 'not there'", () => {
  it("strict mode throws on anything the helper didn't answer or couldn't read; paths outside the home use plain fs", () => {
    const snap = new HomeSnapshot("/home/bots/bot-aaaaaaaaaaaa");
    snap.add("lstat", "/home/bots/bot-aaaaaaaaaaaa/code/x", { err: true });
    snap.add("read", "/home/bots/bot-aaaaaaaaaaaa/code/big.js", { big: true });
    snap.add("ls", "/home/bots/bot-aaaaaaaaaaaa/code/many", { n: [], more: true });
    const base = { exists: () => true, readFile: () => "plain", realpath: (p: string) => p };
    const s = new SnapshotFs(snap, base, "strict");
    expect(() => s.stat("/home/bots/bot-aaaaaaaaaaaa/code/y")).toThrow(/miss/);
    expect(() => s.stat("/home/bots/bot-aaaaaaaaaaaa/code/x")).toThrow(/miss/);
    expect(() => s.readFile("/home/bots/bot-aaaaaaaaaaaa/code/big.js")).toThrow(/miss/);
    expect(() => s.list("/home/bots/bot-aaaaaaaaaaaa/code/many")).toThrow(/miss/);
    expect(s.readFile("/workspace/x")).toBe("plain");
    const rec = new SnapshotFs(snap, base, "record");
    expect(rec.stat("/home/bots/bot-aaaaaaaaaaaa/code/y")).toBeNull();
    expect(rec.misses).toEqual([["lstat", "/home/bots/bot-aaaaaaaaaaaa/code/y"]]);
  });

  it("the box's FsQuery is one sudo call to the helper, with the request on stdin, and fails closed on an error", async () => {
    const seen: unknown[] = [];
    const cfg = { perBotUid: true, botHomes: "/home/bots" };
    const ok = sudoFsQuery(cfg, async (file, args, o) => { seen.push([file, args, o?.input?.toString()]); return { code: 0, stdout: Buffer.from('{"r":[null]}'), stderr: "" }; });
    expect(await ok("b1", [["lstat", "/home/bots/x/code"]])).toEqual([null]);
    expect(seen).toEqual([["sudo", ["-n", "/usr/local/libexec/bot-fs-query", botUserName("b1"), "b1"], '{"ops":[["lstat","/home/bots/x/code"]]}']]);
    const bad = sudoFsQuery(cfg, async () => ({ code: 126, stdout: Buffer.from(""), stderr: "no" }));
    expect(await bad("b1", [["lstat", "/home/bots/x/code"]])).toBeNull();
    const short = sudoFsQuery(cfg, async () => ({ code: 0, stdout: Buffer.from('{"r":[]}'), stderr: "" }));
    expect(await short("b1", [["lstat", "/home/bots/x/code"]]), "a wrong-length answer is refused").toBeNull();
  });
});

describe("bug 231 round 1: box/files/bot-fs-query", () => {
  const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";
  const B = "7a7a7a7a-1111-4222-8333-444455556666";
  function helper() {
    const f = new FakeUsers();
    cleanups.push(() => f.cleanup());
    expect(f.run("bot-user", ["ensure", A]).status).toBe(0);
    expect(f.run("bot-user", ["ensure", B]).status).toBe(0);
    const home = f.p("home/bots", botUserName(A));
    const q = (ops: unknown, o: { u?: string; id?: string; env?: Record<string, string> } = {}) =>
      f.run("bot-fs-query", [o.u ?? botUserName(A), o.id ?? A], o.env ?? {}, JSON.stringify({ ops }));
    return { f, home, q };
  }

  it("answers lstat, realpath, ls and read as the Bot's own uid, with an empty environment", () => {
    const { f, home, q } = helper();
    fs.writeFileSync(path.join(home, "code", "package.json"), '{"a":1}');
    fs.symlinkSync("package.json", path.join(home, "code", "link.json"));
    f.clearCalls();
    const r = q([["lstat", `${home}/code`], ["realpath", `${home}/code/link.json`], ["ls", `${home}/code`], ["read", `${home}/code/package.json`], ["read", `${home}/code/sub/package.json`]]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout).r;
    expect(out[0]).toMatchObject({ u: me.uid, l: false });
    expect(out[1]).toBe(fs.realpathSync(path.join(home, "code", "package.json")));
    expect(out[2].n.map((e: unknown[]) => e[0])).toEqual(["link.json", "package.json"]);
    expect(out[2].n[0][1].l).toBe(true);
    expect(out[3]).toEqual({ t: '{"a":1}' });
    expect(out[4]).toBeNull();
    const sp = f.calls().find((c) => c.cmd === "setpriv")!.args;
    expect(sp.slice(0, 4)).toEqual([`--reuid=${BOT_UID_MIN}`, `--regid=${BOT_UID_MIN}`, "--init-groups", "--pdeathsig=KILL"]);
    expect(sp.slice(5, 9)).toEqual(["/usr/bin/env", "-i", "/usr/bin/python3", "-I"]);
  });

  it("never follows the caller's environment (a planted sitecustomize or startup file never runs)", () => {
    const { f, home, q } = helper();
    const evil = f.p("evil");
    fs.mkdirSync(evil);
    const marker = f.p("ran");
    fs.writeFileSync(path.join(evil, "sitecustomize.py"), `open(${JSON.stringify(marker)}, "w").write("x")\n`);
    fs.writeFileSync(path.join(evil, "startup.py"), `open(${JSON.stringify(marker)}, "w").write("x")\n`);
    const r = q([["lstat", `${home}/code`]], { env: { PYTHONPATH: evil, PYTHONSTARTUP: path.join(evil, "startup.py"), PYTHONINSPECT: "1", PYTHONHOME: evil } });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses another Bot's account, a name that isn't a Bot account, and any caller but bothost", () => {
    const { f, q } = helper();
    f.clearCalls();
    expect(q([], { u: botUserName(B) }).status, "B's account named with A's id").toBe(126);
    for (const u of ["box", "root", "bothost", "bot-../../x", "bot-ABC"]) expect(q([], { u }).status, u).toBe(126);
    expect(q([], { env: { SUDO_USER: "box" } }).status).toBe(126);
    expect(q([], { id: "a/b" }).status).toBe(126);
    expect(f.calls().some((c) => c.cmd === "setpriv")).toBe(false);
  });

  it("refuses relative paths, . and .. parts, and anything outside the Bot's own home", () => {
    const { f, home, q } = helper();
    const other = f.p("home/bots", botUserName(B));
    for (const p of ["code", `${home}/code/../../${botUserName(B)}`, `${home}/./code`, `${home}//code`, `${other}/code`, "/etc/passwd", `${home}x/code`]) {
      const r = q([["lstat", p]]);
      expect(r.status, p).not.toBe(0);
      expect(r.stdout, p).toBe("");
    }
    expect(q([["write", `${home}/code/x`]]).status, "no op but the four reads").not.toBe(0);
    expect(q(Array.from({ length: 4001 }, () => ["lstat", `${home}/code`])).status, "at most 4000 ops").not.toBe(0);
  });

  it("reads only small config and script files, and says when one is too big", () => {
    const { home, q } = helper();
    fs.writeFileSync(path.join(home, "code", "secret.txt"), "s");
    fs.writeFileSync(path.join(home, "code", "big.js"), "x".repeat(70_000));
    fs.writeFileSync(path.join(home, "code", ".npmrc"), "//registry:_authToken=x");
    fs.writeFileSync(path.join(home, "code", "config"), "x");
    fs.mkdirSync(path.join(home, "code", ".git"));
    fs.writeFileSync(path.join(home, "code", ".git", "config"), "[core]\n");
    const out = JSON.parse(q([["read", `${home}/code/secret.txt`], ["read", `${home}/code/big.js`], ["read", `${home}/.claude`],
      ["read", `${home}/code/.npmrc`], ["read", `${home}/code/config`], ["read", `${home}/code/.git/config`]]).stdout).r;
    expect(out).toEqual([{ denied: true }, { big: true }, { denied: true }, { denied: true }, { denied: true }, { t: "[core]\n" }]);
  });

  it("round 2 (B1): never reads through a link (final or intermediate), a hard link, a dotted folder or a credential name", () => {
    const { home, q } = helper();
    fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), `oauth_token: ${TOKEN}`);
    fs.writeFileSync(path.join(home, ".config", "gh", "x.sh"), `echo ${TOKEN}`);
    fs.symlinkSync("../.config/gh/hosts.yml", path.join(home, "code", "run.sh"));
    fs.symlinkSync("../.config/gh", path.join(home, "code", "tools"));
    fs.linkSync(path.join(home, ".config", "gh", "hosts.yml"), path.join(home, "code", "h.sh"));
    fs.writeFileSync(path.join(home, "code", "id_rsa.sh"), "x");
    const r = q([["read", `${home}/code/run.sh`], ["read", `${home}/code/tools/x.sh`], ["read", `${home}/code/h.sh`], ["read", `${home}/.config/gh/x.sh`]]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).r).toEqual([{ denied: true }, { denied: true }, { denied: true }, { denied: true }]);
    expect(r.stdout).not.toContain(TOKEN);
  });

  it("round 2: realpath says unreadable ({err}) apart from not there (null)", () => {
    const { home, q } = helper();
    fs.mkdirSync(path.join(home, "code", "locked", "in"), { recursive: true });
    fs.chmodSync(path.join(home, "code", "locked"), 0o000);
    cleanups.push(() => fs.chmodSync(path.join(home, "code", "locked"), 0o700));
    const out = JSON.parse(q([["realpath", `${home}/code/locked/in`], ["realpath", `${home}/code/nope`]]).stdout).r;
    expect(out).toEqual([{ err: true }, null]);
  });
});

describe("bug 231 round 1: a coding agent's Write/Edit is checked by real path (item 5)", () => {
  it("a link in the worktree can't carry a write out of it; new files and plain paths are fine", async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-")));
    cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
    const wt = path.join(d, "wt");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.mkdirSync(path.join(d, "outside"));
    fs.symlinkSync("../outside", path.join(wt, "evil"));
    fs.symlinkSync("../outside/x.txt", path.join(wt, "evil-file"));
    expect(await realInside(plainRealpaths, "b", wt, "src/a.ts")).toBe(true);
    expect(await realInside(plainRealpaths, "b", wt, "src/new/deeper/a.ts")).toBe(true);
    expect(await realInside(plainRealpaths, "b", wt, "evil/x.txt")).toBe(false);
    expect(await realInside(plainRealpaths, "b", wt, "evil/new/x.txt")).toBe(false);
    expect(await realInside(plainRealpaths, "b", wt, "evil-file")).toBe(false);
    expect(await realInside(plainRealpaths, "b", wt, "../outside/x.txt")).toBe(false);
    expect(await realInside(async () => null, "b", wt, "src/a.ts"), "unresolvable = outside").toBe(false);
    fs.symlinkSync("/nonexistent-231/x", path.join(wt, "dangle"));
    expect(await realInside(plainRealpaths, "b", wt, "dangle"), "a dangling link would create its target outside").toBe(false);
  });
});

describe("bug 231 round 1: reviewer F4 names ~/code for recursive deletes too (item 2)", () => {
  it("says (even inside /workspace or ~/code)", () => {
    expect(fs.readFileSync(path.resolve(__dirname, "../../prompts/orig/reviewer.md"), "utf8")).toContain("(even inside /workspace or ~/code)");
  });
});

