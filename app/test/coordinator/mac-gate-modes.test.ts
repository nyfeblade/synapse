/**
 * fix-mac-gate-and-approval-expiry (Bug A): a Bot in per-Bot "Full auto" got "This command was not approved on this
 * computer" for EVERY Mac command, because the Mac coordinator's policy (LOC-05) knew nothing of the Bot's mode and
 * demanded its own one-time approval id, while the host (correctly, in Full auto) skipped the card that mints one.
 *
 * These tests wire the REAL host tools + bridge + asks to the REAL Mac daemon + policy store in-process, and run real
 * commands in a temp home. The Mac learns a Bot's mode only from its own renderer (setAgentPermMode passing through
 * the coordinator), never from the host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STR5, type LocalComputer, type SseEvent } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { LocalAsks } from "../../../host/local/asks";
import { LocalBridge } from "../../../host/local/bridge";
import { createLocalTools } from "../../../host/local/local-tools";

let dir: string;
let home: string;
let ws: string;
const key = Buffer.alloc(32, 7);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "macgate-"));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "macgate-home-")));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "macgate-ws-"));
  fs.mkdirSync(path.join(home, "Downloads"));
  fs.writeFileSync(path.join(home, "Downloads", "assignments.pdf"), "pdf");
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
  fs.mkdirSync(path.join(home, "Projects"));
  fs.writeFileSync(path.join(home, "Projects", "notes.txt"), "hello world");
});

type Mode = "ask" | "accept-edits" | "full-auto";

/** One Mac + one host, wired like the app: host → SSE → daemon; daemon → gateway calls → host. */
function world(o: { hostMode: Mode; hostSetModeFails?: boolean }) {
  const entries = new Map<string, { message?: { card?: { askId: string; status: string } } }>();
  const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
  let daemon: LocalExecDaemon | null = null;
  const bridge = new LocalBridge({ hub: { publish: (e: SseEvent) => daemon?.onEvent(e) } as never, now: () => Date.now(), workspace: ws, idleMs: 60_000 });
  const asks = new LocalAsks({ bots, now: () => Date.now() });
  const hostModes = new Map<string, Mode>();
  const call = async (cmd: string, args: unknown): Promise<unknown> => {
    const a = args as Record<string, unknown>;
    if (cmd === "registerLocalComputer") { bridge.register(a.computer as LocalComputer); return {}; }
    if (cmd === "localExecHeartbeat") return { pending: [] };
    if (cmd === "localExecOutput") { bridge.output(String(a.execId), a.stream as "stdout", String(a.chunk)); return {}; }
    if (cmd === "localExecDone") { bridge.done(String(a.execId), a as never); return {}; }
    if (cmd === "setAgentPermMode") {
      if (o.hostSetModeFails) throw Object.assign(new Error("host down"), { code: "NETWORK" });
      hostModes.set(String(a.id), a.mode as Mode);
      return {};
    }
    if (cmd === "resolveLocalToolPermission") return { status: asks.resolve(String(a.id), String(a.askId), a.choice as never) };
    throw new Error(`unexpected ${cmd}`);
  };
  const policy = new LocalPolicyStore(dir, Date.now, key, { home: () => home, userData: () => path.join(home, "Library", "Application Support", "Synapse") });
  policy.update({ localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
  daemon = new LocalExecDaemon({ call, policy, executor: new LocalExecutor({ root: () => policy.current().localRoot, userData: () => dir, fullAccess: () => true }), heartbeatMs: 3_600_000 });
  bridge.register(policy.current());
  bridge.heartbeat(policy.current().computerId);
  const tools = (botId: string) => createLocalTools({ botId, slot: () => ({ turnNo: 1, nextSendK: 0, requestId: "r", segment: 0 }) as never, bridge, asks, now: () => Date.now(), permMode: () => o.hostMode, workspace: ws });
  const run = async (botId: string, tool: string, input: Record<string, unknown>) => {
    const t = tools(botId).find((x) => x.name === tool)!;
    return t.handler(input as never);
  };
  const pendingCard = () => [...entries.values()].map((e) => e.message?.card).find((c) => c && c.status === "pending") ?? null;
  return { daemon: daemon!, policy, run, pendingCard, hostModes, asks };
}

const noBare = (text: string) => expect(text).not.toMatch(/^(Error: )*This command was not approved on this computer\.?$/m);

describe("Bug A: a Full-auto Bot's Mac commands run (Mac-side mode, Mac stays the final authority)", () => {
  it("the user's case: listing ~/Downloads, find, ExternalRead and the Mac tool all succeed in Full auto", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" }); // the user picks Full auto in THIS app
    const ls = await w.run("b1", "ExternalShell", { command: `ls ${home}/Downloads` });
    expect(ls.isError ?? false).toBe(false);
    expect(ls.text).toContain("assignments.pdf");
    const find = await w.run("b1", "ExternalShell", { command: `find ${home}/Downloads -name '*.pdf'` });
    expect(find.text).toContain("assignments.pdf");
    const read = await w.run("b1", "ExternalRead", { path: `${home}/Projects/notes.txt` });
    expect(read).toMatchObject({ text: expect.stringContaining("hello world") });
    const glob = await w.run("b1", "Mac", { action: "glob", path: `${home}/Downloads`, pattern: "*.pdf" });
    expect(glob.isError ?? false).toBe(false);
    expect(glob.text).toContain("assignments.pdf");
    expect(w.pendingCard()).toBeNull(); // Full auto: no card at all
  });

  it("NEVER-list commands are still refused in Full auto, with a message naming the wall (never the bare refusal)", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    for (const r of [
      await w.run("b1", "ExternalShell", { command: `cat ${home}/.ssh/id_rsa` }),
      await w.run("b1", "ExternalRead", { path: `${home}/.ssh/id_rsa` }),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain("KEY");
      expect(r.text).toMatch(/never allowed|blocked/i);
      noBare(r.text);
    }
    expect(w.pendingCard()).toBeNull(); // a NEVER is not a card
  });

  it("an ALWAYS-ASK command in Full auto gets the Mac card (which mints the Mac approval) and runs once approved", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    const first = await w.run("b1", "ExternalShell", { command: `rm -rf ${home}/Downloads/assignments.pdf` }); // rm outside a project dir: ALWAYS-ASK
    expect(first.isError).toBe(true); // bug #96: the card ends the turn; nothing ran
    expect(fs.existsSync(path.join(home, "Downloads", "assignments.pdf"))).toBe(true);
    const card = w.pendingCard();
    expect(card).not.toBeNull();
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: card!.askId, choice: "once", action: "run-command", target: `rm -rf ${home}/Downloads/assignments.pdf` });
    const r = await w.run("b1", "ExternalShell", { command: `rm -rf ${home}/Downloads/assignments.pdf` }); // the woken Bot's re-run
    expect(r.isError ?? false).toBe(false);
    expect(fs.existsSync(path.join(home, "Downloads", "assignments.pdf"))).toBe(false);
  });

  it("the host's word is not enough: a Bot the Mac never saw set to Full auto still needs the card, and the refusal is actionable", async () => {
    const w = world({ hostMode: "full-auto" }); // the HOST says full-auto; the Mac's own settings say nothing
    const p = w.run("b1", "ExternalShell", { command: `ls ${home}/Downloads` });
    let card = null as { askId: string } | null;
    for (let i = 0; i < 200 && !card; i++) { await new Promise((r) => setTimeout(r, 10)); card = w.pendingCard(); }
    expect(card).not.toBeNull(); // the Mac's refusal became a card instead of a dead end
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: card!.askId, choice: "deny", action: "run-command", target: `ls ${home}/Downloads` });
    const r = await p;
    expect(r.isError).toBe(true);
    // and directly at the Mac: the reason names the gate and how to change it
    const v = w.policy.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: `ls ${home}/Downloads` });
    expect(v.ok).toBe(false);
    const reason = (v as { reason: string }).reason;
    expect(reason).toMatch(/Run commands on this Mac/);
    expect(reason).toMatch(/Ask every time/);
    expect(reason).toMatch(/Approve the card|permission mode/i);
    noBare(reason);
  });

  it("a mode the host refused to save is not recorded on the Mac", async () => {
    const w = world({ hostMode: "full-auto", hostSetModeFails: true });
    await expect(w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" })).rejects.toThrow();
    expect(w.policy.botMode("b1")).toBe("ask");
  });

  it("modes are per Bot, HMAC'd, and a tampered modes file falls back to Ask", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    expect(w.policy.botMode("b1")).toBe("full-auto");
    expect(w.policy.botMode("b2")).toBe("ask");
    const f = path.join(dir, "local-bot-modes.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"b1"', '"b2"'));
    expect(w.policy.botMode("b2")).toBe("ask");
    expect(w.policy.botMode("b1")).toBe("ask");
  });

  it("the account switch stays the master: Never allow blocks a Full-auto Bot, with a message saying where to change it", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    w.policy.update({ executionPolicy: "never" });
    const v = w.policy.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: `ls ${home}/Downloads` });
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/Never allow/) });
    expect((v as { reason: string }).reason).toMatch(/Settings/);
  });

  it("Auto-accept edits: an edit inside a project dir runs without a card; a command still needs one", async () => {
    const w = world({ hostMode: "accept-edits" });
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "accept-edits" });
    const e = await w.run("b1", "Mac", { action: "edit", path: `${home}/Projects/notes.txt`, old_string: "hello", new_string: "bye" });
    expect(e.isError ?? false).toBe(false);
    expect(fs.readFileSync(path.join(home, "Projects", "notes.txt"), "utf8")).toBe("bye world");
    expect(w.policy.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: "touch x" })).toMatchObject({ ok: false });
    expect(w.policy.check({ execId: "x", botId: "b1", approvalId: null, op: "edit-file", path: `${home}/Downloads/assignments.pdf`, oldString: "p", newString: "q" })).toMatchObject({ ok: false });
  });

  it("Ask mode is unchanged: no approval id → refused (actionably)", () => {
    const w = world({ hostMode: "ask" });
    const v = w.policy.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: `ls ${home}/Downloads` });
    expect(v.ok).toBe(false);
    noBare((v as { reason: string }).reason);
  });
});

describe("Bug B (Mac side): a card answered late still works; the approval stays one-time and bound", () => {
  it("an approval recorded by the card is still valid 30 min later, works once, and only for that Bot and command", async () => {
    const w = world({ hostMode: "ask" });
    const target = `ls ${home}/Downloads`;
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: "late", choice: "once", action: "run-command", target }).catch(() => null);
    const later = new LocalPolicyStore(dir, () => Date.now() + 30 * 60_000, key, { home: () => home });
    expect(later.check({ execId: "x", botId: "b2", approvalId: "late", op: "run-command", command: target })).toMatchObject({ ok: false }); // other Bot
    expect(later.check({ execId: "x", botId: "b1", approvalId: "late", op: "run-command", command: "ls /" })).toMatchObject({ ok: false }); // other command
    expect(later.check({ execId: "x", botId: "b1", approvalId: "late", op: "run-command", command: target })).toEqual({ ok: true });
    expect(later.check({ execId: "x", botId: "b1", approvalId: "late", op: "run-command", command: target })).toMatchObject({ ok: false }); // one-time
  });

  it("end to end: the session ends while the card waits; the late answer mints the Mac approval and the woken Bot's re-run runs", async () => {
    const w = world({ hostMode: "ask" });
    const cmd = `ls ${home}/Downloads`;
    const first = await w.run("b1", "ExternalShell", { command: cmd }); // bug #96: the card ends the turn at once
    const card = w.pendingCard();
    w.asks.expireAll("b1"); // the session ends (Stop / rollover)
    expect(first.text).toBe(STR5.localAskWaiting);
    expect(w.pendingCard()).not.toBeNull(); // still answerable, not "expired"
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: card!.askId, choice: "once", action: "run-command", target: cmd });
    const rerun = await w.run("b1", "ExternalShell", { command: cmd }); // the woken Bot runs exactly that again
    expect(rerun.text).toContain("assignments.pdf");
    const third = await w.run("b1", "ExternalShell", { command: cmd }); // one-time: a third run asks again
    expect(third.text).toBe(STR5.localAskWaiting);
    expect(w.pendingCard()).not.toBeNull();
  });

  it("an unused approval still expires eventually (hygiene: 7 days)", async () => {
    const w = world({ hostMode: "ask" });
    const target = `ls ${home}/Downloads`;
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: "old", choice: "once", action: "run-command", target }).catch(() => null);
    const weekLater = new LocalPolicyStore(dir, () => Date.now() + 7 * 24 * 3_600_000 + 60_000, key, { home: () => home });
    expect(weekLater.check({ execId: "x", botId: "b1", approvalId: "old", op: "run-command", command: target })).toMatchObject({ ok: false });
  });
});
