import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { registerPhone, type PhoneWire } from "../../src/main/phone/wire";
import { FakeTailscale, fakeSeal, probeThrough } from "../fixtures/fake-tailscale";

// Bug 198: the phone server end to end over real HTTP / WebSocket on the loopback, with the headers
// `tailscale serve` adds put on by the test. The Tailscale CLI is MOCKED (it only records commands).

const LOGIN = "me@example.com";
const DNS = "mac.example-tailnet.ts.net";

let dir: string;
let wire: PhoneWire;
let cli: string[][];
let fake: FakeTailscale;
let emitted: { channel: string; payload: unknown }[];
const handlers = new Map<string, (a: unknown) => unknown>();

// The server only ever listens on its private Unix socket (phone-lifecycle covers how it gets there).
function setup(onResult: FakeTailscale["onResult"] = "ok") {
  // A short root: a Unix socket path has a 104-byte limit.
  dir = fs.mkdtempSync(path.join("/tmp", "phs-"));
  fake = new FakeTailscale(DNS, LOGIN);
  fake.onResult = onResult;
  cli = fake.cli;
  emitted = [];
  handlers.clear();
  wire = registerPhone({
    userData: dir, clientDir: path.join(dir, "none"),
    reg: (n, f) => void handlers.set(n, f as (a: unknown) => unknown),
    emit: (channel, payload) => void emitted.push({ channel, payload }),
    feed: () => true, muteHelper: () => {}, log: () => {},
    tailscale: fake.tailscale(), seal: fakeSeal,
    probe: probeThrough(fake, () => wire.server),
    asset: (p) => (p === "/index.html" ? { type: "text/html; charset=utf-8", body: "<!doctype html><title>Synapse</title>" } : null),
  });
}

async function turnOn() {
  const s = await handlers.get("phone.enable")!({}) as { enabled: boolean };
  expect(s.enabled).toBe(true);
  void handlers.get("phone.bots")!({ bots: [{ id: "bot-nova", name: "Nova", color: "#FFB800", shape: "pebble" }, { id: 7, name: "bad" }] });
  return wire.server.socketPath!;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(port: string, p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    const r = http.request({ socketPath: port, path: p, method: o.method ?? (data ? "POST" : "GET"), headers: { ...(data ? { "content-type": "application/json" } : {}), ...o.headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const tailnet = (extra: Record<string, string> = {}) => ({ "tailscale-user-login": LOGIN, host: DNS, origin: `https://${DNS}`, ...extra });

async function pair(port: string): Promise<string> {
  const { code } = await handlers.get("phone.pair.start")!({}) as { code: string };
  const r = await request(port, "/api/pair", { headers: { ...tailnet(), "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, body: { code } });
  expect(r.status).toBe(200);
  const cookie = String(r.headers["set-cookie"]?.[0] ?? "");
  expect(cookie).toMatch(/^synapse_phone=[A-Za-z0-9_-]{40,};/);
  for (const part of ["HttpOnly", "Secure", "SameSite=Strict"]) expect(cookie).toContain(part);
  return cookie.split(";")[0]!;
}

beforeEach(() => setup());
afterEach(async () => { await wire.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("turning Phone access on and off (mocked Tailscale CLI)", () => {
  it("on: starts the server on its private socket and runs `serve --bg --https=443 unix:<socket>`", async () => {
    const port = await turnOn();
    expect(port).toBe(path.join(dir, "phone", "phone.sock"));
    expect(cli).toContainEqual(["serve", "--bg", "--https=443", `unix:${port}`]);
    expect(cli.every((a) => a[0] === "status" || a[0] === "serve")).toBe(true);
    const s = await handlers.get("phone.status")!({}) as { url: string; qr: { size: number; path: string } };
    expect(s.url).toBe(`https://${DNS}/`);
    expect(s.qr.size).toBeGreaterThan(20);
    // A socket, never a TCP port.
    expect(await new Promise((r) => { const c = http.get({ socketPath: port, path: "/" }, () => r("up")); c.on("error", () => r("down")); })).toBe("up");
    const s2 = (wire.server as unknown as { server: http.Server }).server.address();
    expect(s2).toBe(port);
  });

  it("off: runs `serve --https=443 off` and stops the server", async () => {
    const port = await turnOn();
    await handlers.get("phone.disable")!({});
    expect(cli.at(-1)).toEqual(["serve", "--https=443", "off"]);
    expect(wire.server.listening).toBe(false);
    expect(await new Promise((r) => { const c = http.get({ socketPath: port, path: "/" }, () => r("up")); c.on("error", () => r("down")); })).toBe("down");
    expect(fs.existsSync(port)).toBe(false);
  });

  it("remembers it was on (and the target it mapped), to map again at the next launch", async () => {
    const port = await turnOn();
    await wire.dispose();
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "phone-access.json"), "utf8")) as { enabled: boolean; mapped: string };
    expect(kept).toMatchObject({ enabled: true, mapped: `unix:${port}` });
  });

  it("Serve not enabled for the tailnet: stays off and hands Settings the admin link", async () => {
    await wire.dispose();
    setup("needs-enable");
    const s = await handlers.get("phone.enable")!({}) as { enabled: boolean; enableUrl: string };
    expect(s).toMatchObject({ enabled: false, enableUrl: "https://login.tailscale.com/f/serve?node=n1" });
    expect(wire.server.listening).toBe(false);
  });
});

describe("the gate on every request", () => {
  it("403 without Tailscale's identity header, for another tailnet user, and for a foreign Host", async () => {
    const port = await turnOn();
    expect((await request(port, "/", { headers: { host: DNS } })).status).toBe(403);
    expect((await request(port, "/", { headers: tailnet({ "tailscale-user-login": "friend@example.com" }) })).status).toBe(403);
    expect((await request(port, "/", { headers: tailnet({ host: "evil.example" }) })).status).toBe(403);
    const ok = await request(port, "/", { headers: tailnet() });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("the API needs a paired device; pairing needs the one-time code (POSTed, never in the URL)", async () => {
    const port = await turnOn();
    expect((await request(port, "/api/session", { headers: tailnet() })).body).toBe('{"paired":false}');
    expect((await request(port, "/api/bots", { headers: tailnet() })).status).toBe(401);
    // No code started: nothing pairs. A wrong code: 403. A POST from another origin: 403.
    expect((await request(port, "/api/pair", { headers: tailnet(), body: { code: "123456" } })).status).toBe(403);
    const { code } = await handlers.get("phone.pair.start")!({}) as { code: string };
    expect((await request(port, "/api/pair", { headers: tailnet({ origin: "https://evil.example" }), body: { code } })).status).toBe(403);
    const cookie = await pair(port);
    const bots = await request(port, "/api/bots", { headers: tailnet({ cookie }) });
    expect(JSON.parse(bots.body)).toEqual({ bots: [{ id: "bot-nova", name: "Nova", color: "#FFB800", shape: "pebble" }] });
    // The cookie alone is not enough: still behind the tailnet gate.
    expect((await request(port, "/api/bots", { headers: { cookie, host: DNS } })).status).toBe(403);
    const status = await handlers.get("phone.status")!({}) as { devices: { name: string }[] };
    expect(status.devices.map((d) => d.name)).toEqual(["iPhone"]);
  });

  it("revoking a phone ends its access at once — API and open call socket", async () => {
    const port = await turnOn();
    const cookie = await pair(port);
    const ws = new WebSocket("ws://phone/ws", { createConnection: () => net.connect(port), headers: { ...tailnet({ cookie }) } });
    const hello = await new Promise<{ type: string; bots: unknown[] }>((r, j) => { ws.once("message", (d) => r(JSON.parse(String(d)))); ws.once("error", j); });
    expect(hello.type).toBe("hello");
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    const { devices } = await handlers.get("phone.status")!({}) as { devices: { id: string }[] };
    await handlers.get("phone.devices.revoke")!({ id: devices[0]!.id });
    expect(await closed).toBe(4001);
    expect((await request(port, "/api/bots", { headers: tailnet({ cookie }) })).status).toBe(401);
  });

  it("the call socket refuses no cookie, a foreign Origin, and no tailnet identity", async () => {
    const port = await turnOn();
    const cookie = await pair(port);
    const attempt = (headers: Record<string, string>) => new Promise<string>((r) => {
      const ws = new WebSocket("ws://phone/ws", { createConnection: () => net.connect(port), headers });
      ws.once("open", () => { ws.close(); r("open"); });
      ws.once("unexpected-response", (_q, res) => r(String(res.statusCode)));
      ws.once("error", () => r("error"));
    });
    expect(await attempt(tailnet())).toBe("403");
    expect(await attempt(tailnet({ cookie, origin: "https://evil.example" }))).toBe("403");
    expect(await attempt({ cookie, host: DNS, origin: `https://${DNS}` })).toBe("403");
    expect(await attempt(tailnet({ cookie }))).toBe("open");
  });

  it("push subscriptions only for real push services, from a paired phone", async () => {
    const port = await turnOn();
    const cookie = await pair(port);
    const key = JSON.parse((await request(port, "/api/push/key", { headers: tailnet({ cookie }) })).body) as { publicKey: string };
    expect(Buffer.from(key.publicKey, "base64url").length).toBe(65);
    const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
    const good = { endpoint: "https://web.push.apple.com/QXYZ", keys: { p256dh, auth: Buffer.alloc(16, 1).toString("base64url") } };
    expect((await request(port, "/api/push/subscribe", { headers: tailnet({ cookie }), body: { ...good, endpoint: "https://evil.example/x" } })).status).toBe(400);
    expect((await request(port, "/api/push/subscribe", { headers: tailnet(), body: good })).status).toBe(401);
    expect((await request(port, "/api/push/subscribe", { headers: tailnet({ cookie }), body: good })).status).toBe(200);
    expect(wire.store.read().subs.map((s) => s.endpoint)).toEqual(["https://web.push.apple.com/QXYZ"]);
  });
});

describe("a call from the phone", () => {
  it("asks the call screen to open, and ends it when the phone hangs up", async () => {
    const port = await turnOn();
    const cookie = await pair(port);
    const ws = new WebSocket("ws://phone/ws", { createConnection: () => net.connect(port), headers: tailnet({ cookie }) });
    const msgs: { type: string }[] = [];
    ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(String(d))); });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "call", botId: "bot-nova" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(emitted.filter((e) => e.channel === "phone").map((e) => e.payload)).toEqual([{ type: "call", botId: "bot-nova", seq: 1 }]);
    expect(msgs.map((m) => m.type)).toEqual(["hello", "connecting"]);
    expect(wire.calls.active()).toBe(true);
    ws.send(JSON.stringify({ type: "hangup" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(emitted.filter((e) => e.channel === "phone").map((e) => e.payload)).toContainEqual({ type: "hangup", botId: "bot-nova", seq: 1 });
    expect(wire.calls.active()).toBe(false);
    ws.close();
  });

  it("an unknown Bot is refused", async () => {
    const port = await turnOn();
    const cookie = await pair(port);
    const ws = new WebSocket("ws://phone/ws", { createConnection: () => net.connect(port), headers: tailnet({ cookie }) });
    const msgs: { type: string; reason?: string }[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "call", botId: "nope" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.at(-1)).toEqual({ type: "ended", reason: "unknown-bot" });
    expect(wire.calls.active()).toBe(false);
    ws.close();
  });
});
