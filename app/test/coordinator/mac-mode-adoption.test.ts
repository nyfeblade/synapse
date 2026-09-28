/**
 * fix-fullauto-adoption. Live 2026-09-21: after the Mac-gate fix the Mac honoured a Bot's Full auto only once the user
 * re-selected the mode in Bot settings (the Mac keeps its own record, local-bot-modes.json, and never trusts the host).
 * The user's Chief of Staff (Full auto on the host, no Mac record) raised 6 "local-tool-permission" cards in 45 s.
 *
 * Now: ONE Mac-side adoption card per Bot ("<Bot> is set to Full auto. Allow it … on this Mac?"). Allow writes the
 * Mac record through the same path as the settings change; Keep asking records that choice for that mode value. The
 * host can't create the record. And (bug #96, filed as #90 on fix-engmem-headless) a waiting Mac card ends the turn
 * instead of holding a running slot: the answer wakes the Bot.
 *
 * REAL host tools + bridge + asks, wired to the REAL Mac daemon + policy store, running real commands in a temp home.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-"));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "adopt-home-")));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-ws-"));
  fs.mkdirSync(path.join(home, "Downloads"));
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(home, "Downloads", `f${i}.pdf`), `pdf${i}`);
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
});

type Mode = "ask" | "accept-edits" | "full-auto";
interface Card { askId: string; status: string; adopt?: Mode; target: string; kind: string }

function world(o: { hostMode: Mode }) {
  const entries = new Map<string, { message?: { card?: Card } }>();
  const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
  let daemon: LocalExecDaemon | null = null;
  const bridge = new LocalBridge({ hub: { publish: (e: SseEvent) => daemon?.onEvent(e) } as never, now: () => Date.now(), workspace: ws, idleMs: 60_000 });
  const wakes: { botId: string; text: string }[] = [];
  const asks = new LocalAsks({ bots, now: () => Date.now(), wake: (botId, text) => wakes.push({ botId, text }) });
  const hostCalls: string[] = [];
  const call = async (cmd: string, args: unknown): Promise<unknown> => {
    const a = args as Record<string, unknown>;
    hostCalls.push(cmd);
    if (cmd === "registerLocalComputer") { bridge.register(a.computer as LocalComputer); return {}; }
    if (cmd === "localExecHeartbeat") return { pending: [] };
    if (cmd === "localExecOutput") { bridge.output(String(a.execId), a.stream as "stdout", String(a.chunk)); return {}; }
    if (cmd === "localExecDone") { bridge.done(String(a.execId), a as never); return {}; }
    if (cmd === "setAgentPermMode") return {};
    if (cmd === "resolveLocalToolPermission") return { status: asks.resolve(String(a.id), String(a.askId), a.choice as never) };
    throw new Error(`unexpected ${cmd}`);
  };
  const policy = new LocalPolicyStore(dir, Date.now, key, { home: () => home, userData: () => path.join(home, "Library", "Application Support", "Synapse") });
  policy.update({ localRoot: home });
  daemon = new LocalExecDaemon({ call, policy, executor: new LocalExecutor({ root: () => policy.current().localRoot, userData: () => dir, fullAccess: () => true }), heartbeatMs: 3_600_000 });
  bridge.register(policy.current());
  bridge.heartbeat(policy.current().computerId);
  // One turn slot per call (each its own turn number, so every card gets its own transcript entry id).
  const slots: { awaitingUserSelection?: boolean }[] = [];
  const tools = (botId: string) => {
    const slot = { turnNo: slots.length + 1, nextSendK: 0, requestId: "r", segment: 0 } as { awaitingUserSelection?: boolean };
    slots.push(slot);
    return createLocalTools({ botId, slot: () => slot as never, bridge, asks, now: () => Date.now(), permMode: () => o.hostMode, workspace: ws });
  };
  const run = async (botId: string, tool: string, input: Record<string, unknown>) => tools(botId).find((x) => x.name === tool)!.handler(input as never);
  const cards = () => [...entries.values()].map((e) => e.message?.card).filter((c): c is Card => !!c);
  const pending = () => cards().filter((c) => c.status === "pending");
  const answer = (botId: string, c: Card, choice: "once" | "deny" | "always") =>
    daemon!.intercept("resolveLocalToolPermission", { id: botId, askId: c.askId, choice, action: c.adopt ? undefined : "run-command", target: c.target, adopt: c.adopt });
  return { daemon: daemon!, policy, run, cards, pending, answer, asks, wakes, slots, hostCalls, bridge };
}

const six = () => Array.from({ length: 6 }, (_, i) => `cat ${home}/Downloads/f${i}.pdf`);

describe("Full auto on the host, no record on the Mac: one adoption card, not one card per command", () => {
  it("six rapid requests raise ONE adoption card (no per-command cards) and end the turn without holding a slot", async () => {
    const w = world({ hostMode: "full-auto" });
    const results = await Promise.all(six().map((command) => w.run("cos", "ExternalShell", { command })));
    expect(w.cards()).toHaveLength(1);
    const [c] = w.cards();
    expect(c).toMatchObject({ kind: "local-tool-permission", adopt: "full-auto", status: "pending" });
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(r.text).toBe(STR5.localAdoptWaiting("full-auto"));
    }
    for (const s of w.slots) expect(s.awaitingUserSelection).toBe(true); // the runner ends every turn right here
    expect(w.policy.botMode("cos")).toBe("ask"); // nothing written until the user answers ON THE MAC
  });

  it("Allow on this Mac writes the Mac record; the woken Bot's six commands then run with no further card", async () => {
    const w = world({ hostMode: "full-auto" });
    await Promise.all(six().map((command) => w.run("cos", "ExternalShell", { command })));
    const [c] = w.pending();
    await w.answer("cos", c!, "once");
    expect(w.policy.botMode("cos")).toBe("full-auto");
    expect(w.cards()[0]!.status).toBe("allowed");
    expect(w.wakes).toHaveLength(1); // one resume for the whole batch
    expect(w.wakes[0]!.text).toContain(`${home}/Downloads/f5.pdf`); // it names what was waiting
    const rerun = await Promise.all(six().map((command) => w.run("cos", "ExternalShell", { command })));
    rerun.forEach((r, i) => { expect(r.isError ?? false).toBe(false); expect(r.text).toContain(`pdf${i}`); });
    expect(w.cards()).toHaveLength(1); // no further card
  });

  it("after adoption, NEVER is still refused and ALWAYS-ASK still cards", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    await w.answer("cos", w.pending()[0]!, "once");
    const never = await w.run("cos", "ExternalShell", { command: `cat ${home}/.ssh/id_rsa` });
    expect(never.isError).toBe(true);
    expect(never.text).not.toContain("KEY");
    expect(w.pending()).toHaveLength(0);
    const rm = await w.run("cos", "ExternalShell", { command: `rm -rf ${home}/Downloads/f0.pdf` });
    expect(rm.isError).toBe(true);
    const card = w.pending()[0]!;
    expect(card.adopt).toBeUndefined(); // a per-command card
    expect(fs.existsSync(path.join(home, "Downloads", "f0.pdf"))).toBe(true);
    await w.answer("cos", card, "once");
    const again = await w.run("cos", "ExternalShell", { command: `rm -rf ${home}/Downloads/f0.pdf` }); // the woken re-run
    expect(again.isError ?? false).toBe(false);
    expect(fs.existsSync(path.join(home, "Downloads", "f0.pdf"))).toBe(false);
  });

  it("Keep asking: per-command cards from then on, and the adoption card does not come back for that mode", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    await w.answer("cos", w.pending()[0]!, "deny");
    expect(w.policy.botMode("cos")).toBe("ask");
    expect(w.wakes.at(-1)!.text).toBe(STR5.localAdoptKept("full-auto"));
    await Promise.all(six().slice(0, 2).map((command) => w.run("cos", "ExternalShell", { command })));
    const p = w.pending();
    expect(p).toHaveLength(2);
    for (const c of p) expect(c.adopt).toBeUndefined();
    // a new Mac process (restart) still remembers the choice
    const later = new LocalPolicyStore(dir, Date.now, key, { home: () => home });
    expect(later.check({ execId: "x", botId: "cos", approvalId: null, op: "run-command", command: `ls ${home}/Downloads`, hostMode: "full-auto" })).toMatchObject({ ok: false, reason: expect.not.stringMatching(/^adopt-mode:/) });
    // …but only for that mode value: a different mode asks once again
    expect(later.check({ execId: "x", botId: "cos", approvalId: null, op: "run-command", command: `ls ${home}/Downloads`, hostMode: "accept-edits" })).toMatchObject({ ok: false, reason: expect.not.stringMatching(/^adopt-mode:/) });
    later.update({ addAutoRunRoot: path.join(home, "Downloads") }); // a project dir, so Auto-accept edits would run this edit
    expect(later.check({ execId: "x", botId: "cos", approvalId: null, op: "edit-file", path: `${home}/Downloads/f1.pdf`, oldString: "p", newString: "q", hostMode: "accept-edits" })).toMatchObject({ ok: false, reason: expect.stringMatching(/^adopt-mode:/) });
  });

  it("the records disagree (Mac says Auto-accept edits, host says Full auto): the adoption card asks for Full auto", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.daemon.intercept("setAgentPermMode", { id: "cos", mode: "accept-edits" });
    await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    expect(w.pending()).toEqual([expect.objectContaining({ adopt: "full-auto" })]);
  });

  it("a Mac record MORE permissive than the host's mode is capped by the host's (a lower claim only restricts)", async () => {
    const w = world({ hostMode: "ask" });
    await w.daemon.intercept("setAgentPermMode", { id: "cos", mode: "full-auto" });
    expect(w.policy.check({ execId: "x", botId: "cos", approvalId: null, op: "run-command", command: `ls ${home}/Downloads`, hostMode: "ask" }).ok).toBe(false);
  });
});

describe("the security property: the host can't grant itself Full auto on the Mac", () => {
  it("a host claim alone never writes the record, and a host-side 'answer' to the adoption card writes nothing", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    expect(w.policy.botMode("cos")).toBe("ask");
    const c = w.pending()[0]!;
    w.asks.resolve("cos", c.askId, "once"); // the host settles its own card (compromised host): the Mac never saw a user answer
    expect(w.policy.botMode("cos")).toBe("ask");
    expect(w.policy.check({ execId: "x", botId: "cos", approvalId: null, op: "run-command", command: `ls ${home}/Downloads`, hostMode: "full-auto" }).ok).toBe(false);
    // and the file is HMAC'd: forging it falls back to Ask
    fs.writeFileSync(path.join(dir, "local-bot-modes.json"), JSON.stringify({ data: { cos: "full-auto" }, mac: "00" }));
    expect(w.policy.botMode("cos")).toBe("ask");
  });
});

describe("re-selecting the mode in Bot settings writes the Mac record (audit)", () => {
  it("re-sending the SAME mode through the coordinator writes the record (keyed by the host's Bot id)", async () => {
    const w = world({ hostMode: "full-auto" });
    expect(await w.daemon.intercept("getLocalBotMode", { id: "cos" })).toEqual({ handled: true, result: { mode: "ask" } });
    await w.daemon.intercept("setAgentPermMode", { id: "cos", mode: "full-auto" });
    expect(w.policy.botMode("cos")).toBe("full-auto");
    expect(await w.daemon.intercept("getLocalBotMode", { id: "cos" })).toEqual({ handled: true, result: { mode: "full-auto" } });
    const r = await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    expect(r.text).toContain("f0.pdf");
    expect(w.cards()).toHaveLength(0);
  });

  it("a settings change clears an earlier Keep asking, so choosing the mode again takes effect", async () => {
    const w = world({ hostMode: "full-auto" });
    await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    await w.answer("cos", w.pending()[0]!, "deny");
    await w.daemon.intercept("setAgentPermMode", { id: "cos", mode: "full-auto" });
    const r = await w.run("cos", "ExternalShell", { command: `ls ${home}/Downloads` });
    expect(r.text).toContain("f0.pdf");
  });
});

describe("bug #96: a waiting Mac card ends the turn instead of holding a running slot", () => {
  it("an Ask-mode card returns at once (awaiting the user), and the late answer's approval runs the woken re-run", async () => {
    const w = world({ hostMode: "ask" });
    const cmd = `ls ${home}/Downloads`;
    const r = await w.run("b1", "ExternalShell", { command: cmd }); // resolves without anyone answering
    expect(r).toEqual({ text: STR5.localAskWaiting, isError: true });
    expect(w.slots.at(-1)!.awaitingUserSelection).toBe(true);
    const c = w.pending()[0]!;
    await w.answer("b1", c, "once");
    expect(w.wakes).toEqual([{ botId: "b1", text: STR5.localAskResumed(cmd) }]);
    const rerun = await w.run("b1", "ExternalShell", { command: cmd });
    expect(rerun.text).toContain("f0.pdf");
  });
});
