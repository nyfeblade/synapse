import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { helloMessage, STR, WRONG_HOST_MESSAGE } from "@synapse/shared";
import { createHostFetch, streamProves } from "../../src/main/host-fetch";
import { gatewayCall } from "../../src/main/gateway-call";

// Main's own token-bearing requests (health polls, backup snapshot/restore, snapshot upload/download, file saves)
// prove the host with /hello like every gateway call, reusing the coordinator's proof while its stream is up, so
// there's no extra round trip then. No network: every fetch is a fake.
const host = (token: string, sent: string[]) => (async (u: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(u));
  sent.push(`${url.pathname} ${new Headers(init?.headers).get("authorization") ?? "-"}`);
  if (url.pathname === "/hello") return new Response(JSON.stringify({ ok: true, proof: createHmac("sha256", token).update(helloMessage(url.searchParams.get("nonce")!)).digest("hex") }));
  return new Response("{}", { status: 200 });
}) as typeof fetch;

describe("createHostFetch", () => {
  it("stream down: proves the host, then sends the token", async () => {
    const sent: string[] = [];
    const f = createHostFetch({ creds: () => ({ baseUrl: "http://h", token: "mine", hello: true }), streamUp: () => false, fetchImpl: host("mine", sent) });
    expect((await f("/health")).status).toBe(200);
    expect(sent).toEqual(["/hello -", "/health Bearer mine"]);
  });

  it("stream up on a proven host: no extra round trip", async () => {
    const sent: string[] = [];
    const f = createHostFetch({ creds: () => ({ baseUrl: "http://h", token: "mine", hello: true }), streamUp: () => true, fetchImpl: host("mine", sent) });
    await f("/backup/snapshot");
    expect(sent).toEqual(["/backup/snapshot Bearer mine"]);
  });

  it("an impostor on the port never gets the token", async () => {
    const sent: string[] = [];
    const f = createHostFetch({ creds: () => ({ baseUrl: "http://h", token: "mine", hello: true }), streamUp: () => false, fetchImpl: host("theirs", sent) });
    await expect(f("/backup/restore", { method: "PUT" })).rejects.toThrow(WRONG_HOST_MESSAGE);
    expect(sent).toEqual(["/hello -"]);
  });

  it("an old host (no /hello) keeps the direct request; no connection is a plain error", async () => {
    const sent: string[] = [];
    const f = createHostFetch({ creds: () => ({ baseUrl: "http://h", token: "mine", hello: false }), streamUp: () => false, fetchImpl: host("mine", sent) });
    await f("/health", { headers: { accept: "application/json" } });
    expect(sent).toEqual(["/health Bearer mine"]);
    const none = createHostFetch({ creds: () => null, streamUp: () => false });
    await expect(none("/health")).rejects.toThrow(STR.hostNotConnected);
  });
});

describe("main's gateway calls reuse the stream's proof", () => {
  it("no /hello round trip while the coordinator's stream is up", async () => {
    const sent: string[] = [];
    const ok = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(u)).pathname;
      sent.push(p);
      return p === "/hello" ? host("mine", [])(u, init) : new Response(JSON.stringify({ ok: true, result: 1 }));
    }) as typeof fetch;
    let up = true;
    const call = gatewayCall("http://h", "mine", { hello: true, proven: (c) => streamProves(up, { baseUrl: "http://h", token: "mine", hello: true }, c), fetchImpl: ok });
    await call("getAuth", {});
    expect(sent).toEqual(["/api/getAuth"]);
    up = false;
    sent.length = 0;
    await call("getAuth", {});
    expect(sent).toEqual(["/hello", "/api/getAuth"]);
  });
});

// Final review: the stream's proof may only be reused for the host the stream is on (same address, same token).
describe("the stream's proof covers only its own host", () => {
  const cur = { baseUrl: "http://127.0.0.1:47900", token: "mine", hello: true };
  it("same address and token while the stream is up: reused", () => {
    expect(streamProves(true, cur, { ...cur })).toBe(true);
    expect(streamProves(false, cur, { ...cur })).toBe(false);
    expect(streamProves(true, cur, { ...cur, baseUrl: "http://127.0.0.1:47800" })).toBe(false);
    expect(streamProves(true, cur, { ...cur, token: "old" })).toBe(false);
    expect(streamProves(true, null, cur)).toBe(false);
  });
  it("a gateway call to another address than the stream's is proven itself", async () => {
    const sent: string[] = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(u)).pathname;
      sent.push(`${new URL(String(u)).host}${p}`);
      return p === "/hello" ? host("mine", [])(u, init) : new Response(JSON.stringify({ ok: true, result: 1 }));
    }) as typeof fetch;
    const call = gatewayCall("http://127.0.0.1:47800", "mine", { hello: true, proven: (c) => streamProves(true, cur, c), fetchImpl: f });
    await call("getAuth", {});
    expect(sent).toEqual(["127.0.0.1:47800/hello", "127.0.0.1:47800/api/getAuth"]);
  });
});

describe("no token-bearing request in the main process or the coordinator skips the proof", () => {
  it("only the proven paths build an Authorization header for the host", () => {
    const main = path.resolve(__dirname, "../../src/main");
    const files = (fs.readdirSync(main, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const allowed = new Set(["gateway-call.ts", "host-hello.ts", "host-fetch.ts", path.join("native", "updater.ts"), path.join("crash", "redact.ts")]);
    const hits = files.filter((f) => !allowed.has(f) && /Bearer \$\{/.test(fs.readFileSync(path.join(main, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the coordinator's token-bearing requests are only its gateway client and the VNC proxy, both proven first", () => {
    const coord = path.resolve(__dirname, "../../src/coordinator");
    const files = (fs.readdirSync(coord, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const hits = files.filter((f) => /Bearer \$\{/.test(fs.readFileSync(path.join(coord, f), "utf8"))).sort();
    expect(hits).toEqual(["gateway-client.ts", "vnc-proxy.ts"]);
    expect(fs.readFileSync(path.join(coord, "vnc-proxy.ts"), "utf8")).toMatch(/await this\.o\.prove\(\)[\s\S]*Bearer \$\{/);
  });
});
