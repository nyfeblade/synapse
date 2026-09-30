import type { MacRulesView, SafetyRule } from "@synapse/shared";
import type { LocalPolicyStore } from "./local-exec/policy";
import type { MessagePortMain } from "electron";
import type { BotSummary } from "@synapse/shared";
import { GatewayClient, notConnectedMessage, type ConnectionState } from "./gateway-client";
import { VncProxy } from "./vnc-proxy";
import type { LocalExecDaemon, BrowserCall, BrowserResult, MacAppCallMsg, MacAppResultMsg } from "./local-exec/daemon";
import { createLocalDaemon } from "./local-exec/wiring";
import type { MacKeyProxy } from "./local-exec/mac-key-proxy";
import type { MacKeyStore } from "./local-exec/wiring";
import { NotificationPolicy } from "./notification-policy";
import { WorkNotifier } from "./work-notifier";
import { startOAuthLoopback } from "./oauth-loopback";
import { installProcessGuards } from "./guards";
import { forTelegram } from "../main/telegram/events";

installProcessGuards(process);

let client: GatewayClient | null = null;
let daemon: LocalExecDaemon | null = null;
/** Safety v2: the owner's rules as the host last sent them, and the Mac gate that applies them. */
let macRules: MacRulesView | null = null;
let localPolicy: LocalPolicyStore | null = null;
let keyProxy: MacKeyProxy | null = null;
let macKey: MacKeyStore | null = null;
let rport: MessagePortMain | null = null;
let lastState: ConnectionState = { kind: "starting" };
const outbox: unknown[] = [];
let loopback: Promise<{ port: number; close(): void }> | null = null;
/** Wave 4.1: main's Telegram bridge is on and wants the Bots' send-message events. */
let telegramWatch = false;

let upstream: { baseUrl: string; token: string } | null = null;
// The VNC proxy dials the gateway with the token only once this connection's host is proven (gateway-client.ts).
const vnc = new VncProxy({ upstream: () => upstream, prove: async () => (client ? client.provenForUse() : false) });
const vncReady = vnc.start();

const policy = new NotificationPolicy({
  now: Date.now,
  notify: (n) => process.parentPort.postMessage({ type: "notify", botId: n.botId, title: n.title, body: n.body, ...(n.approvalId ? { approvalId: n.approvalId } : {}) }),
  badge: (count) => process.parentPort.postMessage({ type: "badge", count }),
});

// 4.4: "<Bot> finished" (the host's work-finished event), not for the chat the owner is looking at, bursts as one.
const work = new WorkNotifier({
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  notify: (n) => process.parentPort.postMessage({ type: "notify", botId: n.botId, title: n.title, body: n.body, ...(n.telegram ? { telegram: n.telegram } : {}) }),
});
let focused = true;

// mac-browser: the browser controller lives in the main process (it owns the Chrome process and the fallback window).
// Requests go up the parent port and come back as "browser-result"; a main that never answers can't wedge a Bot.
let browserSeq = 0;
const browserWaits = new Map<number, (r: unknown) => void>();
function toMain<T>(m: Record<string, unknown>, fallback: T, ms: number): Promise<T> {
  const id = ++browserSeq;
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => { browserWaits.delete(id); resolve(fallback); }, ms);
    browserWaits.set(id, (r) => { clearTimeout(t); resolve(r as T); });
    process.parentPort.postMessage({ ...m, id });
  });
}
const browserRpc = (c: BrowserCall) => toMain<BrowserResult>({ type: "browser", req: c }, { ok: false, error: "The browser on this Mac didn't answer in time." }, 5 * 60_000);
const browserOrigin = (botId: string) => toMain<string | null>({ type: "browser-origin", botId }, null, 10_000);
// mac-apps: the MacApp controller lives in the main process too (it owns the warm helper and the app scripts).
const macappRpc = (c: MacAppCallMsg) => toMain<MacAppResultMsg>({ type: "macapp", req: c }, { ok: false, error: "The apps on this Mac didn't answer in time." }, 2 * 60_000);
// Bug 258 (fix round): the No limits confirm is a per-dialog nonce main issued; the daemon checks it once with main.
const verifyNoLimits = (nonce: string) => toMain<boolean>({ type: "nolimits-verify", nonce }, false, 10_000);

const post = (m: unknown): void => {
  if (rport) rport.postMessage(m);
  else outbox.push(m);
};
const setState = (s: ConnectionState) => {
  lastState = s;
  post({ connection: s });
  // Main reuses this client's proof of host while the stream is up (main/host-fetch.ts).
  process.parentPort.postMessage({ type: "conn-state", kind: s.kind });
};

/** A renderer command: this Mac's gate first (LOC-05), then the host. Telegram's Mac-card answers come through here too. */
async function dispatch(cmd: string, args: unknown): Promise<unknown> {
  // 4.4: the chat the owner has open (the renderer opens one with openAgent), for the work-finished focus rule.
  if (cmd === "openAgent" && typeof (args as { id?: unknown })?.id === "string") work.setActiveBot((args as { id: string }).id);
  const local = daemon ? await daemon.intercept(cmd, args) : { handled: false as const };
  if (local.handled) return local.result;
  return client!.call(cmd as never, args as never);
}

async function onRendererMessage(data: { id: number; cmd: string; args: unknown }): Promise<void> {
  if (!client) return post({ id: data.id, response: { ok: false, error: { code: "NOT_CONNECTED", message: notConnectedMessage(lastState) } } });
  try {
    const result = await dispatch(data.cmd, data.args);
    post({ id: data.id, response: { ok: true, result } });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    post({ id: data.id, response: { ok: false, error: { code: err.code ?? "NETWORK", message: err.message ?? String(e) } } });
  }
}

process.parentPort.on("message", (e) => {
  const msg = e.data as { type: string; baseUrl?: string; token?: string; hello?: boolean; state?: ConnectionState; userData?: string; legacyPolicyKey?: string; id?: number; result?: unknown };
  if ((msg.type === "browser-result" || msg.type === "macapp-result" || msg.type === "nolimits-verify-result") && typeof msg.id === "number") {
    browserWaits.get(msg.id)?.(msg.result);
    browserWaits.delete(msg.id);
  } else if (msg.type === "mac-key" && typeof msg.id === "number") {
    // Review fix 4: main asks the coordinator (which owns the permission key file) to keep, remove or check the Mac's
    // copy of the API key. The key itself never goes back up.
    const id = msg.id;
    const reply = (result: unknown) => process.parentPort.postMessage({ type: "mac-key-result", id, result });
    const m = msg as unknown as { op?: string; key?: string; keyId?: string; oldId?: string | null };
    const done = (fn: () => unknown) => { try { reply({ ok: true, result: fn() }); } catch (e) { reply({ ok: false, error: (e as Error).message }); } };
    if (!macKey) reply({ ok: false, error: "This Mac's Bots aren't connected yet. Try again in a moment." });
    else if (m.op === "save" && typeof m.key === "string") void macKey.save(m.key).then((r) => reply({ ok: true, result: r }), (e: Error) => reply({ ok: false, error: e.message }));
    else if (m.op === "clear") { try { macKey.clear(); reply({ ok: true }); } catch (e) { reply({ ok: false, error: (e as Error).message }); } }
    else if (m.op === "has") reply({ ok: true, result: macKey.has() });
    // 0.1.7: the copy follows the box's default Anthropic key; other keys added here wait beside it as spares.
    else if (m.op === "save-spare" && typeof m.keyId === "string" && typeof m.key === "string") done(() => macKey!.saveSpare(m.keyId!, m.key!));
    else if (m.op === "drop-spare" && typeof m.keyId === "string") done(() => macKey!.dropSpare(m.keyId!));
    else if (m.op === "promote" && typeof m.keyId === "string") done(() => macKey!.promote(m.keyId!, typeof m.oldId === "string" ? m.oldId : null));
    else reply({ ok: false, error: "unknown" });
  } else if (msg.type === "approval-answer") {
    // Smarter approvals: Approve / Deny on a card's macOS notification. The same gateway command as the in-app card
    // (resolveAutoReviewApproval), so the host's gate is the one code path (fingerprint re-check, stale cards).
    const m = msg as unknown as { botId?: unknown; approvalId?: unknown; choice?: unknown };
    if (client && typeof m.botId === "string" && typeof m.approvalId === "string" && (m.choice === "once" || m.choice === "deny")) {
      void client.call("resolveAutoReviewApproval", { id: m.botId, approvalId: m.approvalId, choice: m.choice }).catch(() => {});
    }
  } else if (msg.type === "renderer-port") {
    rport = e.ports[0] ?? null;
    rport?.on("message", (m) => void onRendererMessage(m.data));
    rport?.start();
    for (const m of outbox.splice(0)) rport?.postMessage(m);
    post({ connection: lastState });
    void vncReady.then((v) => post({ vnc: v }));
  } else if (msg.type === "state" && msg.state) {
    setState(msg.state);
  } else if (msg.type === "connect" && msg.baseUrl && msg.token) {
    client?.stop();
    upstream = { baseUrl: msg.baseUrl, token: msg.token };
    client = new GatewayClient({
      baseUrl: msg.baseUrl,
      token: msg.token,
      // Proof of host before the token is sent (the host answers /hello); a refusal asks main whether the token is stale.
      hello: msg.hello === true,
      onRefused: () => process.parentPort.postMessage({ type: "gateway-refused" }),
      onEvent: (ev) => {
        if (ev.channel === "agent-upserted") policy.update(ev.payload.agent);
        else if (ev.channel === "agents") { policy.remove(ev.payload.removedId); work.remove(ev.payload.removedId); }
        else if (ev.channel === "work-finished") work.onFinished(ev.payload);
        // 4.4: one macOS notification per connector break (the host decided "once"); the tray shows it in the app.
        else if (ev.channel === "connector-alert" && !focused) process.parentPort.postMessage({ type: "notify-app", title: ev.payload.title, body: ev.payload.body, section: "connections" });
        daemon?.onEvent(ev);
        // Safety v2: the owner's rules, for the Mac's own gate (commands, files, the browser and apps on this Mac).
        if (ev.channel === "safety") { macRules = { rules: ev.payload.rules, timeZone: ev.payload.timeZone ?? "UTC" }; localPolicy?.setRules(macRules); }
        // Wave 4.1: only while Telegram is on, and only the Bots' send-message entries (replies and approval cards).
        if (telegramWatch && forTelegram(ev)) {
          process.parentPort.postMessage({ type: "telegram-event", ev });
        }
        post({ event: ev });
      },
      onState: setState,
    });
    client.start();
    void vncReady.then((v) => post({ vnc: v }));
    void client
      .call("getSafety", {} as never)
      .then((v) => { const r = v as { rules?: SafetyRule[]; timeZone?: string }; if (Array.isArray(r.rules)) { macRules = { rules: r.rules, timeZone: r.timeZone ?? "UTC" }; localPolicy?.setRules(macRules); } })
      .catch(() => {});
    void client
      .call("listAgents", {} as never)
      .then((r) => { policy.baseline((r as { agents: BotSummary[] }).agents); work.setActiveBot((r as { activeAgentId?: string | null }).activeAgentId ?? null); })
      .catch(() => {});
    if (msg.userData) {
      // Bug 225: the policy files are HMAC'd with the profile's own local-policy.key (local-exec/policy-key.ts), never
      // the keychain. legacyPolicyKey (the old keychain-derived key) comes only while that file doesn't exist yet,
      // to carry still-valid files over once. Only a tampered/unreadable key file makes a non-durable run, and then
      // Settings offers Reset permissions, which builds the daemon again here.
      const legacyKey = typeof msg.legacyPolicyKey === "string" ? Buffer.from(msg.legacyPolicyKey, "base64") : undefined;
      const userData = msg.userData;
      const build = (legacy?: Buffer) => {
        daemon?.stop();
        void keyProxy?.stop();
        const made = createLocalDaemon({
          userData, legacyKey: legacy, call: (c, a) => client!.call(c as never, a as never), browser: browserRpc, browserOrigin, macapp: macappRpc, verifyNoLimits,
          onReset: () => build(),
        });
        daemon = made.daemon;
        localPolicy = made.policy;
        localPolicy.setRules(macRules);
        keyProxy = made.keyProxy;
        macKey = made.macKey;
        void daemon.start();
      };
      build(legacyKey);
    }
    // P5 review minor: fall back to another registered loopback port when 47823 is taken, and tell the host which one.
    loopback ??= startOAuthLoopback({ ports: [47823, 47824, 47825], complete: (a) => client!.call("completeMcpOAuth", a) })
      .then((lb) => { void client!.call("setOAuthLoopbackPort", { port: lb.port }).catch(() => {}); return lb; })
      .catch((e) => { console.error("oauth loopback unavailable", e); loopback = null; return { port: 0, close: () => {} }; });
  } else if (msg.type === "telegram-local-answer" && typeof msg.id === "number") {
    // Wave 4.1: a Mac card answered from Telegram takes exactly the in-app card's path (the Mac's own gate records the
    // once-approval bound to the card's action and target, then tells the host). Only once / deny, never Always/Never.
    const id = msg.id;
    const a = (msg as unknown as { args?: { id?: unknown; askId?: unknown; choice?: unknown; action?: unknown; target?: unknown } }).args;
    const reply = (m: Record<string, unknown>) => process.parentPort.postMessage({ type: "telegram-local-answer-result", id, ...m });
    if (!client || !daemon) reply({ ok: false, error: notConnectedMessage(lastState) });
    else if (!a || typeof a.id !== "string" || typeof a.askId !== "string" || (a.choice !== "once" && a.choice !== "deny") || typeof a.action !== "string" || typeof a.target !== "string") reply({ ok: false, error: "bad answer" });
    else void dispatch("resolveLocalToolPermission", { id: a.id, askId: a.askId, choice: a.choice, action: a.action, target: a.target })
      .then((result) => reply({ ok: true, result }), (e: Error) => reply({ ok: false, error: e.message }));
  } else if (msg.type === "telegram-watch") {
    telegramWatch = (msg as { on?: unknown }).on === true;
  } else if (msg.type === "focus") {
    focused = Boolean((msg as { focused?: boolean }).focused);
    policy.setFocused(focused);
    work.setFocused(focused);
  }
});
