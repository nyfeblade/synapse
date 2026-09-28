import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PhoneStore } from "../../src/main/phone/store";
import { CALL_RATE } from "../../src/main/phone/server";
import { MAX_OFF_TRIES_WITHOUT_CLI, registerPhone, type PhoneWire } from "../../src/main/phone/wire";
import { FakeTailscale, fakeSeal, probeThrough } from "../fixtures/fake-tailscale";

// Bug 198, security reviews of 0aca077b and ccaf6939: serve reaches ONLY Synapse's private socket;
// the mapping lives while the app does, is verified, and a mapping Synapse left behind is removed.
// The Tailscale CLI is a FAKE that keeps serve's config (test/fixtures/fake-tailscale.ts).

const LOGIN = "me@example.com";
const DNS = "mac.example-tailnet.ts.net";
const dirs: string[] = [];
const wires: PhoneWire[] = [];

function make(o: { dir?: string; probe?: (u: string) => Promise<string | null>; fake?: FakeTailscale } = {}) {
  // A short root: a Unix socket path has a 104-byte limit.
  const dir = o.dir ?? fs.mkdtempSync(path.join("/tmp", "ph-"));
  if (!o.dir) dirs.push(dir);
  const fake = o.fake ?? new FakeTailscale(DNS, LOGIN);
  const handlers = new Map<string, (a: unknown) => unknown>();
  const logs: string[] = [];
  const wire: PhoneWire = registerPhone({
    userData: dir, clientDir: path.join(dir, "none"),
    reg: (n, f) => void handlers.set(n, f as (a: unknown) => unknown),
    emit: () => {}, feed: () => true, muteHelper: () => {}, log: (l) => logs.push(l),
    tailscale: fake.tailscale(), seal: fakeSeal, retryOffMs: 20,
    probe: o.probe ?? probeThrough(fake, () => wire.server),
    asset: () => null,
  });
  wires.push(wire);
  const call = <T>(n: string, a: unknown = {}) => handlers.get(n)!(a) as Promise<T>;
  const sock = path.join(dir, "phone", "phone.sock");
  return { dir, fake, wire, call, logs, sock, target: `unix:${sock}` };
}

afterEach(async () => {
  for (const w of wires.splice(0)) await w.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const state = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "phone-access.json"), "utf8")) as { enabled: boolean; mapped: string | null; offPending: boolean };

describe("socket only: serve points at Synapse's private socket, never a TCP port", () => {
  it("serves unix:<userData>/phone/phone.sock, the folder 0700 and the socket 0600, with no TCP listener", async () => {
    const t = make();
    const s = await t.call<{ enabled: boolean }>("phone.enable");
    expect(s.enabled).toBe(true);
    expect(t.fake.root).toBe(t.target);
    expect(t.fake.cli).toContainEqual(["serve", "--bg", "--https=443", t.target]);
    expect(fs.statSync(path.dirname(t.sock)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(t.sock).mode & 0o777).toBe(0o600);
    expect((t.wire.server as unknown as { server: http.Server }).server.address()).toBe(t.sock);
    expect(t.fake.cli.some((a) => a.some((x) => x.startsWith("http://127.0.0.1")))).toBe(false);
  });

  it("serve can't reach the socket: Phone access fails with that error — no downgrade to a port — and nothing stays mapped", async () => {
    const t = make({ probe: async () => null });
    const s = await t.call<{ enabled: boolean; error: string }>("phone.enable");
    expect(s).toMatchObject({ enabled: false, error: "unreachable" });
    expect(t.fake.root).toBeNull();
    expect(t.wire.server.listening).toBe(false);
    expect(t.fake.cli.filter((a) => a[1] === "--bg")).toEqual([["serve", "--bg", "--https=443", t.target]]);
    expect(state(t.dir)).toMatchObject({ enabled: false, mapped: null, offPending: false });
    // Retry: the same button calls enable again, and works once serve can reach it.
    const again = make({ dir: t.dir, fake: t.fake });
    expect(await again.call("phone.enable")).toMatchObject({ enabled: true, error: null });
  });

  it("a Tailscale that can't serve a Unix socket at all: a clear error, nothing run", async () => {
    const t = make();
    t.fake.unix = false;
    expect(await t.call("phone.enable")).toMatchObject({ enabled: false, error: "no-unix" });
    expect(t.fake.cli.some((a) => a[1] === "--bg")).toBe(false);
  });

  it("the socket's folder must be a real private folder of this user's (a planted symlink is refused)", async () => {
    const dir = fs.mkdtempSync(path.join("/tmp", "ph-"));
    dirs.push(dir);
    const elsewhere = fs.mkdtempSync(path.join("/tmp", "ph-x-"));
    dirs.push(elsewhere);
    fs.symlinkSync(elsewhere, path.join(dir, "phone"));
    const t = make({ dir });
    expect(await t.call("phone.enable")).toMatchObject({ enabled: false, error: "unsafe-dir" });
    expect(t.fake.cli.some((a) => a[1] === "--bg")).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});

describe("live only when serve status shows exactly our socket AND the probe answers with this listener", () => {
  it("someone else answering is refused, and the mapping is taken back", async () => {
    const t = make({ probe: async () => "impostor" });
    expect(await t.call("phone.enable")).toMatchObject({ enabled: false, error: "not-ours" });
    expect(t.fake.root).toBeNull();
    expect(t.wire.server.listening).toBe(false);
  });

  it("serve status not showing exactly our socket after serve on: not on, and not left mapped", async () => {
    const t = make();
    const run = t.fake.run;
    t.fake.run = async (c, args) => { const r = await run(c, args); if (args[1] === "--bg") t.fake.root = `unix:/evil${t.sock}`; return r; };
    const t2 = make({ dir: t.dir, fake: t.fake });
    expect(await t2.call("phone.enable")).toMatchObject({ enabled: false, error: "not-mapped" });
    // Not exactly ours, so never "turned off" by Synapse either.
    expect(t.fake.root).toBe(`unix:/evil${t.sock}`);
    expect(t.fake.cli.some((a) => a.join(" ") === "serve --https=443 off")).toBe(false);
  });

  it("serve on failing: the server stops, and a mapping it may have set anyway is removed", async () => {
    const t = make();
    t.fake.onResult = "fail";
    const run = t.fake.run;
    t.fake.run = async (c, args) => { const r = await run(c, args); if (args[1] === "--bg") t.fake.root = t.target; return r; };
    const t2 = make({ dir: t.dir, fake: t.fake });
    const s = await t2.call<{ enabled: boolean }>("phone.enable");
    expect(s.enabled).toBe(false);
    expect(t2.wire.server.listening).toBe(false);
    expect(t.fake.root).toBeNull();
  });
});

describe("the mapping lives only as long as the app", () => {
  it("at quit it is removed if :443 is still exactly ours; the next launch maps and verifies again", async () => {
    const a = make();
    await a.call("phone.enable");
    a.wire.quit();
    expect(a.fake.syncOffs).toBe(1);
    expect(a.fake.root).toBeNull();
    expect(state(a.dir)).toMatchObject({ enabled: true, mapped: null });
    await a.wire.dispose();
    const b = make({ dir: a.dir, fake: a.fake });
    await b.wire.resume();
    expect(b.wire.isLive()).toBe(true);
    expect(b.fake.root).toBe(b.target);
  });

  it("at quit, a :443 root that is no longer ours is left alone", async () => {
    const a = make();
    await a.call("phone.enable");
    a.fake.root = "http://127.0.0.1:3000";
    a.wire.quit();
    expect(a.fake.syncOffs).toBe(0);
    expect(a.fake.root).toBe("http://127.0.0.1:3000");
  });

  it("a failed removal at quit is remembered, and the next launch removes it even with Phone access off", async () => {
    const a = make();
    await a.call("phone.enable");
    a.fake.offResult = "fail";
    a.wire.quit();
    expect(state(a.dir)).toMatchObject({ mapped: a.target, offPending: true });
    await a.wire.dispose();
    a.fake.offResult = "ok";
    fs.writeFileSync(path.join(a.dir, "phone-access.json"), JSON.stringify({ ...state(a.dir), enabled: false }));
    const b = make({ dir: a.dir, fake: a.fake });
    await b.wire.resume();
    expect(b.fake.root).toBeNull();
    expect(state(a.dir)).toMatchObject({ mapped: null, offPending: false });
  });
});

describe("crash leftovers: every path that doesn't go live removes a mapping Synapse left", () => {
  async function crashed() {
    const a = make();
    await a.call("phone.enable");
    await a.wire.dispose(); // a crash: no quit(), the mapping stays in serve and in the store
    expect(a.fake.root).toBe(a.target);
    return a;
  }

  it.each([
    ["an old Tailscale", (f: FakeTailscale) => { f.version = "1.54.0"; }, "old"],
    ["Funnel turned on", (f: FakeTailscale) => { f.funnel = true; }, "funnel"],
    ["Tailscale stopped", (f: FakeTailscale) => { f.running = false; }, "stopped"],
  ])("launch after a crash with %s: not live, and our leftover mapping is removed", async (_n, set, code) => {
    const a = await crashed();
    set(a.fake);
    const b = make({ dir: a.dir, fake: a.fake });
    await b.wire.resume();
    expect(b.wire.isLive()).toBe(false);
    expect((await b.call<{ error: string }>("phone.status")).error).toBe(code);
    expect(a.fake.root).toBeNull();
    expect(state(a.dir).mapped).toBeNull();
  });

  it("serve status unreadable: the leftover can't be checked, so it is kept pending and retried until it can be", async () => {
    const a = await crashed();
    const run = a.fake.run;
    let broken = true;
    a.fake.run = async (c, args) => (broken && args.join(" ") === "serve status --json" ? { code: 1, stdout: "", stderr: "busy", timedOut: false } : run(c, args));
    const b = make({ dir: a.dir, fake: a.fake });
    await b.wire.resume();
    expect((await b.call<{ error: string }>("phone.status")).error).toBe("serve-status");
    expect(state(a.dir)).toMatchObject({ mapped: a.target, offPending: true });
    expect(a.fake.root).toBe(a.target);
    broken = false;
    await expect.poll(() => a.fake.root, { timeout: 2_000 }).toBeNull();
    expect(state(a.dir)).toMatchObject({ mapped: null, offPending: false });
  });

  it("a leftover that isn't exactly ours any more is never removed", async () => {
    const a = await crashed();
    a.fake.root = `unix:${a.sock}.other`;
    a.fake.version = "1.54.0";
    const b = make({ dir: a.dir, fake: a.fake });
    await b.wire.resume();
    expect(a.fake.root).toBe(`unix:${a.sock}.other`);
    expect(a.fake.cli.some((x) => x.join(" ") === "serve --https=443 off")).toBe(false);
    expect(state(a.dir).mapped).toBeNull();
  });
});

describe("our mapping sharing :443 with the user's own handlers (off would wipe theirs)", () => {
  it("at quit: nothing is turned off, and the mapping stays tracked (mapped + offPending)", async () => {
    const a = make();
    await a.call("phone.enable");
    a.fake.foreign = true;
    a.wire.quit();
    expect(a.fake.syncOffs).toBe(0);
    expect(a.fake.root).toBe(a.target);
    expect(state(a.dir)).toMatchObject({ mapped: a.target, offPending: true });
  });

  it("turning off: their handlers and ours stay, the mapping stays tracked, Settings says what to do — and no retry loop", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.foreign = true;
    const s = await t.call<{ enabled: boolean; error: string }>("phone.disable");
    expect(s).toMatchObject({ enabled: false, error: "shared-443" });
    expect(t.fake.root).toBe(t.target);
    expect(state(t.dir)).toMatchObject({ mapped: t.target, offPending: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(t.fake.cli.some((a) => a.join(" ") === "serve --https=443 off")).toBe(false);
    // The user removes their own handlers, then Retry: Synapse can clean up after itself again.
    t.fake.foreign = false;
    const again = make({ dir: t.dir, fake: t.fake });
    await again.wire.resume();
    expect(t.fake.root).toBeNull();
    expect(state(t.dir)).toMatchObject({ mapped: null, offPending: false });
  });
});

describe("an old removal retry never turns off a live mapping", () => {
  it("off fails → retry pending → Phone access turned on again → the retry doesn't touch the new live mapping", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.offResult = "fail";
    await t.call("phone.disable");
    expect(state(t.dir).offPending).toBe(true);
    t.fake.offResult = "ok";
    const s = await t.call<{ enabled: boolean }>("phone.enable");
    expect(s.enabled).toBe(true);
    const offs = () => t.fake.cli.filter((a) => a.join(" ") === "serve --https=443 off").length;
    const before = offs();
    await new Promise((r) => setTimeout(r, 120));
    expect(offs()).toBe(before);
    expect(t.fake.root).toBe(t.target);
    expect(t.wire.isLive()).toBe(true);
    expect(state(t.dir)).toMatchObject({ mapped: t.target, offPending: false });
  });
});

describe("an old removal retry never untracks a mapping that went live meanwhile", () => {
  it("the retry's off is slow; Phone access comes back on during it; the live mapping stays tracked", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.offResult = "fail";
    await t.call("phone.disable");
    t.fake.offResult = "ok";
    t.fake.offDelayMs = 150;
    const offs = () => t.fake.cli.filter((a) => a.join(" ") === "serve --https=443 off").length;
    const before = offs();
    // The retry chain (20 ms) has begun its off...
    await expect.poll(offs, { timeout: 2_000 }).toBeGreaterThan(before);
    // ...and Phone access is turned on again before that off answers.
    t.fake.offDelayMs = 0;
    const s = await t.call<{ enabled: boolean }>("phone.enable");
    expect(s.enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(t.wire.isLive()).toBe(true);
    expect(t.fake.root).toBe(t.target);
    expect(state(t.dir)).toMatchObject({ mapped: t.target, offPending: false });
  });
});

describe("turning off", () => {
  it("off failing keeps an error, persists it, and ONE retry chain keeps going until it's gone", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.offResult = "fail";
    const s = await t.call<{ enabled: boolean; error: string }>("phone.disable");
    expect(s).toMatchObject({ enabled: false, error: "off-failed" });
    expect(state(t.dir)).toMatchObject({ offPending: true });
    // A second disable while retrying doesn't start a second chain.
    await t.call("phone.disable");
    const offsBefore = t.fake.cli.filter((a) => a.join(" ") === "serve --https=443 off").length;
    await new Promise((r) => setTimeout(r, 70));
    const offsAfter = t.fake.cli.filter((a) => a.join(" ") === "serve --https=443 off").length;
    expect(offsAfter - offsBefore).toBeLessThanOrEqual(4); // ~20 ms apart, one at a time
    t.fake.offResult = "ok";
    await expect.poll(() => t.fake.root, { timeout: 2_000 }).toBeNull();
    expect((await t.call<{ error: string | null }>("phone.status")).error).toBeNull();
    expect(state(t.dir)).toMatchObject({ offPending: false, mapped: null });
  });

  it("the Tailscale CLI gone: retries stop after a few tries and say so (the next launch tries again)", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.offResult = "fail";
    await t.call("phone.disable");
    t.fake.missing = true;
    await expect.poll(async () => (await t.call<{ error: string }>("phone.status")).error, { timeout: 3_000 }).toBe("missing");
    expect(MAX_OFF_TRIES_WITHOUT_CLI).toBe(5);
    expect(state(t.dir).offPending).toBe(true);
  });
});

describe("the user's own Tailscale config", () => {
  it("refuses to turn on when :443 already serves something of the user's (and touches nothing)", async () => {
    const t = make();
    t.fake.foreign = true;
    expect(await t.call("phone.enable")).toMatchObject({ enabled: false, error: "port-in-use" });
    expect(t.fake.cli.some((a) => a[1] === "--bg" || a[2] === "off")).toBe(false);
  });

  it("refuses when the user's own root handler is on :443, and when Funnel is on", async () => {
    const a = make();
    a.fake.root = "http://127.0.0.1:3000";
    expect(await a.call("phone.enable")).toMatchObject({ enabled: false, error: "port-in-use" });
    expect(a.fake.root).toBe("http://127.0.0.1:3000");
    const b = make();
    b.fake.funnel = true;
    expect(await b.call("phone.enable")).toMatchObject({ enabled: false, error: "funnel" });
  });

  it("off only removes Synapse's own mapping", async () => {
    const t = make();
    await t.call("phone.enable");
    t.fake.root = "http://127.0.0.1:3000";
    await t.call("phone.disable");
    expect(t.fake.root).toBe("http://127.0.0.1:3000");
    expect(t.fake.cli.some((a) => a.join(" ") === "serve --https=443 off")).toBe(false);
  });

  it("refuses a Tailscale older than 1.56 (it may not strip client-sent Tailscale-User-* headers)", async () => {
    const t = make();
    t.fake.version = "1.54.0";
    expect(await t.call("phone.enable")).toMatchObject({ enabled: false, error: "old" });
    expect(t.fake.cli.some((a) => a[1] === "--bg")).toBe(false);
  });
});

describe("minors", () => {
  it("the VAPID private key is only ever on disk sealed; no sealer = no call alerts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-store-"));
    dirs.push(dir);
    const s = PhoneStore.in(dir, fakeSeal);
    const v = s.vapid();
    const onDisk = fs.readFileSync(path.join(dir, "phone-access.json"), "utf8");
    expect(onDisk).not.toContain(v.privateKey);
    expect(JSON.parse(onDisk).vapid.sealed).toBe(fakeSeal.encrypt(v.privateKey).toString("base64"));
    expect(PhoneStore.in(dir, fakeSeal).vapid()).toEqual(v);
    expect(() => PhoneStore.in(dir).vapid()).toThrow(/aren.t open yet/);
  });

  it("push subscriptions are the asking phone's own: no takeover, no removing another phone's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-store-"));
    dirs.push(dir);
    const s = PhoneStore.in(dir, fakeSeal);
    const sub = { endpoint: "https://web.push.apple.com/A", p256dh: "k", auth: "a", createdAt: 0 };
    expect(s.addSub({ ...sub, deviceId: "phone-1" })).toBe(true);
    expect(s.addSub({ ...sub, deviceId: "phone-2" })).toBe(false);
    s.removeSub(sub.endpoint, "phone-2");
    expect(s.read().subs.map((x) => x.deviceId)).toEqual(["phone-1"]);
    s.removeSub(sub.endpoint, "phone-1");
    expect(s.read().subs).toEqual([]);
  });

  it("a phone can't start calls faster than once every 2 s (each one starts a helper on the Mac)", async () => {
    const t = make();
    await t.call("phone.enable");
    void t.call("phone.bots", { bots: [{ id: "nova", name: "Nova", color: "#FFB800", shape: "pebble" }] });
    const { code } = await t.call<{ code: string }>("phone.pair.start");
    const sock = t.wire.server.socketPath!;
    const headers = { host: DNS, "tailscale-user-login": LOGIN, origin: `https://${DNS}` };
    const cookie = await new Promise<string>((resolve) => {
      const r = http.request({ socketPath: sock, path: "/api/pair", method: "POST", headers: { ...headers, "content-type": "application/json" } }, (res) => { res.resume(); resolve(String(res.headers["set-cookie"]?.[0]).split(";")[0]!); });
      r.end(JSON.stringify({ code }));
    });
    const ws = new WebSocket("ws://phone/ws", { headers: { ...headers, cookie }, createConnection: () => net.connect(sock) });
    const msgs: { type: string; reason?: string }[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "call", botId: "nova" }));
    ws.send(JSON.stringify({ type: "call", botId: "nova" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(msgs.filter((m) => m.type === "connecting")).toHaveLength(1);
    expect(msgs).toContainEqual({ type: "ended", reason: "busy" });
    expect(CALL_RATE).toEqual({ minGapMs: 2_000, perMinute: 10 });
    ws.close();
  });
});
