import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { PendingWakes } from "../../background/pending-wakes";
import type { Completion } from "../../background/revivals";
import { LocalShellSpawner } from "../../background/shell-spawner";
import { ShellService, envFileText, parseTerminal } from "../../background/shells";
import { createShellTools } from "../../background/shell-tools";
import { SseHub } from "../../gateway/sse-hub";
import type { HiddenSpec } from "../../runner/turn-runner";
import { tmpConfig } from "../helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const cfg = tmpConfig();
  const terminalsDir = path.join(cfg.workspace, ".bot", "terminals");
  const runDir = path.join(cfg.hostPrivate, "run");
  fs.mkdirSync(terminalsDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const pending = new PendingWakes(path.join(cfg.hostPrivate, "host-pending-wakes.json"));
  const done: Completion[] = [];
  const notes: HiddenSpec[] = [];
  const worked: string[] = [];
  const shells = new ShellService({
    onWork: (b: string) => worked.push(b),
    cfg, spawner: new LocalShellSpawner({ terminalsDir, runDir }), pending, revivals: { complete: (c: Completion) => done.push(c) } as never,
    hub: new SseHub(), envInputs: () => ({ secrets: { MY_TOKEN: "tok-123" } }), enqueueHidden: (_b, s) => notes.push(s), pollMs: 20,
  });
  const [shell, awaitShell] = createShellTools({ botId: "b", shells });
  return { cfg, shells, shell: shell!, awaitShell: awaitShell!, pending, done, notes, terminalsDir, runDir, worked };
}

describe("parseTerminal and env files", () => {
  it("reads front matter, body and footer", () => {
    const t = "---\npid: \ncwd: /workspace\ncommand: \"make\"\nstatus: running\nstarted_at: 2026-09-19T00:00:00.000Z\n---\nbuilding\nok\n\n---\nexit_code: 2\nelapsed_ms: 1500\nended_at: 1758240000000\ncwd: /workspace/app\n---\n";
    expect(parseTerminal(t)).toEqual({ header: { pid: "", cwd: "/workspace", command: "\"make\"", status: "running", started_at: "2026-09-19T00:00:00.000Z" }, body: "building\nok\n", footer: { exitCode: 2, elapsedMs: 1500, endedAt: 1758240000000, cwd: "/workspace/app" } });
  });
  it("writes systemd EnvironmentFile lines with escaping", () => {
    expect(envFileText({ A: 'x"y\\z\nw', B: "plain" })).toBe('A="x\\"y\\\\z\\nw"\nB="plain"\n');
  });
});

describe("Shell / AwaitShell (TOOL-11)", () => {
  it("reports the Bot as working when a Shell starts, and knows it is running (bug 195 S2)", async () => {
    const s = setup();
    const r = s.shell.handler({ command: "sleep 0.3; echo ok" });
    await wait(50);
    expect(s.worked).toEqual(["b"]);
    expect(s.shells.hasRunning("b")).toBe(true);
    await r;
    expect(s.shells.hasRunning("b")).toBe(false);
  });

  it("runs in the foreground, returns output and exit code, keeps the cwd, sees the Bot's env, and deletes the env file", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cfg.workspace, "app"));
    const r1 = await s.shell.handler({ command: "cd app && echo \"hi $MY_TOKEN\"" });
    expect(r1.text).toMatch(/^hi tok-123\n\n\[exit code 0 · \d+s · cwd .*\/app\]$/);
    const r2 = await s.shell.handler({ command: "pwd" });
    expect(r2.text).toContain(path.join(s.cfg.workspace, "app"));
    expect(fs.readdirSync(s.runDir)).toEqual([]);
    expect(s.pending.list()).toEqual([]);
  });

  it("moves to the background after block_until_ms, writes a pending marker, and revives on completion (#10)", async () => {
    const s = setup();
    const r = await s.shell.handler({ command: "sleep 0.3; echo finished", block_until_ms: 50 });
    const id = /\(task (shell-[0-9a-z-]+)\)/.exec(r.text)![1]!;
    expect(r.text).toMatch(/moved to the background/);
    expect(s.pending.has(id)).toBe(true);
    await wait(500);
    await s.shells.tick();
    expect(s.done).toHaveLength(1);
    expect(s.done[0]!.block).toMatch(new RegExp(`^Command \`sleep 0\\.3; echo finished\` \\(${id}\\) — exit code 0 after \\d+s\\.\\nFull output: .*${id}\\.txt$`));
  });

  it("AwaitShell returns when the pattern appears and a completed awaited task is not revived again", async () => {
    const s = setup();
    const r = await s.shell.handler({ command: "echo ready; sleep 0.2", block_until_ms: 0 });
    const id = /\(task (shell-[0-9a-z-]+)\)/.exec(r.text)![1]!;
    const a = await s.awaitShell.handler({ task_id: id, pattern: "ready", block_until_ms: 2000 });
    expect(a.text).toMatch(/Pattern matched/);
    const b = await s.awaitShell.handler({ task_id: id, block_until_ms: 2000 });
    expect(b.text).toMatch(/exit code 0/);
    await s.shells.tick();
    expect(s.done).toEqual([]);
  });

  it("notify_on_output wakes the Bot once per debounce window with the reason", async () => {
    const s = setup();
    await s.shell.handler({ command: "for i in 1 2 3; do echo line$i; sleep 0.1; done; sleep 0.3", block_until_ms: 0, notify_on_output: { pattern: "line[23]", reason: "the build printed progress", debounce_ms: 5000 } });
    await wait(400);
    await s.shells.tick();
    await s.shells.tick();
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatchObject({ source: "shell-notify", lane: "background", silenceAllowed: true });
    expect(s.notes[0]!.text).toContain("the build printed progress");
  });

  it("rewatches markers after a restart and revives when the footer is already there", async () => {
    const s = setup();
    s.pending.add({ kind: "shell", botId: "b", taskId: "shell-77" });
    fs.writeFileSync(path.join(s.terminalsDir, "shell-77.txt"), "---\ncommand: \"make\"\nstatus: running\n---\nout\n\n---\nexit_code: 0\nelapsed_ms: 10\nended_at: 5\ncwd: /workspace\n---\n");
    s.shells.rewatchAtBoot();
    await s.shells.tick();
    expect(s.done.map((c) => c.taskId)).toEqual(["shell-77"]);
  });
});

describe("Shell / AwaitShell over MCP tools/list (mcpfix ruling)", () => {
  it("lists both tools with the real SDK server", async () => {
    const s = setup();
    const tools = [s.shell, s.awaitShell];
    const server = toSdkMcpServer({ botTools: () => tools } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(["AwaitShell", "Shell"]);
      const shell = listed.tools.find((t) => t.name === "Shell")!;
      expect(Object.keys(shell.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["command", "working_directory", "block_until_ms", "notify_on_output"]));
    } finally {
      await client.close();
    }
  });
});

describe("Shell cwd, script and terminal-file hardening (security re-review items 3, 4, 5, 6)", () => {
  it("the script lives only in the host-private run dir and is gone after start (item 5)", async () => {
    const s = setup();
    const seen: string[] = [];
    const inner = new LocalShellSpawner({ terminalsDir: s.terminalsDir, runDir: s.runDir });
    const spy = { ...inner, start: async (id: string, cwd: string) => { seen.push(...fs.readdirSync(s.runDir), ...fs.readdirSync(s.terminalsDir)); const st = fs.statSync(path.join(s.runDir, `${id}.sh`)); seen.push(`mode:${(st.mode & 0o777).toString(8)}`); return inner.start(id, cwd); }, stop: (id: string) => inner.stop(id), status: (id: string) => inner.status(id) };
    const shells = new ShellService({ ...(s.shells as unknown as { d: ConstructorParameters<typeof ShellService>[0] }).d, spawner: spy });
    const r = await shells.run("b", { command: "echo ok" });
    expect(r.text).toMatch(/^ok\n/);
    expect(seen).toContain("shell-1.sh");
    expect(seen).toContain("mode:600");
    expect(fs.readdirSync(s.terminalsDir).filter((f) => f.endsWith(".sh"))).toEqual([]);
    expect(fs.readdirSync(s.runDir)).toEqual([]);
  });

  it("never follows a pre-planted terminal-file symlink (item 5, O_NOFOLLOW|O_EXCL)", async () => {
    const s = setup();
    const victim = path.join(s.cfg.hostPrivate, "victim.json");
    fs.writeFileSync(victim, "keep");
    fs.symlinkSync(victim, path.join(s.terminalsDir, "shell-1.txt"));
    const r = await s.shell.handler({ command: "echo fine" });
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    expect(r.text).toMatch(/fine/);
    expect(fs.lstatSync(path.join(s.terminalsDir, "shell-1.txt")).isSymbolicLink()).toBe(false);
  });

  it("a missing working directory fails; it never silently runs in the workspace (item 3)", async () => {
    const s = setup();
    const r = await s.shell.handler({ command: "touch ran-here", working_directory: "missing-dir" });
    expect(r.text).not.toMatch(/exit code 0/);
    expect(fs.existsSync(path.join(s.cfg.workspace, "ran-here"))).toBe(false);
  });

  it("refuses a working_directory that isn't the canonical (reviewed) path (items 3, 4)", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cfg.workspace, "real"));
    fs.symlinkSync(path.join(s.cfg.workspace, "real"), path.join(s.cfg.workspace, "link"));
    const r = await s.shell.handler({ command: "touch via-link", working_directory: path.join(s.cfg.workspace, "link") });
    expect(r.isError).toBe(true);
    expect(fs.existsSync(path.join(s.cfg.workspace, "real", "via-link"))).toBe(false);
    const ok = await s.shell.handler({ command: "touch direct", working_directory: path.join(s.cfg.workspace, "real") });
    expect(ok.text).toMatch(/exit code 0/);
  });

  it("a directory swapped for a symlink between review and run makes the script exit before the command (item 3)", async () => {
    const s = setup();
    const app = path.join(s.cfg.workspace, "app");
    const elsewhere = fs.mkdtempSync(path.join(s.cfg.hostPrivate, "elsewhere-"));
    fs.mkdirSync(app);
    const inner = new LocalShellSpawner({ terminalsDir: s.terminalsDir, runDir: s.runDir });
    const swapper = { start: async (id: string, cwd: string) => { fs.renameSync(app, `${app}-old`); fs.symlinkSync(elsewhere, app); return inner.start(id, cwd); }, stop: (id: string) => inner.stop(id), status: (id: string) => inner.status(id) };
    const shells = new ShellService({ ...(s.shells as unknown as { d: ConstructorParameters<typeof ShellService>[0] }).d, spawner: swapper });
    const r = await shells.run("b", { command: "touch planted", working_directory: app });
    expect(r.text).not.toMatch(/exit code 0/);
    expect(fs.existsSync(path.join(elsewhere, "planted"))).toBe(false);
  });

  it("a child subagent's Shell keeps its own last cwd (item 4)", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cfg.workspace, "sub"));
    const [childShell] = createShellTools({ botId: "b", shells: s.shells, childId: "task-1" });
    await childShell!.handler({ command: "cd sub" });
    expect(s.shells.lastCwdFor("b", "task-1")).toMatch(/\/sub$/);
    expect(s.shells.lastCwdFor("b")).toBeNull();
  });

  it("a delete that races an in-flight start stops the unit and forgetBot waits for the start (item 6)", async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const deferred = { start: async (id: string) => { calls.push(`start:${id}`); await gate; calls.push(`started:${id}`); }, stop: async (id: string) => { calls.push(`stop:${id}`); }, status: async () => "running" as const };
    const shells = new ShellService({ ...(s.shells as unknown as { d: ConstructorParameters<typeof ShellService>[0] }).d, spawner: deferred });
    const run = shells.run("b", { command: "sleep 5", block_until_ms: 0 });
    await wait(30);
    const forget = shells.forgetBot("b");
    let forgotten = false;
    void forget.then(() => { forgotten = true; });
    await wait(30);
    expect(forgotten).toBe(false);
    release();
    await forget;
    const r = await run;
    expect(calls).toEqual(["start:shell-1", "started:shell-1", "stop:shell-1"]);
    expect(r.isError).toBe(true);
  });
});
