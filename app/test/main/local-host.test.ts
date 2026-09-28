import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { launchLocalHost } from "../../src/main/local-host";

const bundle = path.resolve(__dirname, "../../../host/dist/host.mjs");

describe("FUZZ local host", () => {
  beforeAll(() => { execFileSync(process.execPath, ["build.mjs"], { cwd: path.resolve(__dirname, "../../../host"), stdio: "inherit" }); }, 60_000);

  it("starts a fake-brain host in a disposable store and removes it on stop", async () => {
    const h = await launchLocalHost({ bundle, dataDir: "/unused", disposable: true, nodePath: process.execPath });
    const health = await (await fetch(`${h.baseUrl}/health`, { headers: { authorization: `Bearer ${h.token}` } })).json();
    expect(health).toMatchObject({ ok: true, brain: "fake" });
    expect(fs.existsSync(h.root)).toBe(true);
    await h.stop();
    expect(fs.existsSync(h.root)).toBe(false);
  }, 30_000);

  it("a restart after the host died reuses the same disposable store, so its data survives until the final stop (Task 50 fuzz)", async () => {
    const first = await launchLocalHost({ bundle, dataDir: "/unused", disposable: true, nodePath: process.execPath });
    fs.writeFileSync(path.join(first.root, "workspace", "marker.txt"), "kept");
    await first.stop({ keepData: true });
    expect(fs.existsSync(first.root)).toBe(true);
    const second = await launchLocalHost({ bundle, dataDir: "/unused", disposable: true, nodePath: process.execPath, root: first.root });
    expect(second.root).toBe(first.root);
    expect(fs.readFileSync(path.join(second.root, "workspace", "marker.txt"), "utf8")).toBe("kept");
    await second.stop();
    expect(fs.existsSync(first.root)).toBe(false);
  }, 30_000);
});

describe("FUZZ local host vs a busy webhook port", () => {
  it("a disposable host still starts when another process holds the webhook port 47801", async () => {
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.once("error", () => r()).listen(47801, "127.0.0.1", () => r()));
    try {
      const h = await launchLocalHost({ bundle, dataDir: "/unused", disposable: true, nodePath: process.execPath });
      const health = await (await fetch(`${h.baseUrl}/health`, { headers: { authorization: `Bearer ${h.token}` } })).json();
      expect(health).toMatchObject({ ok: true });
      await h.stop();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, 30_000);
});
