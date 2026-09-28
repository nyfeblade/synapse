/**
 * policy-key-file (bug 225), the security half: the permission key and files now live in the app's own data folder
 * with no keychain around them, so the Mac tools a Bot can reach (ExternalRead, ExternalShell, the Mac file tool,
 * CopyToBox, CopyFromBox) must never read or copy the key and never write the signed files — in every permission
 * mode, Full auto included, and even when the user clicks Allow on a card for it. A Bot that could read the key
 * could sign itself any grant.
 *
 * Real host tools + bridge + asks wired to the real Mac daemon, policy store and executor, as mac-gate-modes does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LocalComputer, type SseEvent } from "@synapse/shared";
import { LocalExecDaemon } from "../../src/coordinator/local-exec/daemon";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { loadPolicyKey, POLICY_KEY_FILE } from "../../src/coordinator/local-exec/policy-key";
import { LocalAsks } from "../../../host/local/asks";
import { LocalBridge } from "../../../host/local/bridge";
import { createLocalTools } from "../../../host/local/local-tools";

type Mode = "ask" | "accept-edits" | "full-auto";

let home: string;
let ws: string;
let userData: string;
let key: Buffer;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pk-sec-home-")));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "pk-sec-ws-"));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(home, "Projects"));
  fs.writeFileSync(path.join(ws, "evil.json"), JSON.stringify({ data: { grants: [] }, mac: "00" }));
  const k = loadPolicyKey(userData);
  if (!k.ok) throw new Error("no key");
  key = k.key;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

function world(mode: Mode) {
  const entries = new Map<string, { message?: { card?: { askId: string; status: string; action: string; target: string } } }>();
  const bots = { appendEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), updateEntry: (_b: string, e: { id: string }) => entries.set(e.id, e as never), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
  let daemon: LocalExecDaemon | null = null;
  const bridge = new LocalBridge({ hub: { publish: (e: SseEvent) => daemon?.onEvent(e) } as never, now: () => Date.now(), workspace: ws, idleMs: 60_000 });
  const asks = new LocalAsks({ bots, now: () => Date.now() });
  const call = async (cmd: string, args: unknown): Promise<unknown> => {
    const a = args as Record<string, unknown>;
    if (cmd === "registerLocalComputer") { bridge.register(a.computer as LocalComputer); return {}; }
    if (cmd === "localExecHeartbeat") return { pending: [] };
    if (cmd === "localExecOutput") { bridge.output(String(a.execId), a.stream as "stdout", String(a.chunk)); return {}; }
    if (cmd === "localExecDone") { bridge.done(String(a.execId), a as never); return {}; }
    if (cmd === "localExecUpload") { bridge.upload(String(a.execId), Number(a.offset), String(a.bytesBase64), Boolean(a.final)); return {}; }
    if (cmd === "readLocalFile") return bridge.readWorkspaceFile(String(a.path), Number(a.offset), Number(a.length));
    if (cmd === "setAgentPermMode") return {};
    if (cmd === "resolveLocalToolPermission") return { status: asks.resolve(String(a.id), String(a.askId), a.choice as never) };
    throw new Error(`unexpected ${cmd}`);
  };
  // As the app wires it (local-exec/wiring.ts): the policy files are IN userData, and both the policy and the executor know it.
  const policy = new LocalPolicyStore(userData, Date.now, key, { home: () => home, userData: () => userData });
  policy.update({ localRoot: home, addAutoRunRoot: path.join(home, "Projects") });
  daemon = new LocalExecDaemon({ call, policy, executor: new LocalExecutor({ root: () => policy.current().localRoot, home: () => home, userData: () => userData, fullAccess: () => true }), heartbeatMs: 3_600_000 });
  bridge.register(policy.current());
  bridge.heartbeat(policy.current().computerId);
  const tools = createLocalTools({ botId: "b1", slot: () => ({ turnNo: 1, nextSendK: 0, requestId: "r", segment: 0 }) as never, bridge, asks, now: () => Date.now(), permMode: () => mode, workspace: ws });
  const pendingCard = () => [...entries.values()].map((e) => e.message?.card).find((c) => c && c.status === "pending") ?? null;
  const once = async (tool: string, input: Record<string, unknown>) => tools.find((x) => x.name === tool)!.handler(input as never) as Promise<{ text: string; isError?: boolean }>;
  /** Runs the tool; if a card comes up, the user clicks Allow once and the Bot runs it again. */
  const attempt = async (tool: string, input: Record<string, unknown>) => {
    const p = once(tool, input);
    let card = null as ReturnType<typeof pendingCard>;
    const done = await Promise.race([p.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 300))]);
    card = pendingCard();
    if (!card) return p;
    await daemon!.intercept("resolveLocalToolPermission", { id: "b1", askId: card.askId, choice: "once", action: card.action, target: card.target });
    const first = await p;
    return done && !first.isError ? first : once(tool, input);
  };
  return { daemon: daemon!, policy, attempt, once, pendingCard };
}

const MODES: Mode[] = ["ask", "accept-edits", "full-auto"];
/** Refused: an error, or (for a shell command the sandbox stopped) a failing exit. */
const refused = (r: { text: string; isError?: boolean }) => r.isError === true || /\[exit code [1-9]\d*\]/.test(r.text);

describe.each(MODES)("mode %s: the permission key and files are out of every Mac tool's reach", (mode) => {
  const secretForms = () => [key.toString("hex"), key.toString("base64"), key.toString("latin1")];
  const leaks = (r: { text: string }) => secretForms().some((s) => r.text.includes(s));
  const noBox = () => fs.readdirSync(ws).filter((n) => n !== "evil.json");

  async function setup() {
    const w = world(mode);
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode });
    w.policy.grant("b1", "browser");
    return w;
  }

  it("the key can't be read: ExternalRead, Mac read, ExternalShell (cat, cp, python, cd+relative), CopyToBox", async () => {
    const w = await setup();
    const k = path.join(userData, POLICY_KEY_FILE);
    const tries: Array<[string, Record<string, unknown>]> = [
      ["ExternalRead", { path: k }],
      ["ExternalRead", { path: userData }],
      ["Mac", { action: "read", path: k }],
      ["Mac", { action: "grep", path: userData, pattern: "." }],
      ["ExternalShell", { command: `cat '${k}'` }],
      ["ExternalShell", { command: `xxd '${k}'` }],
      ["ExternalShell", { command: `cp '${k}' '${home}/Projects/k'` }],
      ["ExternalShell", { command: `python3 -c "print(open('${k}','rb').read().hex())"` }],
      ["ExternalShell", { command: `cd '${userData}' && od -An -tx1 ${POLICY_KEY_FILE}` }],
      ["ExternalShell", { command: `cd '${home}/Library' && cat 'Application Support/Synapse/local-policy.key' | base64` }],
      ["ExternalShell", { command: `cat '${home}'/Library/App*/Syn*/local-pol*` }],
      // names nothing the static rules know: only the command sandbox stops it
      ["ExternalShell", { command: `python3 -c "import os; p=os.path.join('${home}','Library','Applic'+'ation Support','Syn'+'apse','local-po'+'licy.k'+'ey'); print(open(p,'rb').read().hex())"` }],
      ["CopyToBox", { local_path: k, box_path: "k.bin" }],
      ["CopyToBox", { local_path: path.join(userData, "local-tool-grants.json"), box_path: "g.json" }],
    ];
    for (const [tool, input] of tries) {
      const r = await w.attempt(tool, input);
      expect(refused(r), `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(leaks(r), `${tool} leaked the key`).toBe(false);
    }
    expect(noBox()).toEqual([]);
    expect(fs.existsSync(path.join(home, "Projects", "k"))).toBe(false);
  });

  // Portable install: the update feed and its (encrypted) read-only token moved out of the keychain into the same
  // folder (update-source.json + update-source.key). The same wall covers them — nothing new to allow-list.
  it("the update source and its key can't be read or copied out either", async () => {
    const w = await setup();
    const src = path.join(userData, "update-source.json");
    const uk = path.join(userData, "update-source.key");
    fs.writeFileSync(src, JSON.stringify({ v: 1, feed: "a/b", token: { iv: "x", tag: "y", ct: "UPDATE-SECRET" } }), { mode: 0o600 });
    fs.writeFileSync(uk, Buffer.alloc(32, 7), { mode: 0o600 });
    const tries: Array<[string, Record<string, unknown>]> = [
      ["ExternalRead", { path: src }],
      ["ExternalRead", { path: uk }],
      ["Mac", { action: "read", path: src }],
      ["ExternalShell", { command: `cat '${src}'` }],
      ["ExternalShell", { command: `cd '${userData}' && base64 update-source.key` }],
      ["CopyToBox", { local_path: src, box_path: "s.json" }],
      ["CopyToBox", { local_path: uk, box_path: "k.bin" }],
    ];
    for (const [tool, input] of tries) {
      const r = await w.attempt(tool, input);
      expect(refused(r), `${tool} ${JSON.stringify(input)}`).toBe(true);
      expect(JSON.stringify(r)).not.toContain("UPDATE-SECRET");
    }
    expect(noBox()).toEqual([]);
  });

  it("the signed permission files and the key can't be written: CopyFromBox, Mac write/edit, ExternalShell redirects", async () => {
    const w = await setup();
    const grants = path.join(userData, "local-tool-grants.json");
    const k = path.join(userData, POLICY_KEY_FILE);
    const before = fs.readFileSync(grants, "utf8");
    const keyBefore = fs.readFileSync(k);
    const tries: Array<[string, Record<string, unknown>]> = [
      ["CopyFromBox", { box_path: "evil.json", local_path: grants }],
      ["CopyFromBox", { box_path: "evil.json", local_path: k }],
      ["Mac", { action: "write", path: grants, content: "{}" }],
      ["Mac", { action: "edit", path: grants, old_string: "browser", new_string: "mac-app" }],
      ["ExternalShell", { command: `echo '{}' > '${grants}'` }],
      ["ExternalShell", { command: `rm -f '${k}'` }],
      ["ExternalShell", { command: `cp '${ws}/evil.json' '${grants}'` }],
      ["ExternalShell", { command: `cp '${ws}/evil.json' '${home}'/Library/App*/Syn*/` }],
    ];
    for (const [tool, input] of tries) {
      const r = await w.attempt(tool, input);
      expect(refused(r), `${tool} ${JSON.stringify(input)}`).toBe(true);
    }
    expect(fs.readFileSync(grants, "utf8")).toBe(before);
    expect(fs.readFileSync(k)).toEqual(keyBefore);
  });
});

/** Bug 229, end to end: in Full auto the host runs a hand-off without a card, the Mac refuses it, and the refusal
 *  becomes the user's card; nothing runs unless that card is approved. */
describe("Full auto: a command that runs outside the sandbox becomes a card", () => {
  it.each([`crontab -l`, `osascript -e 'tell application "Terminal" to do script "ls"'`, `swift --version`])("%s", async (command) => {
    const w = world("full-auto");
    await w.daemon.intercept("setAgentPermMode", { id: "b1", mode: "full-auto" });
    const p = w.once("ExternalShell", { command });
    let card = null as ReturnType<typeof w.pendingCard>;
    for (let i = 0; i < 200 && !card; i++) { await new Promise((r) => setTimeout(r, 10)); card = w.pendingCard(); }
    expect(card).not.toBeNull();
    expect(card!.target).toContain(command);
    await w.daemon.intercept("resolveLocalToolPermission", { id: "b1", askId: card!.askId, choice: "deny", action: card!.action, target: card!.target });
    expect((await p).isError).toBe(true);
  });
});
