import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localBindTarget } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";

let dir: string;
let root: string;
let now = 1_000;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loc-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locroot-"));
  now = 1_000;
});
afterEach(() => {
  vi.restoreAllMocks();
});
/** The temp folder that holds `root`, standing in for ~ (final secfix round 3: an auto-run root is a strict subfolder of ~). */
const fakeHome = () => path.dirname(fs.realpathSync.native(root));

describe("LocalPolicyStore (LOC-02, LOC-05)", () => {
  it("registers the current computer on first use with Ask every time and the home root", () => {
    const p = new LocalPolicyStore(dir, () => now);
    const c = p.current();
    expect(c).toMatchObject({ isCurrent: true, executionPolicy: "ask", localRoot: os.homedir() });
    expect(c.label).toBe(os.hostname().replace(/\.(local|localdomain|lan|home|internal)$/i, "")); // new-user walk nit 30
    expect(fs.existsSync(path.join(dir, "computers.json"))).toBe(true);
  });

  it("an ask needs an approval id the coordinator recorded itself; each id works once and expires in 10 min", () => {
    const p = new LocalPolicyStore(dir, () => now);
    const req = { execId: "e1", botId: "b", approvalId: "a1", op: "run-command" as const, command: "ls" };
    expect(p.check(req)).toEqual({ ok: false, reason: expect.stringMatching(/not approved/) });
    p.recordApproval("a1", { botId: "b", expiresAt: now + 600_000, bind: bindHash("run-command", "ls") });
    expect(p.check(req)).toEqual({ ok: true });
    expect(p.check(req)).toMatchObject({ ok: false });
    p.recordApproval("a2", { botId: "b", expiresAt: now + 600_000, bind: bindHash("run-command", "ls") });
    now += 600_001;
    expect(p.check({ ...req, approvalId: "a2" })).toMatchObject({ ok: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "local-tool-retirements.json"), "utf8")).data.retired).toContain("a1");
  });

  it("Always allow needs no approval id for a read inside an auto-run root (ruling A); Never allow blocks everything", () => {
    const p = new LocalPolicyStore(dir, () => now, undefined, { home: fakeHome }); // secfix round 3: a root is a subfolder of ~
    p.update({ executionPolicy: "always", localRoot: root });
    expect(p.check({ execId: "e", botId: "b", approvalId: null, op: "run-command", command: "ls" })).toMatchObject({ ok: false }); // no roots yet
    p.update({ addAutoRunRoot: root });
    expect(p.check({ execId: "e", botId: "b", approvalId: null, op: "run-command", command: "ls" })).toEqual({ ok: true });
    expect(p.check({ execId: "e", botId: "b", approvalId: null, op: "run-command", command: "touch x" })).toMatchObject({ ok: false });
    p.update({ executionPolicy: "never" });
    expect(p.check({ execId: "e", botId: "b", approvalId: null, op: "read-file", path: "x" })).toMatchObject({ ok: false });
  });

  it("fsyncs the tmp file before renaming it into place (crash-safe writes)", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const p = new LocalPolicyStore(dir, () => now);
    p.update({ executionPolicy: "always" });
    expect(fsyncSpy).toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "computers.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "computers.json"), "utf8")).data.computers[0].executionPolicy).toBe("always");
  });
});

describe("LocalExecutor (LOC-01, LOC-07)", () => {
  it("runs commands in the root with BOT_AGENT=1 and streams output", async () => {
    const ex = new LocalExecutor({ root: () => root, userData: () => dir });
    const out: string[] = [];
    const r = await ex.run({ execId: "e1", botId: "b", approvalId: null, op: "run-command", command: "echo hi; echo $BOT_AGENT; pwd" }, { output: (_s, c) => out.push(c) });
    expect(r.exitCode).toBe(0);
    expect(out.join("")).toContain("hi\n1\n");
    expect(out.join("")).toContain(fs.realpathSync(root));
  });

  it("reads, lists and writes inside the root and refuses paths outside it", async () => {
    const ex = new LocalExecutor({ root: () => root, userData: () => dir });
    const io = { output: () => {} };
    await ex.run({ execId: "w", botId: "b", approvalId: null, op: "write-file", path: "notes/a.txt", content: "hello" }, io);
    expect((await ex.run({ execId: "r", botId: "b", approvalId: null, op: "read-file", path: "notes/a.txt" }, io)).result).toBe("hello");
    expect((await ex.run({ execId: "l", botId: "b", approvalId: null, op: "list-directory", path: "notes" }, io)).result).toBe("a.txt");
    await expect(ex.run({ execId: "x", botId: "b", approvalId: null, op: "read-file", path: "../../etc/passwd" }, io)).rejects.toThrow(/outside/);
  });

  it("refuses files over the transfer limit", async () => {
    fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(2048));
    const ex = new LocalExecutor({ root: () => root, userData: () => dir, maxBytes: 1024 });
    await expect(ex.run({ execId: "c", botId: "b", approvalId: null, op: "copy-to-box", path: "big.bin", boxPath: "/workspace/big.bin" }, { output: () => {}, uploadBox: async () => {} })).rejects.toThrow(/100 MiB/);
  });
});

describe("LocalExecDaemon", () => {
  it("registers, runs an SSE request under Always allow and reports output + done", async () => {
    const calls: [string, unknown][] = [];
    const policy = new LocalPolicyStore(dir, () => now, undefined, { home: fakeHome }); // secfix round 3: a root is a subfolder of ~
    policy.update({ executionPolicy: "always", localRoot: root, addAutoRunRoot: root });
    const d = new LocalExecDaemon({ call: async (c, a) => { calls.push([c, a]); return c === "localExecHeartbeat" ? { pending: [] } : {}; }, policy, executor: new LocalExecutor({ root: () => policy.current().localRoot, userData: () => dir }), heartbeatMs: 60_000 });
    await d.start();
    d.onEvent({ channel: "local-exec", payload: { execId: "e9", botId: "b", approvalId: null, op: "run-command", command: "echo ok" } });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls[0]![0]).toBe("registerLocalComputer");
    expect(calls.some(([c, a]) => c === "localExecOutput" && (a as { chunk: string }).chunk.includes("ok"))).toBe(true);
    expect(calls).toContainEqual(["localExecDone", { execId: "e9", exitCode: 0 }]);
    d.stop();
  });

  it("intercepts the user's Allow once and records the approval before forwarding it (LOC-05)", async () => {
    const calls: [string, unknown][] = [];
    const policy = new LocalPolicyStore(dir, () => now);
    const d = new LocalExecDaemon({ call: async (c, a) => { calls.push([c, a]); return { status: "allowed" }; }, policy, executor: new LocalExecutor({ root: () => root, userData: () => dir }), heartbeatMs: 60_000 });
    const r = await d.intercept("resolveLocalToolPermission", { id: "b", askId: "ask1", choice: "once", action: "run-command", target: "ls" });
    expect(r).toEqual({ handled: true, result: { status: "allowed" } });
    expect(policy.check({ execId: "e", botId: "b", approvalId: "ask1", op: "run-command", command: "ls" })).toEqual({ ok: true });
    await d.intercept("resolveLocalToolPermission", { id: "b", askId: "ask2", choice: "never" });
    expect(policy.current().executionPolicy).toBe("never");
    expect((await d.intercept("getLocalComputer", {})).handled).toBe(true);
    expect((await d.intercept("listAgents", {})).handled).toBe(false);
  });

  it("round-trips copy-from-box through the real readWorkspaceFile response shape ({ chunkBase64, eof })", async () => {
    const policy = new LocalPolicyStore(dir, () => now);
    policy.update({ executionPolicy: "always", localRoot: root });
    const content = "hello from the box";
    let served = false;
    const d = new LocalExecDaemon({
      call: async (c) => {
        if (c === "readWorkspaceFile") {
          if (served) return { chunkBase64: "", size: content.length, mime: "text/plain", eof: true };
          served = true;
          return { chunkBase64: Buffer.from(content, "utf8").toString("base64"), size: content.length, mime: "text/plain", eof: true };
        }
        return {};
      },
      policy,
      executor: new LocalExecutor({ root: () => policy.current().localRoot, userData: () => dir }),
      heartbeatMs: 60_000,
    });
    await d.start();
    // Ruling A: a copy onto the Mac under Always still carries its card's approval.
    policy.recordApproval("cfb-ok", { botId: "b", expiresAt: now + 60_000, bind: bindHash("write-file", localBindTarget({ op: "copy-from-box", boxPath: "/workspace/f.txt", path: "f.txt" })) });
    d.onEvent({ channel: "local-exec", payload: { execId: "cfb1", botId: "b", approvalId: "cfb-ok", op: "copy-from-box", boxPath: "/workspace/f.txt", path: "f.txt" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe(content);
    d.stop();
  });
});
