/**
 * 5.6: the Mac's action log, undo for file changes, and dry run — through the REAL daemon, policy store, executor and
 * snapshot store, in a temp home (scripts/vitest-test-home.ts keeps the real one out of reach).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STRAL, localActionOf, localBindTarget, provenFileEffects, type LocalExecRequest, type MacActionView } from "@synapse/shared";
import { ActionLog, LOG_LIMITS } from "../../src/coordinator/local-exec/action-log";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";
import { SnapshotStore, undoScope } from "../../src/coordinator/local-exec/snapshots";

let home: string;
let proj: string;
let userData: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "actlog-home-")));
  proj = path.join(home, "Projects");
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
});

type Done = { execId: string; exitCode: number | null; result?: string; error?: string };

function world(o: { browser?: boolean; macapp?: boolean; roots?: boolean; policyDir?: string } = {}) {
  const done = new Map<string, (d: Done) => void>();
  const browserCalls: unknown[] = [];
  const macappCalls: unknown[] = [];
  const call = async (cmd: string, args: unknown): Promise<unknown> => {
    if (cmd === "localExecDone") done.get((args as Done).execId)?.(args as Done);
    return {};
  };
  const policy = new LocalPolicyStore(o.policyDir ?? path.join(userData, "policy"), Date.now, Buffer.alloc(32, 5), { home: () => home, userData: () => userData });
  policy.update({ localRoot: proj, ...(o.roots === false ? {} : { addAutoRunRoot: proj }) });
  const executor = new LocalExecutor({ root: () => policy.current().localRoot, home: () => home, userData: () => userData, fullAccess: () => true });
  let ran = 0;
  const realRun = executor.run.bind(executor);
  executor.run = (req, io) => { ran++; return realRun(req, io); };
  const log = new ActionLog(path.join(userData, "action-log"));
  const daemon = new LocalExecDaemon({
    call, policy, executor, heartbeatMs: 3_600_000,
    actions: { log, scope: (abs: string) => undoScope(abs, { home, roots: policy.current().autoRunRoots ?? [], userData }) },
    browser: o.browser === false ? undefined : async (c) => { browserCalls.push(c); return { ok: true, reply: { text: "ok", title: "Example", url: "https://example.com/done", session: "s" } as never }; },
    macapp: o.macapp === false ? undefined : async (c) => { macappCalls.push(c); return { ok: true, reply: { text: "sent" } as never }; },
  });
  let n = 0;
  /** One request, approved on this Mac exactly as a card's Allow once would (so every mode's path is the same). */
  const send = (r: Partial<LocalExecRequest> & { op: LocalExecRequest["op"] }, opts: { approve?: boolean; turn?: string; task?: string } = {}): Promise<Done> => {
    const execId = `e${++n}`;
    const req = { execId, botId: "b1", approvalId: null, ...r, ...(opts.turn ? { turn: opts.turn } : {}), ...(opts.task ? { task: opts.task } : {}) } as LocalExecRequest;
    if (opts.approve !== false) {
      const action = localActionOf(req.op)!;
      const approvalId = `a${n}`;
      policy.recordApproval(approvalId, { botId: "b1", expiresAt: Date.now() + 60_000, bind: bindHash(action, localBindTarget(req)) });
      req.approvalId = approvalId;
    }
    return new Promise<Done>((res) => { done.set(execId, res); daemon.onEvent({ channel: "local-exec", payload: req }); });
  };
  const list = (q: Record<string, unknown> = {}) => daemon.intercept("listMacActions", q).then((r) => (r as { result: { entries: MacActionView[] } }).result.entries);
  const undo = (id: string) => daemon.intercept("undoMacAction", { id, confirm: true }).then((r) => (r as { result: { ok: boolean; conflict?: boolean; message?: string } }).result);
  return { daemon, policy, log, send, list, undo, ran: () => ran, browserCalls, macappCalls };
}

const f = (name: string) => path.join(proj, name);
const rawLog = () => {
  const dir = path.join(userData, "action-log");
  return fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).map((x) => fs.readFileSync(path.join(dir, x), "utf8")).join("\n");
};

describe("action log: every kind of Mac action gets a record", () => {
  it("reads, writes, edits, deletes, moves, commands, typed input, browser and app actions", async () => {
    const w = world();
    w.policy.grant("b1", "browser");
    w.policy.grant("b1", "mac-app");
    fs.writeFileSync(f("a.txt"), "one\n");
    fs.writeFileSync(f("gone.txt"), "bye\n");
    fs.writeFileSync(f("from.txt"), "moving\n");
    expect((await w.send({ op: "read-file", path: f("a.txt") })).exitCode).toBe(0);
    expect((await w.send({ op: "write-file", path: f("new.txt"), content: "hi" })).exitCode).toBe(0);
    expect((await w.send({ op: "edit-file", path: f("a.txt"), oldString: "one", newString: "two" })).exitCode).toBe(0);
    expect((await w.send({ op: "run-command", command: "rm gone.txt", cwd: proj })).exitCode).toBe(0);
    expect((await w.send({ op: "run-command", command: "mv from.txt to.txt", cwd: proj })).exitCode).toBe(0);
    expect((await w.send({ op: "run-command", command: "echo hello", cwd: proj })).exitCode).toBe(0);
    expect((await w.send({ op: "browser", browser: { action: "click", ref: "e3" }, botName: "Nova" }, { approve: false })).exitCode).toBe(0);
    expect((await w.send({ op: "mac-app", macapp: { action: "notes.create" as never, app: "Notes", title: "t", text: "body" }, botName: "Nova" }, { approve: false })).exitCode).toBe(0);
    await w.send({ op: "send-input", command: "nope", input: "hunter2\n" });

    const rows = (await w.list()).reverse();
    expect(rows.map((r) => [r.kind, r.op, r.outcome])).toEqual([
      ["read", "read-file", "done"], ["write", "write-file", "done"], ["edit", "edit-file", "done"], ["delete", "run-command", "done"],
      ["move", "run-command", "done"], ["command", "run-command", "done"], ["browser", "browser", "done"], ["app", "mac-app", "done"],
      ["command", "send-input", "failed"],
    ]);
    for (const r of rows) {
      expect(r.at).toBeGreaterThan(0);
      expect(r.botId).toBe("b1");
    }
    expect(rows[0]!.targets).toEqual([f("a.txt")]);
    expect(rows[1]!.via).toBe("card");
    expect(rows[3]!.targets).toEqual([f("gone.txt")]);
    expect(rows[3]!.command).toBe("rm gone.txt");
    expect(rows[4]!.targets).toEqual([f("from.txt"), f("to.txt")]);
    expect(rows[5]).toMatchObject({ targets: ["echo hello"], detail: "Exit 0", undo: "none", undoNote: STRAL.noUndoCommand });
    expect(rows[6]).toMatchObject({ act: "click", targets: ["https://example.com/done"], via: "permission" });
    expect(rows[7]).toMatchObject({ act: "notes.create", targets: ["Notes"], via: "permission" });
    // Undo is offered for the file changes, and only for them.
    expect(rows.map((r) => r.undo)).toEqual(["none", "available", "available", "available", "available", "none", "none", "none", "none"]);
  });

  it("records the mode that let an action run, and a hard refusal", async () => {
    const w = world();
    w.policy.setBotMode("b1", "full-auto");
    expect((await w.send({ op: "write-file", path: f("x.txt"), content: "x", hostMode: "full-auto" }, { approve: false })).exitCode).toBe(0);
    const [row] = await w.list();
    expect(row!.via).toBe("full-auto");
    // The NEVER wall (the app's own data): refused, and logged as refused.
    const r = await w.send({ op: "write-file", path: path.join(userData, "x.json"), content: "x", hostMode: "full-auto" }, { approve: false });
    expect(r.error).toBeTruthy();
    const [refused] = await w.list();
    expect(refused).toMatchObject({ outcome: "refused", via: "none", kind: "write" });
  });

  it("does not log a refusal that only raises a card", async () => {
    const w = world();
    const r = await w.send({ op: "write-file", path: f("x.txt"), content: "x" }, { approve: false });
    expect(r.error).toMatch(/^needs-approval:/);
    expect(await w.list()).toEqual([]);
  });

  it("filters by Bot and kind, and exports the same redacted records", async () => {
    const w = world();
    await w.send({ op: "write-file", path: f("x.txt"), content: "x" });
    await w.send({ op: "run-command", command: "echo hi", cwd: proj });
    expect((await w.list({ filter: "files" })).map((r) => r.kind)).toEqual(["write"]);
    expect((await w.list({ filter: "commands" })).map((r) => r.kind)).toEqual(["command"]);
    expect(await w.list({ botId: "other" })).toEqual([]);
    const ex = (await w.daemon.intercept("exportMacActions", {})) as { result: { fileName: string; text: string } };
    expect(ex.result.fileName).toMatch(/^synapse-activity-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = ex.result.text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toHaveProperty("files");
  });
});

describe("action log: no contents and no secrets", () => {
  it("never writes file contents, edit strings, typed input, an app's text or a token", async () => {
    const w = world();
    w.policy.grant("b1", "browser");
    w.policy.grant("b1", "mac-app");
    fs.writeFileSync(f("doc.txt"), "PRIVATE-OLD-TEXT\n");
    await w.send({ op: "write-file", path: f("w.txt"), content: "FILE-CONTENT-CANARY" });
    await w.send({ op: "edit-file", path: f("doc.txt"), oldString: "PRIVATE-OLD-TEXT", newString: "PRIVATE-NEW-TEXT" });
    await w.send({ op: "run-command", command: "echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA > /dev/null", cwd: proj });
    await w.send({ op: "run-command", command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' https://x.test", cwd: proj });
    await w.send({ op: "send-input", command: "p1", input: "TYPED-PASSWORD-CANARY\n" });
    await w.send({ op: "browser", browser: { action: "type", ref: "e1", text: "BROWSER-TYPED-CANARY", value: "VALUE-CANARY" } }, { approve: false });
    await w.send({ op: "mac-app", macapp: { action: "mail.send" as never, app: "Mail", target: "a@b.test", title: "SUBJECT-CANARY", text: "BODY-CANARY" } }, { approve: false });
    const raw = rawLog();
    for (const canary of ["FILE-CONTENT-CANARY", "PRIVATE-OLD-TEXT", "PRIVATE-NEW-TEXT", "sk-ant-api03", "abcdefghijklmnopqrstuvwxyz0123456789", "TYPED-PASSWORD-CANARY", "BROWSER-TYPED-CANARY", "VALUE-CANARY", "SUBJECT-CANARY", "BODY-CANARY"]) {
      expect(raw, canary).not.toContain(canary);
    }
    expect(raw).toContain("[redacted]");
    // The log's folder and files are the owner's alone.
    expect(fs.statSync(path.join(userData, "action-log")).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(userData, "action-log", "actions.jsonl")).mode & 0o077).toBe(0);
  });
});

describe("undo", () => {
  it("restores an overwritten file, removes a created one, and reverts an edit", async () => {
    const w = world();
    fs.writeFileSync(f("keep.txt"), "original\n");
    fs.chmodSync(f("keep.txt"), 0o640);
    fs.writeFileSync(f("code.ts"), "const a = 1;\n");
    await w.send({ op: "write-file", path: f("keep.txt"), content: "clobbered" });
    await w.send({ op: "write-file", path: f("fresh.txt"), content: "new" });
    await w.send({ op: "edit-file", path: f("code.ts"), oldString: "1", newString: "2" });
    const [edit, create, overwrite] = await w.list();
    expect(await w.undo(overwrite!.id)).toEqual({ ok: true });
    expect(fs.readFileSync(f("keep.txt"), "utf8")).toBe("original\n");
    expect(fs.statSync(f("keep.txt")).mode & 0o777).toBe(0o640);
    expect(await w.undo(create!.id)).toEqual({ ok: true });
    expect(fs.existsSync(f("fresh.txt"))).toBe(false);
    expect(await w.undo(edit!.id)).toEqual({ ok: true });
    expect(fs.readFileSync(f("code.ts"), "utf8")).toBe("const a = 1;\n");
    expect((await w.list()).map((r) => r.undo)).toEqual(["undone", "undone", "undone"]);
    // Once only.
    expect(await w.undo(edit!.id)).toMatchObject({ ok: false, conflict: false });
  });

  it("re-creates a deleted file and moves a moved one back (the destination's old version too)", async () => {
    const w = world();
    fs.writeFileSync(f("gone.txt"), "precious\n");
    fs.writeFileSync(f("src.txt"), "source\n");
    fs.writeFileSync(f("dst.txt"), "old destination\n");
    await w.send({ op: "run-command", command: "rm -f gone.txt", cwd: proj });
    expect(fs.existsSync(f("gone.txt"))).toBe(false);
    await w.send({ op: "run-command", command: "mv src.txt dst.txt", cwd: proj });
    expect(fs.readFileSync(f("dst.txt"), "utf8")).toBe("source\n");
    const [mv, rm] = await w.list();
    expect(await w.undo(rm!.id)).toEqual({ ok: true });
    expect(fs.readFileSync(f("gone.txt"), "utf8")).toBe("precious\n");
    expect(await w.undo(mv!.id)).toEqual({ ok: true });
    expect(fs.readFileSync(f("src.txt"), "utf8")).toBe("source\n");
    expect(fs.readFileSync(f("dst.txt"), "utf8")).toBe("old destination\n");
  });

  it("refuses, touching nothing, when the file changed since", async () => {
    const w = world();
    fs.writeFileSync(f("a.txt"), "v1\n");
    fs.writeFileSync(f("b.txt"), "b\n");
    await w.send({ op: "write-file", path: f("a.txt"), content: "v2\n" });
    await w.send({ op: "run-command", command: "rm b.txt", cwd: proj });
    const [rm, write] = await w.list();
    fs.writeFileSync(f("a.txt"), "v3 by the owner\n");
    expect(await w.undo(write!.id)).toEqual({ ok: false, conflict: true, message: STRAL.conflict });
    expect(fs.readFileSync(f("a.txt"), "utf8")).toBe("v3 by the owner\n");
    // A deleted file that is back (someone made a new one) is not overwritten.
    fs.writeFileSync(f("b.txt"), "a new b\n");
    expect(await w.undo(rm!.id)).toMatchObject({ ok: false, conflict: true });
    expect(fs.readFileSync(f("b.txt"), "utf8")).toBe("a new b\n");
    expect((await w.list()).map((r) => r.undo)).toEqual(["available", "available"]);
  });

  it("needs the app's confirm", async () => {
    const w = world();
    await expect(w.daemon.intercept("undoMacAction", { id: "x" })).rejects.toThrow(/confirmation/);
  });

  it("works out of the box: any regular file under home, with no project folders set", async () => {
    const w = world({ roots: false });
    const docs = path.join(home, "Documents");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "plan.txt"), "v1\n");
    await w.send({ op: "write-file", path: path.join(docs, "plan.txt"), content: "v2\n" });
    const [row] = await w.list();
    expect(row!.undo).toBe("available");
    expect(await w.undo(row!.id)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(docs, "plan.txt"), "utf8")).toBe("v1\n");
  });

  it("no undo outside home, in excluded folders, for a symlink, or for a command it can't prove", async () => {
    const w = world({ roots: false });
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "actlog-outside-")));
    await w.send({ op: "write-file", path: path.join(outside, "o.txt"), content: "x" });
    const excluded = ["Library/Preferences/x.plist", ".Trash/t.txt", ".cache/pip/c.bin", "code/node_modules/pkg/i.js", "code/.git/objects/ab/cdef", "Library/Caches/app/c"];
    for (const rel of excluded) await w.send({ op: "write-file", path: path.join(home, rel), content: "x" });
    fs.writeFileSync(f("t.txt"), "t");
    fs.symlinkSync(f("t.txt"), f("link"));
    await w.send({ op: "run-command", command: "rm link", cwd: proj });
    await w.send({ op: "run-command", command: "rm *.nothing || true", cwd: proj });
    const rows = (await w.list()).reverse();
    expect(rows[0]).toMatchObject({ undo: "none", undoNote: STRAL.noUndoOutside });
    for (let k = 1; k <= excluded.length; k++) expect(rows[k], excluded[k - 1]).toMatchObject({ undo: "none", undoNote: STRAL.noUndoExcluded });
    expect(rows[excluded.length + 1]).toMatchObject({ kind: "command", undo: "none", undoNote: STRAL.noUndoCommand });
    expect(rows[excluded.length + 2]).toMatchObject({ kind: "command", undo: "none" });
    expect(fs.readdirSync(path.join(userData, "action-log", "snapshots"))).toEqual([]);
    // The store is the owner's alone.
    expect(fs.statSync(path.join(userData, "action-log", "snapshots")).mode & 0o077).toBe(0);
  });

  it("the app's own data is never snapshotted", () => {
    expect(undoScope(path.join(userData, "x.json"), { home, userData })).toBe("excluded");
    expect(undoScope(path.join(home, "notes.txt"), { home, userData })).toBe("ok");
    expect(undoScope("/etc/hosts", { home, userData })).toBe("outside");
  });

  it("undo of a created file removes the folders its write created, only those, and only while empty", async () => {
    const w = world();
    fs.mkdirSync(path.join(proj, "keep"));
    await w.send({ op: "write-file", path: path.join(proj, "keep", "a", "b", "new.txt"), content: "n" });
    await w.send({ op: "write-file", path: path.join(proj, "keep", "c", "d", "new.txt"), content: "n" });
    fs.writeFileSync(path.join(proj, "keep", "c", "owner.txt"), "mine");
    const [second, first] = await w.list();
    expect(await w.undo(first!.id)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(proj, "keep", "a"))).toBe(false);
    expect(fs.existsSync(path.join(proj, "keep"))).toBe(true);
    expect(await w.undo(second!.id)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(proj, "keep", "c", "d"))).toBe(false);
    expect(fs.readFileSync(path.join(proj, "keep", "c", "owner.txt"), "utf8")).toBe("mine");
  });
});

describe("retention and caps", () => {
  it("expires undo after the retention window and prunes the snapshot", async () => {
    let now = 1_000_000;
    const store = new SnapshotStore(path.join(userData, "snaps"), { now: () => now, limits: { retentionMs: 1000, pruneEveryMs: 0 } });
    const log = new ActionLog(path.join(userData, "log2"), { now: () => now, snapshots: store });
    fs.writeFileSync(f("a.txt"), "v1");
    const t = await store.take(f("a.txt"));
    expect(t.ok).toBe(true);
    fs.writeFileSync(f("a.txt"), "v2");
    const rec = log.record({ botId: "b", kind: "write", op: "write-file", targets: [f("a.txt")], outcome: "done", via: "card", files: [{ path: f("a.txt"), before: (t as unknown as { before: never }).before, after: SnapshotStore.stateOf(f("a.txt")) }] });
    expect(log.list().entries[0]!.undo).toBe("available");
    now += 2000;
    expect(log.list().entries[0]!.undo).toBe("expired");
    expect(await log.undo(rec.id)).toMatchObject({ ok: false });
    store.prune(true);
    expect(fs.readdirSync(path.join(userData, "snaps"))).toEqual([]);
  });

  it("keeps the total under the cap (oldest first) and never snapshots a file over the per-file cap", async () => {
    let now = 5_000_000;
    const store = new SnapshotStore(path.join(userData, "snaps2"), { now: () => now, limits: { maxFileBytes: 1000, maxTotalBytes: 2500, pruneEveryMs: 0 } });
    fs.writeFileSync(f("big.bin"), Buffer.alloc(1001));
    expect(await store.take(f("big.bin"))).toEqual({ ok: false, why: "too-big" });
    fs.writeFileSync(f("k.bin"), Buffer.alloc(1000));
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { now += 10; const t = await store.take(f("k.bin")); if (t.ok) ids.push(t.before.snap!); }
    const left = fs.readdirSync(path.join(userData, "snaps2")).sort();
    expect(left.length).toBe(2);
    expect(left).toEqual(ids.slice(2).sort());
  });

  it("rotates the log file and keeps reading the rotated ones", () => {
    const log = new ActionLog(path.join(userData, "log3"), { limits: { maxFileBytes: 2000, keep: 2 } });
    for (let i = 0; i < 60; i++) log.record({ botId: "b", kind: "command", op: "run-command", targets: [`echo ${i} ${"x".repeat(40)}`], outcome: "done", via: "card" });
    const files = fs.readdirSync(path.join(userData, "log3")).filter((x) => x.endsWith(".jsonl")).sort();
    expect(files).toEqual(["actions.1.jsonl", "actions.2.jsonl", "actions.jsonl"]);
    const fresh = new ActionLog(path.join(userData, "log3"), { limits: { maxFileBytes: 2000, keep: 2 } });
    const got = fresh.list({ limit: 500 }).entries;
    expect(got[0]!.targets[0]).toMatch(/^echo 59 /);
    expect(got.length).toBeLessThan(60); // the oldest rotated out
    expect(LOG_LIMITS.keep).toBeGreaterThan(0);
  });
});

describe("dry run", () => {
  it("never executes a change: writes, edits, deletes, moves and commands are recorded, the Mac is untouched", async () => {
    const w = world();
    fs.writeFileSync(f("a.txt"), "v1\n");
    fs.writeFileSync(f("b.txt"), "b\n");
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
    const r1 = await w.send({ op: "write-file", path: f("a.txt"), content: "v2\n" });
    const r2 = await w.send({ op: "write-file", path: f("new.txt"), content: "n" });
    const r3 = await w.send({ op: "edit-file", path: f("a.txt"), oldString: "v1", newString: "zz" });
    const r4 = await w.send({ op: "run-command", command: "rm b.txt", cwd: proj });
    const r5 = await w.send({ op: "run-command", command: `touch ${f("marker")}`, cwd: proj });
    const r6 = await w.send({ op: "send-input", command: "p", input: "y\n" });
    expect(w.ran()).toBe(0);
    expect(fs.readFileSync(f("a.txt"), "utf8")).toBe("v1\n");
    expect(fs.existsSync(f("new.txt"))).toBe(false);
    expect(fs.existsSync(f("b.txt"))).toBe(true);
    expect(fs.existsSync(f("marker"))).toBe(false);
    expect(r1.result).toMatch(/^Dry run: nothing changed\. Would overwrite .*a\.txt \(3 → 3 bytes\)\./);
    expect(r2.result).toMatch(/Would create .*new\.txt/);
    expect(r3.result).toMatch(/Would edit .*\(1 replacement\)\. So far this turn: would write 3 files\./);
    expect(r4.error).toMatch(/wasn't run.*Would delete .*b\.txt\..*would write 3 files, delete 1\./);
    expect(r5.error).toMatch(/wasn't run/);
    expect(r6.error).toMatch(/wasn't run/);
    const rows = await w.list({ filter: "dry-run" });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.dryRun && r.undo === "none")).toBe(true);
    expect(rows.map((r) => r.outcome).reverse()).toEqual(["simulated", "simulated", "simulated", "refused", "refused", "refused"]);
  });

  it("simulates a change that would need a card without asking, and still runs reads", async () => {
    const w = world();
    fs.writeFileSync(f("a.txt"), "hello\n");
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
    const r = await w.send({ op: "write-file", path: f("a.txt"), content: "x" }, { approve: false });
    expect(r.result).toMatch(/It would ask first\./);
    const read = await w.send({ op: "read-file", path: f("a.txt") });
    expect(read.result).toBe("hello\n");
    expect(fs.readFileSync(f("a.txt"), "utf8")).toBe("hello\n");
  });

  it("refuses a browser or app action it can't simulate, and never calls the controller", async () => {
    const w = world();
    w.policy.grant("b1", "browser");
    w.policy.grant("b1", "mac-app");
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
    const click = await w.send({ op: "browser", browser: { action: "click", ref: "e2" } }, { approve: false });
    const send = await w.send({ op: "mac-app", macapp: { action: "mail.send" as never, app: "Mail" } }, { approve: false });
    expect(click.error).toMatch(/^Dry run: this wasn't run/);
    expect(send.error).toMatch(/^Dry run: this wasn't run/);
    expect(w.browserCalls).toEqual([]);
    expect(w.macappCalls).toEqual([]);
    // A read-only look still works.
    expect((await w.send({ op: "browser", browser: { action: "snapshot" } }, { approve: false })).exitCode).toBe(0);
    expect(w.browserCalls).toHaveLength(1);
  });

  it("Next turn lasts for the task: approval resumes and follow-up turns stay dry; the owner's next message ends it", async () => {
    const w = world();
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "turn" });
    expect((await w.daemon.intercept("getLocalDryRun", { id: "b1" }) as { result: { mode: string } }).result.mode).toBe("turn");
    // Task u7: the first turn, then a card-answer resume and a follow-up turn (new turn ids, same owner message).
    await w.send({ op: "write-file", path: f("t1.txt"), content: "1" }, { task: "u7", turn: "r1" });
    await w.send({ op: "write-file", path: f("t1b.txt"), content: "1" }, { task: "u7", turn: "r2-resume" });
    await w.send({ op: "write-file", path: f("t1c.txt"), content: "1" }, { task: "u7", turn: "r3-followup" });
    // An older host that sends no task stays dry.
    await w.send({ op: "write-file", path: f("t1d.txt"), content: "1" });
    expect(fs.readdirSync(proj)).toEqual([]);
    // The owner's next message.
    await w.send({ op: "write-file", path: f("t2.txt"), content: "2" }, { task: "u8", turn: "r4" });
    expect(fs.readdirSync(proj)).toEqual(["t2.txt"]);
    expect((await w.daemon.intercept("getLocalDryRun", { id: "b1" }) as { result: { mode: string } }).result.mode).toBe("off");
  });

  it("the owner can turn Next turn off mid-task", async () => {
    const w = world();
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "turn" });
    await w.send({ op: "write-file", path: f("a.txt"), content: "1" }, { task: "u1" });
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "off" });
    await w.send({ op: "write-file", path: f("b.txt"), content: "1" }, { task: "u1" });
    expect(fs.readdirSync(proj)).toEqual(["b.txt"]);
  });

  describe("fails safe", () => {
    const file = () => path.join(userData, "policy", "local-bot-dryrun.json");
    const tamper = () => { const j = JSON.parse(fs.readFileSync(file(), "utf8")) as { data: Record<string, unknown> }; j.data = {}; fs.writeFileSync(file(), JSON.stringify(j)); };

    it("a tampered record keeps dry run on for every Bot that had it at the last good read", async () => {
      const w = world();
      await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
      expect(w.policy.dryRunMode("b1")).toBe("on");
      tamper();
      const r = await w.send({ op: "write-file", path: f("x.txt"), content: "x" });
      expect(r.result).toMatch(/^Dry run: nothing changed/);
      fs.writeFileSync(file(), "{ not json");
      await w.send({ op: "write-file", path: f("y.txt"), content: "y" });
      fs.chmodSync(file(), 0o000);
      await w.send({ op: "write-file", path: f("z.txt"), content: "z" });
      fs.chmodSync(file(), 0o600);
      expect(fs.readdirSync(proj)).toEqual([]);
      expect(w.ran()).toBe(0);
    });

    it("with no good read at all, every change is refused with a clear message; reads still run", async () => {
      const first = world();
      await first.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
      tamper();
      // A new run of the app: it has never read the record well.
      const w = world();
      fs.writeFileSync(f("r.txt"), "read me");
      for (const r of [
        await w.send({ op: "write-file", path: f("x.txt"), content: "x" }),
        await w.send({ op: "run-command", command: `touch ${f("m")}`, cwd: proj }),
        await w.send({ op: "write-file", path: f("x.txt"), content: "x" }, { approve: false }),
      ]) expect(r.error).toBe(STRAL.dryRunUnknown);
      w.policy.grant("b1", "browser");
      expect((await w.send({ op: "browser", browser: { action: "click", ref: "e1" } }, { approve: false })).error).toBe(STRAL.dryRunUnknown);
      expect(w.browserCalls).toEqual([]);
      expect(w.ran()).toBe(0);
      expect(fs.existsSync(f("x.txt")) || fs.existsSync(f("m"))).toBe(false);
      expect((await w.send({ op: "read-file", path: f("r.txt") })).result).toBe("read me");
      expect(w.policy.dryRunMode("b1")).toBe("on");
      // Deleting another Bot never rewrites the bad record into a trusted "off".
      w.policy.forgetBot("b2");
      expect((await w.send({ op: "write-file", path: f("x.txt"), content: "x" })).error).toBe(STRAL.dryRunUnknown);
      // The owner setting it again is a good record.
      await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "off" });
      expect((await w.send({ op: "write-file", path: f("x.txt"), content: "x" })).exitCode).toBe(0);
    });

    it("a run that can't trust its key file can't read the real record: unknown, not off", () => {
      const real = path.join(userData, "policy");
      const p0 = new LocalPolicyStore(real, Date.now, Buffer.alloc(32, 5), { home: () => home, userData: () => userData });
      p0.setDryRun("b1", "on");
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "actlog-scratch-"));
      const p = new LocalPolicyStore(scratch, Date.now, Buffer.alloc(32, 9), { home: () => home, userData: () => userData, dryRunShadow: path.join(real, "local-bot-dryrun.json") });
      expect(p.dryRunState({ botId: "b1" })).toBe("unknown");
      expect(p.dryRunState({ botId: "b2" })).toBe("unknown");
      const clean = new LocalPolicyStore(fs.mkdtempSync(path.join(os.tmpdir(), "actlog-scratch-")), Date.now, Buffer.alloc(32, 9), { home: () => home, userData: () => userData, dryRunShadow: path.join(scratch, "none.json") });
      expect(clean.dryRunState({ botId: "b1" })).toBe("off");
    });
  });

  it("is kept per Bot on this Mac and goes with a deleted Bot", async () => {
    const w = world();
    await w.daemon.intercept("setLocalDryRun", { id: "b1", mode: "on" });
    const again = new LocalPolicyStore(path.join(userData, "policy"), Date.now, Buffer.alloc(32, 5), { home: () => home, userData: () => userData });
    expect(again.dryRunMode("b1")).toBe("on");
    expect(again.dryRunMode("b2")).toBe("off");
    again.forgetBot("b1");
    expect(again.dryRunMode("b1")).toBe("off");
  });
});

describe("proven file effects", () => {
  it("proves only one plain rm or mv of literal paths", () => {
    const c = "/p";
    expect(provenFileEffects("rm a.txt b.txt", c, "/h")).toEqual({ kind: "delete", paths: ["/p/a.txt", "/p/b.txt"] });
    expect(provenFileEffects("rm -fv ~/x", c, "/h")).toEqual({ kind: "delete", paths: ["/h/x"] });
    expect(provenFileEffects("mv a b", c, "/h")).toEqual({ kind: "move", from: "/p/a", to: "/p/b" });
    for (const bad of ["rm -r d", "rm *.txt", "rm $X", "rm a; ls", "rm a && rm b", "rm a > o", "sudo rm a", "mv a b c", "mv -n a b", "rm ../a", "cat a | rm b", "rm $(ls)", "env rm a", "rm ~other/a", "cp a b"]) {
      expect(provenFileEffects(bad, c, "/h"), bad).toBeNull();
    }
  });
});

describe("speed", () => {
  // The budget a snapshot may add to a Bot's file change (one clonefile through /bin/cp -c). A tool call's own round
  // trip (host → Mac → host) is tens of ms, a model turn seconds. Flat in size: 64 MB costs what 1 MB does.
  // Measured alone: p50 ~2 ms, p95 ~3 ms; inside the full parallel suite: p50 ~7 ms, p95 ~25 ms (process spawns
  // queue behind the other workers). The gate is the median, with a loose tail.
  const BUDGET_P50_MS = 10;
  const BUDGET_P95_MS = 40;
  it.runIf(process.platform === "darwin")("a snapshot is a clone: p95 within budget, and flat in the file's size", async () => {
    const store = new SnapshotStore(path.join(userData, "speed"), { limits: { maxTotalBytes: 50 * 1024 ** 3 } });
    const measure = async (bytes: number, n: number) => {
      const p = f(`s-${bytes}.bin`);
      fs.writeFileSync(p, Buffer.alloc(bytes, 7));
      const t: number[] = [];
      for (let i = 0; i < n; i++) {
        const s = process.hrtime.bigint();
        const r = await store.take(p);
        t.push(Number(process.hrtime.bigint() - s) / 1e6);
        expect(r.ok).toBe(true);
      }
      t.sort((a, b) => a - b);
      return { p50: t[Math.floor(n / 2)]!, p95: t[Math.floor(n * 0.95)]! };
    };
    await measure(4096, 5); // warm
    const small = await measure(1024 ** 2, 40);
    const big = await measure(64 * 1024 ** 2 - 1, 40);
    console.log(`snapshot: 1 MB p50 ${small.p50.toFixed(2)} ms p95 ${small.p95.toFixed(2)} ms; 64 MB p50 ${big.p50.toFixed(2)} ms p95 ${big.p95.toFixed(2)} ms`);
    expect(small.p50).toBeLessThan(BUDGET_P50_MS);
    expect(big.p50).toBeLessThan(BUDGET_P50_MS);
    expect(small.p95).toBeLessThan(BUDGET_P95_MS);
    expect(big.p95).toBeLessThan(BUDGET_P95_MS);
    // A copy of 64 MB would be ~20x a 1 MB one; a clone is the same.
    expect(big.p50).toBeLessThan(small.p50 * 3 + 2);
  });
});
