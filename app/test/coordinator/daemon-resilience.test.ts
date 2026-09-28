import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { LocalExecRequest } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";

let dir: string;
let root: string;
let now = 1_000;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "loc-res-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locroot-res-"));
  now = 1_000;
});
const fakeHome = () => path.dirname(fs.realpathSync.native(root));
const alwaysPolicy = () => {
  const p = new LocalPolicyStore(dir, () => now, undefined, { home: fakeHome });
  p.update({ executionPolicy: "always", localRoot: root, addAutoRunRoot: root });
  return p;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the local-exec daemon survives an unreachable host (concurrency)", () => {
  it("handle() never rejects when the gateway call fails mid-stream", async () => {
    const policy = alwaysPolicy();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const d = new LocalExecDaemon({
        call: async (c) => { if (c === "localExecHeartbeat") return { pending: [] }; throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }); },
        policy, executor: new LocalExecutor({ root: () => policy.current().localRoot }), heartbeatMs: 60_000,
      });
      d.onEvent({ channel: "local-exec", payload: { execId: "e1", botId: "b", approvalId: null, op: "run-command", command: "echo hi; sleep 0.4; echo bye" } } as never);
      await wait(900);
      d.stop();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);

  it("a policy denial whose ack fails does not reject either", async () => {
    const policy = new LocalPolicyStore(dir, () => now); // "ask": no approval id → denied
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const d = new LocalExecDaemon({
        call: async () => { throw new Error("host gone"); },
        policy, executor: new LocalExecutor({ root: () => root }), heartbeatMs: 60_000,
      });
      d.onEvent({ channel: "local-exec", payload: { execId: "e2", botId: "b", approvalId: null, op: "run-command", command: "ls" } } as never);
      await wait(200);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);

  it("answers a request the host is still waiting on but an earlier run of the app already took", async () => {
    const policy = alwaysPolicy();
    const req: LocalExecRequest = { execId: "e3", botId: "b", approvalId: null, op: "read-file", path: path.join(root, "x.txt") };
    // Stands in for the previous process: the id is on disk as delivered, but nothing is running it here.
    expect(policy.markDelivered(req.execId)).toBe(true);
    const calls: [string, unknown][] = [];
    const d = new LocalExecDaemon({
      call: async (c, a) => { calls.push([c, a]); return {}; },
      policy, executor: new LocalExecutor({ root: () => policy.current().localRoot }), heartbeatMs: 60_000,
    });
    d.onEvent({ channel: "local-exec", payload: req } as never);
    await wait(200);
    expect(calls.map(([c]) => c)).toEqual(["localExecDone"]);
    expect(calls[0]![1]).toMatchObject({ execId: "e3", exitCode: null });
  }, 20_000);

  it("answers a given request exactly once, however often the host re-offers it", async () => {
    const policy = new LocalPolicyStore(dir, () => now); // "ask" with no approval id: denied, answered at once
    const calls: [string, unknown][] = [];
    const d = new LocalExecDaemon({
      call: async (c, a) => { calls.push([c, a]); return {}; },
      policy, executor: new LocalExecutor({ root: () => root }), heartbeatMs: 60_000,
    });
    const req: LocalExecRequest = { execId: "e4", botId: "b", approvalId: null, op: "run-command", command: "ls" };
    d.onEvent({ channel: "local-exec", payload: req } as never);
    await wait(150);
    expect(calls.filter(([c]) => c === "localExecDone")).toHaveLength(1);
    d.onEvent({ channel: "local-exec", payload: req } as never); // the host's re-offer on the next heartbeat
    await wait(150);
    expect(calls.filter(([c]) => c === "localExecDone")).toHaveLength(1);
  }, 20_000);
});

describe("bug-log 129: a restarted host that forgot this Mac gets it back", () => {
  it("registers again when the heartbeat says the host doesn't know this computer", async () => {
    const policy = alwaysPolicy();
    const calls: string[] = [];
    let known = false;
    const d = new LocalExecDaemon({
      call: async (c) => {
        calls.push(c);
        if (c === "registerLocalComputer") { known = true; return {}; }
        if (c === "localExecHeartbeat") return known ? { pending: [] } : { pending: [], register: true };
        return {};
      },
      policy, executor: new LocalExecutor({ root: () => policy.current().localRoot }), heartbeatMs: 20,
    });
    await d.start();
    known = false; // the host restarted and lost the registration
    await wait(150);
    d.stop();
    expect(calls.filter((c) => c === "registerLocalComputer")).toHaveLength(2);
    expect(known).toBe(true);
  });
});
