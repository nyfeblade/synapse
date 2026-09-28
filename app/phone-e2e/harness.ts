import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LIMITS5 } from "@synapse/shared";
import { emitNative, installNativeIpc, registerNative, tapNative } from "../src/main/native";
import { registerDictation, type DictationEvent } from "../src/main/native/dictation";
import { registerPhone, type PhoneWire } from "../src/main/phone/wire";
import { FakeTailscale, fakeSeal, probeThrough } from "../test/fixtures/fake-tailscale";
import { VoiceLoop } from "../src/renderer/voice/voice-loop";
import { CERT, CLIENT_DIR, helperBinary } from "./setup";

/**
 * Bug 198: the Mac side of a phone call, for the e2e — everything the app runs, minus Electron:
 * the real phone server + wire (main), the real dictation module spawning the real helper with
 * --remote-audio, and the real VoiceLoop driven the way the call screen (VoiceOverlay) drives it.
 * `tailscale serve` is played by an HTTPS proxy that strips any identity header a client sent and
 * adds the owner's, exactly as serve does; the Tailscale CLI itself is mocked (it only records).
 */

export const OWNER = "owner@example.com";
export const BOT = { id: "bot-nova", name: "Nova", color: "#FFB800", shape: "pebble" };

type Reply = (heard: string) => Promise<string>;

let nativeInvoke: ((e: unknown, m: { name: string; args: unknown }) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>) | null = null;
const listeners = new Set<(ch: string, p: unknown) => void>();
let installed = false;

/** The native registry is module-global (one app): install it once for the whole run. */
function installOnce(): void {
  if (installed) return;
  installed = true;
  installNativeIpc({ handle: (_ch: string, fn: never) => { nativeInvoke = fn; } } as never, () => null);
  tapNative((ch, p) => { for (const l of listeners) l(ch, p); });
}

async function call<T = unknown>(name: string, args: unknown = {}): Promise<T> {
  const r = await nativeInvoke!({}, { name, args });
  if (!r.ok) throw new Error(r.error?.message ?? name);
  return r.result as T;
}

/** The call screen's glue (VoiceOverlay.tsx), without React: the same events into the same VoiceLoop. */
class MacCallScreen {
  loop: VoiceLoop;
  session: string | null = null;
  private speaking = new Map<string, () => void>();
  private seq = 0;
  private timer: NodeJS.Timeout;
  private off: () => void;
  greeted = false;
  turns: string[] = [];
  lines: string[] = [];
  events: { at: number; type: string; text?: string; source?: string; interrupted?: boolean }[] = [];

  constructor(private botId: string, private reply: Reply, private log: (l: string) => void) {
    const settle = () => { for (const r of this.speaking.values()) r(); this.speaking.clear(); };
    this.loop = new VoiceLoop({
      start: () => {
        const sessionId = randomUUID();
        this.session = sessionId;
        settle();
        void call("dictation.start", { sessionId, mode: "call", context: [BOT.name] }).catch((e: Error) => log(`start failed ${e.message}`));
      },
      stop: () => void call("dictation.stop", { sessionId: this.session }).catch(() => {}),
      send: async (text) => {
        this.turns.push(text);
        log(`turn → ${text}`);
        const answer = await this.reply(text);
        log(`reply ← ${answer}`);
        setTimeout(() => { this.loop.onBotText(answer, this.botId, `e-${this.turns.length}`); }, 30);
        return {};
      },
      speak: async (text, o) => {
        const id = `sp-${++this.seq}`;
        const done = new Promise<void>((r) => this.speaking.set(id, r));
        this.lines.push(text);
        const r = await call<{ spoken?: boolean }>("dictation.speak", { sessionId: this.session, id, text, ...(o?.queue ? { queue: true } : {}), pauseMs: o?.pauseMs ?? 0 }).catch(() => null);
        if (r?.spoken) return done;
        this.speaking.delete(id);
      },
      cancelSpeech: () => { settle(); if (this.session) void call("dictation.hush", { sessionId: this.session }).catch(() => {}); },
      mute: (m) => void call("dictation.mute", { sessionId: this.session, muted: m }).catch(() => {}),
      now: () => Date.now(), silenceMs: LIMITS5.voiceSilenceMs, helperEndpoints: true,
      notify: (m) => log(`notice: ${m}`),
      members: () => [{ id: this.botId, name: BOT.name }],
      phrase: () => null,
    });
    const onEv = (ch: string, p: unknown) => {
      if (ch !== "dictation") return;
      const e = p as DictationEvent & { sessionId?: string; source?: string };
      if (e.sessionId !== this.session) return;
      if (e.type !== "level") this.events.push({ at: Date.now(), type: e.type, ...("text" in e ? { text: e.text } : {}), ...(e.source ? { source: e.source } : {}), ...(e.type === "speak-end" ? { interrupted: e.interrupted } : {}) });
      if (e.type === "ready" && !this.greeted) { this.greeted = true; void this.loop.say(this.botId, "Hi, it's Nova.", "greeting"); }
      if (e.type === "speech-start") this.loop.onSpeechStart();
      if (e.type === "barge-in") this.loop.onBargeIn();
      if (e.type === "partial") this.loop.onPartial(e.text);
      if (e.type === "likely-end") this.loop.onLikelyEnd(e.text);
      if (e.type === "final") this.loop.onFinal(e.text);
      if (e.type === "speak-audio") this.loop.onAudioOut();
      if (e.type === "speak-end") { this.speaking.get(e.id)?.(); this.speaking.delete(e.id); }
      if (e.type === "error") { log(`helper error ${e.code ?? ""} ${e.message}`); this.loop.onFault(e.message); }
      if (e.type === "end") this.loop.onSessionEnd();
    };
    listeners.add(onEv);
    this.off = () => listeners.delete(onEv);
    this.loop.begin();
    this.timer = setInterval(() => this.loop.tick(), 200);
  }

  close(): void {
    clearInterval(this.timer);
    this.loop.end();
    this.off();
  }
}

/** `tailscale serve`, played locally: HTTPS in front of the loopback server, identity header set, client's own dropped. */
function servePlay(root: () => string | null, login: string): Promise<{ port: number; close(): Promise<void>; forged: number }> {
  // Where serve's "/" points: the phone server's Unix socket, or its loopback port.
  const to = (): { socketPath: string } | { host: string; port: number } => {
    const r = root() ?? "";
    return r.startsWith("unix:") ? { socketPath: r.slice(5) } : { host: "127.0.0.1", port: Number(/:(\d+)$/.exec(r)?.[1] ?? 0) };
  };
  const connect = (cb: () => void) => { const t = to(); return "socketPath" in t ? net.connect(t.socketPath, cb) : net.connect(t.port, t.host, cb); };
  const state = { forged: 0 };
  const headersFor = (h: http.IncomingHttpHeaders) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined) continue;
      if (k.startsWith("tailscale-")) { state.forged++; continue; }
      out[k] = v;
    }
    out["tailscale-user-login"] = login;
    out["tailscale-user-name"] = "Owner";
    return out;
  };
  const server = https.createServer({ key: fs.readFileSync(CERT.key), cert: fs.readFileSync(CERT.cert) }, (req, res) => {
    const up = http.request({ ...to(), method: req.method, path: req.url, headers: headersFor(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on("upgrade", (req, sock: net.Socket, head) => {
    const up = connect(() => {
      const h = headersFor(req.headers);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))];
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: (server.address() as net.AddressInfo).port,
    get forged() { return state.forged; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

export interface Harness {
  url: string;
  wire: PhoneWire;
  screen(): MacCallScreen | null;
  screens: MacCallScreen[];
  phoneEvents: { at: number; type: string; botId?: string }[];
  spawns: string[][];
  log: string[];
  pairCode(): Promise<string>;
  stop(): Promise<void>;
}

export async function startHarness(o: { reply: Reply; allowLoopbackPush?: boolean }): Promise<Harness> {
  installOnce();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-e2e-"));
  const log: string[] = [];
  const say = (l: string) => { log.push(`${new Date().toISOString().slice(11, 23)} ${l}`); };
  const spawns: string[][] = [];
  const children: ChildProcess[] = [];
  const spawnFn = ((bin: string, args: string[], opts: object) => {
    spawns.push(args);
    const c = spawn(bin, args, opts as never);
    children.push(c);
    return c;
  }) as typeof spawn;
  // The CLI is a fake that keeps serve's config; Unix-socket serve is on, as in current Tailscale.
  const fake = new FakeTailscale("pending", OWNER);
  fake.unix = true;
  const fakeRun = fake.run;
  fake.run = async (c, args) => { say(`tailscale ${args.join(" ")}`); return fakeRun(c, args); };
  const wire: PhoneWire = registerPhone({
    userData: dir, clientDir: CLIENT_DIR,
    reg: registerNative, emit: emitNative, log: say,
    feed: (p) => dictation.feedRemote(p),
    muteHelper: (m) => dictation.muteRemote(m),
    tailscale: fake.tailscale(), seal: fakeSeal,
    probe: probeThrough(fake, () => wire.server),
    allowLoopbackPush: o.allowLoopbackPush,
  });
  const dictation = registerDictation({ binary: helperBinary(), spawnFn, remote: wire.calls, log: (l) => say(l), tmpDir: dir });
  // Start the proxy first so the tailnet name (localhost:<proxy port>) is known when Phone access turns on.
  const proxy = await servePlay(() => fake.root, OWNER);
  fake.dns = `localhost:${proxy.port}`;
  const on = await call<{ enabled: boolean; url: string }>("phone.enable");
  if (!on.enabled) throw new Error(`Phone access didn't turn on: ${JSON.stringify(on)}`);
  await call("phone.bots", { bots: [BOT] });

  // The renderer's phone bridge: open / close the call screen when the phone says so.
  const screens: MacCallScreen[] = [];
  let current: MacCallScreen | null = null;
  const phoneEvents: Harness["phoneEvents"] = [];
  let seq = 0;
  const onPhone = (ch: string, p: unknown) => {
    if (ch !== "phone") return;
    const e = p as { type: string; botId: string; seq: number };
    phoneEvents.push({ at: Date.now(), type: e.type, botId: e.botId });
    if (e.type === "call") {
      current?.close();
      seq = e.seq;
      current = new MacCallScreen(e.botId, o.reply, say);
      screens.push(current);
    }
    if (e.type === "hangup" && current) { current.close(); current = null; void call("phone.callEnded", { botId: e.botId, seq: e.seq }); }
  };
  listeners.add(onPhone);
  return {
    url: `https://localhost:${proxy.port}/`,
    wire, screens, phoneEvents, spawns, log,
    screen: () => current,
    pairCode: async () => (await call<{ code: string }>("phone.pair.start")).code,
    stop: async () => {
      listeners.delete(onPhone);
      current?.close();
      void seq;
      wire.quit();
      await wire.dispose();
      await proxy.close();
      for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
