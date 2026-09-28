import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("does not expose a box stopper on the local/FUZZ host", async () => {
    const h = await resolveGateway({
      env: { FUZZ: "1" }, userData: "/tmp/ud", appDir: "/repo/app",
      launchLocal: async () => ({ baseUrl: "http://127.0.0.1:1", token: "t", root: "/tmp/x", stop: async () => {} }),
    });
    expect(h.stopBox).toBeUndefined();
  });
});
