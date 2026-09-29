import type { MessagePortMain } from "electron";
import type { BotSummary } from "@synapse/shared";
import { GatewayClient, notConnectedMessage, type ConnectionState } from "./gateway-client";
import { VncProxy } from "./vnc-proxy";
import type { LocalExecDaemon, BrowserCall, BrowserResult, MacAppCallMsg, MacAppResultMsg } from "./local-exec/daemon";
import { createLocalDaemon } from "./local-exec/wiring";
import type { MacKeyProxy } from "./local-exec/mac-key-proxy";
import type { MacKeyStore } from "./local-exec/wiring";
import { NotificationPolicy } from "./notification-policy";
import { startOAuthLoopback } from "./oauth-loopback";
import { installProcessGuards } from "./guards";

installProcessGuards(process);

let client: GatewayClient | null = null;
let daemon: LocalExecDaemon | null = null;
let keyProxy: MacKeyProxy | null = null;
let macKey: MacKeyStore | null = null;
let rport: MessagePortMain | null = null;
let lastState: ConnectionState = { kind: "starting" };
const outbox: unknown[] = [];
let loopback: Promise<{ port: number; close(): void }> | null = null;

let upstream: { baseUrl: string; token: string } | null = null;
// The VNC proxy dials the gateway with the token only once this connection's host is proven (gateway-client.ts).
const vnc = new VncProxy({ upstream: () => upstream, prove: async () => (client ? client.provenForUse() : false) });
const vncReady = vnc.start();

const policy = new NotificationPolicy({
  now: Date.now,
  notify: (n) => process.parentPort.postMessage({ type: "notify", botId: n.botId, title: n.title, body: n.body }),
  badge: (count) => process.parentPort.postMessage({ type: "badge", count }),
});

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

async function onRendererMessage(data: { id: number; cmd: string; args: unknown }): Promise<void> {
  if (!client) return post({ id: data.id, response: { ok: false, error: { code: "NOT_CONNECTED", message: notConnectedMessage(lastState) } } });
  try {
    const local = daemon ? await daemon.intercept(data.cmd, data.args) : { handled: false as const };
    if (local.handled) return post({ id: data.id, response: { ok: true, result: local.result } });
    const result = await client.call(data.cmd as never, data.args as never);
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
    const m = msg as unknown as { op?: string; key?: string };
    if (!macKey) reply({ ok: false, error: "This Mac's Bots aren't connected yet. Try again in a moment." });
    else if (m.op === "save" && typeof m.key === "string") void macKey.save(m.key).then((r) => reply({ ok: true, result: r }), (e: Error) => reply({ ok: false, error: e.message }));
    else if (m.op === "clear") { try { macKey.clear(); reply({ ok: true }); } catch (e) { reply({ ok: false, error: (e as Error).message }); } }
    else if (m.op === "has") reply({ ok: true, result: macKey.has() });
    else reply({ ok: false, error: "unknown" });
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
        else if (ev.channel === "agents") policy.remove(ev.payload.removedId);
        daemon?.onEvent(ev);
        post({ event: ev });
      },
      onState: setState,
    });
    client.start();
    void vncReady.then((v) => post({ vnc: v }));
    void client
      .call("listAgents", {} as never)
      .then((r) => policy.baseline((r as { agents: BotSummary[] }).agents))
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
  } else if (msg.type === "focus") {
    policy.setFocused(Boolean((msg as { focused?: boolean }).focused));
  }
});
