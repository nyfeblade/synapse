import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalBridge } from "../../local/bridge";

const computer = { computerId: "mac", label: "Alex's MacBook", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex/W", home: "/Users/alex", autoRunRoots: ["/Users/alex/W"] };
let now = 0;
let ws: string;
beforeEach(() => {
  now = 1000;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-stuck-"));
});
const mkBridge = () => new LocalBridge({ hub: { publish: () => {} } as never, now: () => now, workspace: ws, idleMs: 50, stuckMs: 120 });
const settle = <T,>(p: Promise<T>, ms = 600): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

describe("a delivered-but-unanswered exec never hangs the Bot's tool call (concurrency)", () => {
  it("a read the Mac never answers ends in an error even while the Mac keeps heartbeating", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { done } = b.request({ botId: "b", approvalId: null, op: "read-file", path: "/Users/alex/W/notes.md" });
    now += 500; // past stuckMs, with the Mac still alive
    b.heartbeat("mac");
    expect(b.available()).toBe(true);
    await expect(settle(done)).resolves.toMatchObject({ exitCode: null, error: expect.stringContaining("didn't answer") });
  });

  it("a copy the Mac never answers ends the same way", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { done } = b.request({ botId: "b", approvalId: null, op: "copy-from-box", path: "/Users/alex/W/x", boxPath: "x" });
    now += 500;
    b.heartbeat("mac");
    await expect(settle(done)).resolves.toMatchObject({ exitCode: null });
  });

  it("a long, quiet ExternalShell on a live Mac is left alone (no regression)", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { done } = b.request({ botId: "b", approvalId: null, op: "run-command", command: "make -j8" });
    now += 5000;
    b.heartbeat("mac");
    await expect(settle(done, 300)).resolves.toBe("hung");
  });

  it("a finished exec is never re-answered, so a late duplicate cannot clobber its result", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { execId, done } = b.request({ botId: "b", approvalId: null, op: "read-file", path: "/Users/alex/W/a" });
    b.done(execId, { exitCode: 0, result: "contents" });
    b.done(execId, { exitCode: null, error: "stale duplicate" });
    await expect(done).resolves.toMatchObject({ exitCode: 0, result: "contents" });
    expect(b.result(execId, "b")).toMatchObject({ exitCode: 0, result: "contents" });
  });
});
