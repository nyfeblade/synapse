import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { createHostApp, crashBackoffTray, reviewerDegradedTray, startBootConformance, type HostApp } from "../app";
import { tmpConfig } from "./helpers";
import { log } from "../util/log";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("createHostApp", () => {
  it("listens, writes gateway.json 0600, and answers getHealth and host settings", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const info = JSON.parse(fs.readFileSync(path.join(cfg.hostPrivate, "gateway.json"), "utf8"));
    expect(info).toMatchObject({ port, scheme: "http", host: "127.0.0.1", token: app.token });
    expect(fs.statSync(path.join(cfg.hostPrivate, "gateway.json")).mode & 0o777).toBe(0o600);
    const h = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${app.token}` } });
    expect(await h.json()).toMatchObject({ ok: true, brain: "fake", tokenConfigured: false });
    const r = await fetch(`http://127.0.0.1:${port}/api/setHostSettings`, {
      method: "POST", headers: { authorization: `Bearer ${app.token}` }, body: JSON.stringify({ autoReviewEnabled: false }),
    });
    expect(((await r.json()) as { result: { autoReviewEnabled: boolean } }).result.autoReviewEnabled).toBe(false);
  });

  it("bug-log 128: /health reports the free space on the box's disk (the workspace volume)", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const h = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${app.token}` } })).json()) as { diskFreeBytes?: number | null };
    const s = fs.statfsSync(cfg.workspace);
    expect(typeof h.diskFreeBytes).toBe("number");
    expect(Math.abs(h.diskFreeBytes! - s.bavail * s.bsize)).toBeLessThan(1024 ** 3);
  });

  it("keeps the same token across restarts", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    await app.listen();
    const first = app.token;
    await app.close();
    app = await createHostApp(cfg);
    await app.listen();
    expect(app.token).toBe(first);
  });
});

// Task 33 fix round: onCrashBackoff/onDegraded must build trays from the shared string
// table (STR), never a literal that duplicates it or names the underlying CLI (preflight F1).
describe("tray copy builders used by the Supervisor/Reviewer wiring", () => {
  it("crashBackoffTray uses STR.trayBotFailed and never names the underlying CLI", () => {
    const t = crashBackoffTray("bot-1");
    expect(t.title).toBe(STR.trayBotFailed);
    expect(t.dedupeKey).toBe("bot-1:crash");
    expect(t.detail).not.toMatch(/claude code/i);
  });

  it("reviewerDegradedTray uses STR.trayReviewerDown", () => {
    const t = reviewerDegradedTray("timeout");
    expect(t.title).toBe(STR.trayReviewerDown);
    expect(t.botId).toBeNull();
    expect(t.detail).toBe("timeout");
    expect(t.dedupeKey).toBe("reviewer");
  });
});

// H-2: the boot reap (bot-reap SIGKILLs box claude processes) must finish before boot conformance
// starts, or it kills the `--version` probe and CT-01's process.
describe("startBootConformance (H-2)", () => {
  it("starts conformance only after the boot reap has finished", async () => {
    const order: string[] = [];
    let finishReap!: () => void;
    const { swept, ready } = startBootConformance({
      reap: () => new Promise<void>((r) => { order.push("reap:start"); finishReap = () => { order.push("reap:end"); r(); }; }),
      ensure: async () => { order.push("conformance"); },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["reap:start"]);
    finishReap();
    await swept;
    await ready;
    expect(order).toEqual(["reap:start", "reap:end", "conformance"]);
  });

  it("a failed reap still lets conformance run, and a failed conformance never rejects ready", async () => {
    const spy = vi.spyOn(log, "error").mockImplementation(() => {});
    const { swept, ready } = startBootConformance({ reap: async () => { throw new Error("sudo"); }, ensure: async () => { throw new Error("x"); } });
    await expect(swept).rejects.toThrow("sudo");
    await expect(ready).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
