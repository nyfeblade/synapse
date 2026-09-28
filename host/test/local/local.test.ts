import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { EgressCounter } from "../../local/egress";
import { createLocalTools } from "../../local/local-tools";

const computer = { computerId: "mac", label: "Alex's MacBook", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex/W", home: "/Users/alex", autoRunRoots: ["/Users/alex/W"] }; // ruling A: ~/W (the local root) is an auto-run root in these tests (secfix round 3: ~ itself can't be one)
let now = 0;
let ws: string;
let published: { channel: string; payload: unknown }[];
let entries: Map<string, unknown>;
const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e), updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
const slot = () => ({ turnNo: 2, nextSendK: 0, requestId: "req_9", segment: 0 }) as never;
beforeEach(() => {
  now = 1000;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  published = [];
  entries = new Map();
});
const mkBridge = () => new LocalBridge({ hub: { publish: (e: { channel: string; payload: unknown }) => published.push(e) } as never, now: () => now, workspace: ws, idleMs: 50 });

describe("classification (LOC-03: Auto-review first)", () => {
  it("routes local tools to the host_shell surface", () => {
    const c = classifyTool({ toolName: "mcp__bot__ExternalShell", input: { command: "brew upgrade" }, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host" });
    expect(c).toMatchObject({ surface: "host_shell", command: "brew upgrade", target: { action: "shell", arguments: { surface: "local_computer" } } });
    expect(classifyTool({ toolName: "mcp__bot__AwaitExternalShell", input: {}, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/h" }).surface).toBeNull();
  });
});

describe("LocalBridge (LOC-06, LOC-07)", () => {
  it("is unavailable without a heartbeat in 30 s", () => {
    const b = mkBridge();
    expect(b.available()).toBe(false);
    b.register(computer);
    b.heartbeat("mac");
    expect(b.available()).toBe(true);
    now += 30_001;
    expect(b.available()).toBe(false);
  });

  it("publishes requests, re-delivers them on heartbeat, collects output and completion", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { execId, done } = b.request({ botId: "b", approvalId: null, op: "run-command", command: "ls" });
    expect(published[0]).toMatchObject({ channel: "local-exec", payload: { execId, op: "run-command" } });
    expect(b.heartbeat("mac").pending.map((p) => p.execId)).toEqual([execId]);
    b.output(execId, "stdout", "a\n");
    b.done(execId, { exitCode: 0 });
    await expect(done).resolves.toEqual({ exitCode: 0, output: "a\n" });
  });

  it("scopes outputSoFar/isRunning/result to the requesting botId (no cross-bot exec reads)", async () => {
    const b = mkBridge();
    b.register(computer);
    b.heartbeat("mac");
    const { execId, done } = b.request({ botId: "owner", approvalId: null, op: "run-command", command: "ls" });
    b.output(execId, "stdout", "secret\n");
    expect(b.outputSoFar(execId, "owner")).toBe("secret\n");
    expect(b.outputSoFar(execId, "intruder")).toBe("");
    expect(b.isRunning(execId, "owner")).toBe(true);
    expect(b.isRunning(execId, "intruder")).toBe(false);
    b.done(execId, { exitCode: 0 });
    await done;
    expect(b.result(execId, "owner")).toEqual({ exitCode: 0, output: "secret\n" });
    expect(b.result(execId, "intruder")).toBeNull();
  });

  it("uploads land inside /workspace only; workspace reads are chunked", () => {
    const b = mkBridge();
    const { execId } = b.request({ botId: "b", approvalId: null, op: "copy-to-box", path: "x", boxPath: path.join(ws, "in", "x.txt") });
    b.upload(execId, 0, Buffer.from("hello").toString("base64"), true);
    expect(fs.readFileSync(path.join(ws, "in", "x.txt"), "utf8")).toBe("hello");
    const bad = b.request({ botId: "b", approvalId: null, op: "copy-to-box", path: "x", boxPath: "/etc/passwd" });
    expect(() => b.upload(bad.execId, 0, "", true)).toThrow(/workspace/);
    expect(b.readWorkspaceFile(path.join(ws, "in", "x.txt"), 1, 3)).toEqual({ bytesBase64: Buffer.from("ell").toString("base64"), eof: false, size: 5 });
  });
});

describe("LocalAsks (LOC-04)", () => {
  it("posts the first-time card, resolves Allow once, and expires after 10 min", async () => {
    const asks = new LocalAsks({ bots, now: () => now, ttlMs: 50 });
    const p = asks.ask("b", slot(), { action: "run-command", target: "brew upgrade" });
    const card = [...entries.values()][0] as { id: string; message: { card: { askId: string; status: string } } };
    expect(card.message.card).toMatchObject({ kind: "local-tool-permission", status: "pending", target: "brew upgrade" });
    expect(asks.resolve("b", card.message.card.askId, "once")).toBe("allowed");
    await expect(p).resolves.toMatchObject({ outcome: "allowed" });
    expect((entries.get(card.id) as { message: { card: { status: string } } }).message.card.status).toBe("allowed");
    const late = asks.ask("b", slot(), { action: "read-file", target: "~/x" });
    await expect(late).resolves.toMatchObject({ outcome: "expired" });
  });
});

describe("local tools", () => {
  it("machine unavailable → LOC-06 text; Never → user-only text", async () => {
    const b = mkBridge();
    const tools = createLocalTools({ botId: "b", slot, bridge: b, asks: new LocalAsks({ bots, now: () => now }), now: () => now });
    const shell = tools.find((t) => t.name === "ExternalShell")!;
    expect((await shell.handler({ command: "ls" })).text).toContain("isn't connected at the moment");
    b.register({ ...computer, executionPolicy: "never" });
    b.heartbeat("mac");
    expect((await shell.handler({ command: "ls" })).text).toBe("Local execution is set to Never allow. Only the user can change this in Settings → Computer.");
  });

  it("Always allow runs without a card and returns the output", async () => {
    const b = mkBridge();
    b.register({ ...computer, executionPolicy: "always" });
    b.heartbeat("mac");
    const tools = createLocalTools({ botId: "b", slot, bridge: b, asks: new LocalAsks({ bots, now: () => now }), now: () => now });
    const run = tools.find((t) => t.name === "ExternalShell")!.handler({ command: "echo hi", block_ms: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    const req = published.at(-1)!.payload as { execId: string; approvalId: string | null };
    expect(req.approvalId).toBeNull();
    b.output(req.execId, "stdout", "hi\n");
    b.done(req.execId, { exitCode: 0 });
    expect((await run).text).toBe("hi\n\n[exit code 0]");
  });

  it("AwaitExternalShell refuses to read another Bot's exec, even if the id leaks", async () => {
    const b = mkBridge();
    b.register({ ...computer, executionPolicy: "always" });
    b.heartbeat("mac");
    const ownerTools = createLocalTools({ botId: "owner", slot, bridge: b, asks: new LocalAsks({ bots, now: () => now }), now: () => now });
    const run = ownerTools.find((t) => t.name === "ExternalShell")!.handler({ command: "cat secret.txt", block_ms: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    const req = published.at(-1)!.payload as { execId: string };
    b.output(req.execId, "stdout", "top secret contents\n");

    const intruderTools = createLocalTools({ botId: "intruder", slot, bridge: b, asks: new LocalAsks({ bots, now: () => now }), now: () => now });
    const awaitIntruder = intruderTools.find((t) => t.name === "AwaitExternalShell")!;
    const whileRunning = await awaitIntruder.handler({ shell_id: req.execId, block_ms: 0 });
    expect(whileRunning.text).not.toContain("top secret");
    expect(whileRunning.text).toBe(`No shell ${req.execId}.`);

    b.done(req.execId, { exitCode: 0 });
    await run;
    const afterDone = await awaitIntruder.handler({ shell_id: req.execId, block_ms: 10 });
    expect(afterDone.text).not.toContain("top secret");
    expect(afterDone.text).toBe(`No shell ${req.execId}.`);

    const ownerAwait = ownerTools.find((t) => t.name === "AwaitExternalShell")!;
    const ownerResult = await ownerAwait.handler({ shell_id: req.execId, block_ms: 10 });
    expect(ownerResult.text).toContain("top secret contents");
  });
});

describe("EgressCounter (LOC-09)", () => {
  it("counts distinct public peers across samples and ignores private ranges", async () => {
    const outputs = ["ESTAB 0 0 10.0.0.2:5000 142.250.1.1:443\nESTAB 0 0 10.0.0.2:5001 192.168.1.5:22", "ESTAB 0 0 10.0.0.2:5002 142.250.1.1:443\nESTAB 0 0 10.0.0.2:5003 [2606:4700::1]:443"];
    const e = new EgressCounter({ run: async () => outputs.shift() ?? "" });
    await e.sample();
    await e.sample();
    expect(e.count()).toBe(2);
  });
});

// Final integration ruling: local execution on the Mac needs an approval card and can't route around Auto-review.
describe("local execution never bypasses Auto-review (integration)", () => {
  it("with Auto-review off, even an Always-allow Mac asks the user with a card first", async () => {
    const b = mkBridge();
    b.register({ ...computer, executionPolicy: "always" });
    b.heartbeat("mac");
    const asks = new LocalAsks({ bots, now: () => now });
    const tools = createLocalTools({ botId: "b", slot, bridge: b, asks, now: () => now, autoReviewOn: () => false });
    const run = tools.find((t) => t.name === "ExternalShell")!.handler({ command: "rm -rf ~/Documents", block_ms: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    const card = [...entries.values()].at(-1) as { message: { card: { kind: string; askId: string } } } | undefined;
    expect(card?.message.card.kind).toBe("local-tool-permission");
    expect(published.filter((p) => p.channel === "local-exec")).toHaveLength(0); // nothing reached the Mac yet
    asks.resolve("b", card!.message.card.askId, "deny");
    expect((await run).isError).toBe(true);
    expect(published.filter((p) => p.channel === "local-exec")).toHaveLength(0);
  });
});

describe("LocalBridge stays inside the workspace (integration)", () => {
  it("a CopyToBox upload through a workspace symlink can't write outside the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.symlinkSync(outside, path.join(ws, "escape"));
    const b = mkBridge();
    b.register({ ...computer, executionPolicy: "always" });
    const { execId } = b.request({ botId: "b", approvalId: null, op: "copy-to-box", path: "/Users/alex/a.txt", boxPath: "escape/owned.txt" });
    expect(() => b.upload(execId, 0, Buffer.from("x").toString("base64"), true)).toThrow();
    expect(fs.existsSync(path.join(outside, "owned.txt"))).toBe(false);
  });

  it("readLocalFile won't follow a workspace symlink to a host file", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.writeFileSync(path.join(outside, "token"), "secret-token");
    fs.symlinkSync(path.join(outside, "token"), path.join(ws, "link"));
    const b = mkBridge();
    expect(() => b.readWorkspaceFile("link", 0, 100)).toThrow();
  });
});
