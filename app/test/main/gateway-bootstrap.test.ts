import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { helloMessage, STR, WRONG_HOST_MESSAGE } from "@synapse/shared";
import { hostBundlePath, resolveGateway } from "../../src/main/gateway-bootstrap";

/** A fake bundle layout: `<root>/<rel>` exists, nothing else does. */
function tree(...rels: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bots-hostbundle-"));
  for (const r of rels) {
    fs.mkdirSync(path.join(root, path.dirname(r)), { recursive: true });
    fs.writeFileSync(path.join(root, r), "// host");
  }
  return root;
}

describe("hostBundlePath", () => {
  it("uses the repo's host/dist in development", () => {
    const root = tree("host/dist/host.mjs");
    expect(hostBundlePath({ env: {}, appDir: path.join(root, "app") }))
      .toBe(path.join(root, "host", "dist", "host.mjs"));
  });

  // Packaged, appDir is …/Contents/Resources/app.asar, so `<appDir>/../host/dist/host.mjs` points at
  // …/Contents/Resources/host/dist/host.mjs — which the packager never shipped. FUZZ mode in the
  // packaged app therefore died with "The local host exited during start-up", which is why no smoke
  // test could run the shipped artefact at all.
  it("falls back to the bundle's Resources when the dev tree is not there (packaged)", () => {
    const res = tree("host/dist/host.mjs");
    const appDir = path.join(res, "app.asar");
    expect(hostBundlePath({ env: {}, appDir, runtime: { isPackaged: true, resourcesPath: res } }))
      .toBe(path.join(res, "host", "dist", "host.mjs"));
  });

  it("prefers an explicit SYNAPSE_HOST_BUNDLE over both", () => {
    expect(hostBundlePath({ env: { SYNAPSE_HOST_BUNDLE: "/somewhere/host.mjs" }, appDir: "/repo/app" })).toBe("/somewhere/host.mjs");
  });

  it("falls back to the dev path when neither candidate exists, so the error names a real path", () => {
    expect(hostBundlePath({ env: {}, appDir: "/repo/app" })).toBe(path.resolve("/repo", "host", "dist", "host.mjs"));
  });
});

describe("resolveGateway", () => {
  it("launches the host from inside the bundle when packaged (defect 2)", async () => {
    const res = tree("host/dist/host.mjs");
    const seen: { bundle?: string }[] = [];
    await resolveGateway({
      env: { FUZZ: "1" }, userData: "/tmp/ud", appDir: path.join(res, "app.asar"),
      runtime: { isPackaged: true, resourcesPath: res },
      launchLocal: async (o) => { seen.push(o); return { baseUrl: "http://127.0.0.1:1", token: "t", root: "/tmp/x", stop: async () => {} }; },
    });
    expect(seen[0]!.bundle).toBe(path.join(res, "host", "dist", "host.mjs"));
  });

  it("uses the disposable local fake host when FUZZ=1 and never touches the box", async () => {
    const seen: unknown[] = [];
    const h = await resolveGateway({
      env: { FUZZ: "1" }, userData: "/tmp/ud", appDir: "/repo/app",
      launchLocal: async (o) => { seen.push(o); return { baseUrl: "http://127.0.0.1:1", token: "t", root: "/tmp/x", stop: async () => {} }; },
      provider: { ensureRunning: async () => { throw new Error("box touched"); } } as never,
    });
    expect(h).toMatchObject({ mode: "local", baseUrl: "http://127.0.0.1:1", token: "t" });
    expect(seen[0]).toMatchObject({ disposable: true, bundle: "/repo/host/dist/host.mjs" });
  });

  it("FUZZ reconnect reuses the previous disposable store and a reconnect dispose keeps it (Task 50 fuzz)", async () => {
    const seen: unknown[] = [];
    const stops: unknown[] = [];
    const h = await resolveGateway({
      env: { FUZZ: "1" }, userData: "/tmp/ud", appDir: "/repo/app", reuseRoot: "/tmp/prev",
      launchLocal: async (o) => { seen.push(o); return { baseUrl: "http://127.0.0.1:1", token: "t", root: "/tmp/prev", stop: async (s) => { stops.push(s); } }; },
    });
    expect(seen[0]).toMatchObject({ disposable: true, root: "/tmp/prev" });
    expect(h.root).toBe("/tmp/prev");
    h.dispose({ keepData: true });
    h.dispose();
    expect(stops).toEqual([{ keepData: true }, undefined]);
  });

  it("starts the box, reads the token, stores it and connects otherwise", async () => {
    const order: string[] = [];
    const stored: string[] = [];
    const h = await resolveGateway({
      env: {}, userData: "/tmp/ud", appDir: "/repo/app", storeSecret: (n, v) => stored.push(`${n}=${v}`),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
      provider: {
        ensureRunning: async () => { order.push("ensure"); },
        readGatewayInfo: async () => { order.push("read"); return { port: 47800, token: "abc" }; },
        connect: async (port: number) => { order.push(`connect:${port}`); return { baseUrl: "http://127.0.0.1:47800", close: () => {} }; },
        stop: async () => { order.push("stop"); },
      },
    });
    expect(order).toEqual(["ensure", "read", "connect:47800"]);
    expect(stored).toEqual(["gatewayToken=abc"]);
    expect(h).toMatchObject({ mode: "box", token: "abc" });
    await h.stopBox?.();
    expect(order).toContain("stop");
  });

  // Two accounts on one Mac: OrbStack forwards each account's box to the shared 127.0.0.1, so a port can answer for
  // ANOTHER account's host. It refuses this box's token; the app must say so and never "connect".
  const boxDeps = (status: number | "refused", seen: string[] = []) => ({
    env: {}, userData: "/tmp/ud", appDir: "/repo/app",
    fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${String(u)} ${(init?.headers as Record<string, string>)?.authorization ?? ""}`);
      if (status === "refused") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } }), { status });
    }) as typeof fetch,
    provider: {
      ensureRunning: async () => {},
      readGatewayInfo: async () => ({ port: 47800, token: "mine" }),
      connect: async () => ({ baseUrl: "http://127.0.0.1:47800", close: () => {} }),
    },
  });

  it("checks the host with this box's own token before trusting the connection", async () => {
    const seen: string[] = [];
    const h = await resolveGateway(boxDeps(200, seen));
    expect(h.baseUrl).toBe("http://127.0.0.1:47800");
    expect(seen).toEqual(["http://127.0.0.1:47800/health Bearer mine"]);
  });

  it("a port answered by another account's host is refused with a plain message, never connected", async () => {
    await expect(resolveGateway(boxDeps(401))).rejects.toThrow(WRONG_HOST_MESSAGE);
    await expect(resolveGateway(boxDeps(401))).rejects.toMatchObject({ code: "WRONG_HOST" });
  });

  it("a host that isn't answering yet is left to the connection's own retry (not called another account)", async () => {
    const h = await resolveGateway(boxDeps("refused"));
    expect(h.mode).toBe("box");
  });

  // Review of 62fe30d9: the port comes from the box and is checked before anything is sent there; a host that
  // answers /hello is challenged before the token is sent; a refusal re-reads gateway.json once (a machine recreated
  // under a stale token) before it blames another account.
  const helloDeps = (o: { infos: Array<{ port: number; token: string; hello?: boolean }>; hostToken: string; uid?: number; sent?: string[] }) => {
    let i = 0;
    return {
      env: {}, userData: "/tmp/ud", appDir: "/repo/app", uid: o.uid ?? 501,
      fetchImpl: (async (u: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(u));
        o.sent?.push(`${url.pathname} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? "-"}`);
        if (url.pathname === "/hello") {
          const nonce = url.searchParams.get("nonce")!;
          return new Response(JSON.stringify({ ok: true, proof: createHmac("sha256", o.hostToken).update(helloMessage(nonce)).digest("hex") }), { status: 200 });
        }
        return new Response("{}", { status: 401 });
      }) as typeof fetch,
      provider: {
        ensureRunning: async () => {},
        readGatewayInfo: async () => o.infos[Math.min(i++, o.infos.length - 1)]!,
        connect: async (port: number) => ({ baseUrl: `http://127.0.0.1:${port}`, close: () => {} }),
      },
    };
  };

  it("a host that answers /hello is challenged first: the token is never sent to verify it", async () => {
    const sent: string[] = [];
    const h = await resolveGateway(helloDeps({ infos: [{ port: 47800, token: "mine", hello: true }], hostToken: "mine", sent }));
    expect(h.token).toBe("mine");
    expect(h.hello).toBe(true);
    expect(sent).toEqual(["/hello -"]);
  });

  it("another host answering this account's port with a wrong proof: another account, and no token sent", async () => {
    const sent: string[] = [];
    await expect(resolveGateway(helloDeps({ infos: [{ port: 47800, token: "mine", hello: true }], hostToken: "theirs", sent }))).rejects.toThrow(WRONG_HOST_MESSAGE);
    expect(sent.every((l) => l.endsWith(" -"))).toBe(true);
  });

  it("a refused first check re-reads gateway.json once and goes on with the fresh token (a recreated machine)", async () => {
    const h = await resolveGateway(helloDeps({ infos: [{ port: 47800, token: "old", hello: true }, { port: 47800, token: "new", hello: true }], hostToken: "new" }));
    expect(h.token).toBe("new");
  });

  it("a port that isn't this user's (or 47800 while an older install moves) is refused before anything is sent", async () => {
    const sent: string[] = [];
    await expect(resolveGateway(helloDeps({ infos: [{ port: 22, token: "mine", hello: true }], hostToken: "mine", sent }))).rejects.toThrow(STR.hostOddPort(22));
    await expect(resolveGateway(helloDeps({ infos: [{ port: 47900.5, token: "mine", hello: true }], hostToken: "mine", uid: 502 }))).rejects.toThrow();
    expect(sent).toEqual([]);
    expect((await resolveGateway(helloDeps({ infos: [{ port: 47900, token: "mine", hello: true }], hostToken: "mine", uid: 502 }))).baseUrl).toBe("http://127.0.0.1:47900");
    expect((await resolveGateway(helloDeps({ infos: [{ port: 47800, token: "mine", hello: true }], hostToken: "mine", uid: 502 }))).baseUrl).toBe("http://127.0.0.1:47800");
    await expect(resolveGateway(helloDeps({ infos: [{ port: 47900, token: "mine", hello: true }], hostToken: "mine", uid: 501 }))).rejects.toThrow(STR.hostOddPort(47900));
  });

  // Final review: a box without /hello under a uid other than 501 is an older host still on 47800, which may be uid
  // 501's host. The token must not go there: the host is redeployed through orb first (no token needed), which moves
  // it to this user's port with /hello, and only then is it connected, with proof.
  it("an older host under another uid is redeployed through orb before any token-bearing request", async () => {
    const order: string[] = [];
    const sent: string[] = [];
    const d = helloDeps({ infos: [{ port: 47800, token: "mine" }, { port: 47900, token: "mine", hello: true }], hostToken: "mine", uid: 502, sent });
    const f = d.fetchImpl;
    const h = await resolveGateway({ ...d, fetchImpl: (async (u: RequestInfo | URL, i?: RequestInit) => { order.push("fetch"); return f(u, i); }) as typeof fetch, redeployOldHost: async () => { order.push("redeploy"); } });
    expect(order[0]).toBe("redeploy");
    expect(h.baseUrl).toBe("http://127.0.0.1:47900");
    expect(sent).toEqual(["/hello -"]);
  });

  it("with no way to redeploy it, an older host under another uid is refused and gets nothing", async () => {
    const sent: string[] = [];
    await expect(resolveGateway(helloDeps({ infos: [{ port: 47800, token: "mine" }], hostToken: "mine", uid: 502, sent }))).rejects.toThrow(STR.hostNeedsUpdate);
    expect(sent).toEqual([]);
  });

  // Re-review: before connecting, Settings → Updates can't be reached; the connection screen's Retry can.
  it("a failed pre-connect redeploy points to Retry, not to a screen that needs a connection", async () => {
    const d = helloDeps({ infos: [{ port: 47800, token: "mine" }], hostToken: "mine", uid: 502 });
    const err = await resolveGateway({ ...d, redeployOldHost: async () => { throw new Error("deploy.sh exit 1"); } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Retry/);
    expect((err as Error).message).not.toMatch(/Settings/);
    expect(STR.hostNeedsUpdate).not.toMatch(/Settings/);
    // The same for a port the box shouldn't report: the connection screen offers Retry and Recover.
    expect(STR.hostOddPort(22)).not.toMatch(/Settings/);
  });

  it("uid 501's own older host keeps the old check until its next deploy", async () => {
    let redeployed = false;
    const d = helloDeps({ infos: [{ port: 47800, token: "mine" }], hostToken: "mine", uid: 501 });
    const h = await resolveGateway({ ...d, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch, redeployOldHost: async () => { redeployed = true; } });
    expect(h.baseUrl).toBe("http://127.0.0.1:47800");
    expect(redeployed).toBe(false);
  });

  it("does not expose a box stopper on the local/FUZZ host", async () => {
    const h = await resolveGateway({
      env: { FUZZ: "1" }, userData: "/tmp/ud", appDir: "/repo/app",
      launchLocal: async () => ({ baseUrl: "http://127.0.0.1:1", token: "t", root: "/tmp/x", stop: async () => {} }),
    });
    expect(h.stopBox).toBeUndefined();
  });
});
