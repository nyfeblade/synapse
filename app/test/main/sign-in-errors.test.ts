import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { helloMessage, STR, WRONG_HOST_MESSAGE } from "@synapse/shared";
import { registerAuthIpc } from "../../src/main/auth-key";
import { gatewayCall } from "../../src/main/gateway-call";
import { notConnectedMessage } from "../../src/coordinator/gateway-client";

// A rejected sign-in must never do nothing: every way the main process's gateway calls and auth IPC can fail ends
// in a plain sentence the Account panel can show. No network: every fetch here is a fake.
const reply = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("main's gateway calls fail in plain words", () => {
  it("another account's host (401) is named as that", async () => {
    const call = gatewayCall("http://h", "t", { fetchImpl: reply(401, JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } })) });
    await expect(call("getAuth", {})).rejects.toThrow(WRONG_HOST_MESSAGE);
  });
  it("no answer at all", async () => {
    const call = gatewayCall("http://h", "t", { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(call("getAuth", {})).rejects.toThrow(STR.hostNoAnswer);
  });
  it("an answer that isn't the gateway's JSON", async () => {
    const call = gatewayCall("http://h", "t", { fetchImpl: reply(502, "<html>Bad gateway</html>") });
    await expect(call("getAuth", {})).rejects.toThrow(STR.hostBadAnswer(502));
  });
  it("an answer that never comes", async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))))) as typeof fetch;
    await expect(gatewayCall("http://h", "t", { fetchImpl: hang, timeoutMs: 30 })("getAuth", {})).rejects.toThrow(STR.hostTimeout);
  });
  it("the host's own refusal keeps its message", async () => {
    const call = gatewayCall("http://h", "t", { fetchImpl: reply(400, JSON.stringify({ ok: false, error: { code: "INVALID", message: "That doesn't look like an Anthropic API key" } })) });
    await expect(call("setApiKey", { sealed: "x" })).rejects.toThrow("That doesn't look like an Anthropic API key");
  });
});

describe("main's gateway calls: proof of host, a stale token, and no blanket time limit", () => {
  const helloHost = (token: string, sent: string[], onApi: (auth: string) => Response) => (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "-";
    sent.push(`${url.pathname} ${auth}`);
    if (url.pathname === "/hello") return new Response(JSON.stringify({ ok: true, proof: createHmac("sha256", token).update(helloMessage(url.searchParams.get("nonce")!)).digest("hex") }), { status: 200 });
    return onApi(auth);
  }) as typeof fetch;
  const ok = () => new Response(JSON.stringify({ ok: true, result: "r" }), { status: 200 });

  it("with a host that answers /hello, each call proves the host before the token is sent", async () => {
    const sent: string[] = [];
    const call = gatewayCall("http://h", "mine", { hello: true, fetchImpl: helloHost("mine", sent, ok) });
    expect(await call("getAuth", {})).toBe("r");
    expect(sent).toEqual(["/hello -", "/api/getAuth Bearer mine"]);
  });

  it("an impostor on the port never gets the token", async () => {
    const sent: string[] = [];
    const call = gatewayCall("http://h", "mine", { hello: true, fetchImpl: helloHost("theirs", sent, ok) });
    await expect(call("getAuth", {})).rejects.toThrow(WRONG_HOST_MESSAGE);
    expect(sent).toEqual(["/hello -"]);
  });

  it("a 401 first asks for a fresh token (a recreated machine) and retries with it before blaming another account", async () => {
    const sent: string[] = [];
    const call = gatewayCall("http://h", "old", {
      fetchImpl: helloHost("new", sent, (auth) => (auth === "Bearer new" ? ok() : new Response("{}", { status: 401 }))),
      onStale: async () => ({ baseUrl: "http://h", token: "new" }),
    });
    expect(await call("getAuth", {})).toBe("r");
    const same = gatewayCall("http://h", "old", { fetchImpl: helloHost("x", [], () => new Response("{}", { status: 401 })), onStale: async () => null });
    await expect(same("getAuth", {})).rejects.toThrow(WRONG_HOST_MESSAGE);
  });

  it("no time limit unless the caller asks for one (a restore or an import may take long)", async () => {
    let signal: AbortSignal | undefined | null = null;
    const call = gatewayCall("http://h", "t", { fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return ok(); }) as typeof fetch });
    await call("restoreSnapshot" as never, {} as never);
    expect(signal).toBeUndefined();
  });
});

describe("the auth IPC answers before the app has connected", () => {
  const fakeIpc = () => {
    const h = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    return { h, ipc: { removeHandler: (c: string) => { h.delete(c); }, handle: (c: string, f: (e: unknown, ...a: unknown[]) => unknown) => { h.set(c, f); } } };
  };
  it("Save before a connection says so plainly (not \"No handler registered\")", async () => {
    const { h, ipc } = fakeIpc();
    registerAuthIpc(ipc, () => null, () => null);
    for (const c of ["auth:save-key", "auth:test-key", "auth:remove-key"]) expect(h.has(c), c).toBe(true);
    await expect(Promise.resolve().then(() => h.get("auth:save-key")!({}, "k"))).rejects.toThrow(STR.hostNotConnected);
    expect(await h.get("auth:has-mac-key")!({})).toBe(false);
  });
  it("the reason the connection failed wins (another account's host)", async () => {
    const { h, ipc } = fakeIpc();
    registerAuthIpc(ipc, () => null, () => WRONG_HOST_MESSAGE);
    await expect(Promise.resolve().then(() => h.get("auth:test-key")!({}, "k"))).rejects.toThrow(WRONG_HOST_MESSAGE);
  });
  it("once connected it hands the call to the sender", async () => {
    const { h, ipc } = fakeIpc();
    const sender = { save: async (v: string) => ({ saved: v }), test: async () => "t", remove: async () => "r", hasMacCopy: async () => true };
    registerAuthIpc(ipc, () => sender as never, () => null);
    expect(await h.get("auth:save-key")!({}, "k")).toEqual({ saved: "k" });
    expect(await h.get("auth:has-mac-key")!({})).toBe(true);
  });
});

describe("the coordinator's answer to a call made while not connected", () => {
  it("carries why the connection failed, or says it isn't connected yet", () => {
    expect(notConnectedMessage({ kind: "unreachable", error: WRONG_HOST_MESSAGE })).toBe(WRONG_HOST_MESSAGE);
    expect(notConnectedMessage({ kind: "starting" })).toBe(STR.hostNotConnected);
  });
});
