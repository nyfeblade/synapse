import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledHostBuild, redeployHostIfChanged } from "../../src/main/native/host-redeploy";

function rig(o: { bundled: string | null; running: string | null; busy?: string[][] }) {
  const events: string[] = [];
  const busy = [...(o.busy ?? [])];
  let running = o.running;
  const r = redeployHostIfChanged({
    bundledBuild: () => o.bundled,
    health: async () => ({ hostBuild: running }),
    prepare: async () => { const b = busy.shift() ?? []; events.push(b.length ? `busy:${b.join(",")}` : "ready"); return { ok: b.length === 0, busyBotIds: b }; },
    deploy: async () => { events.push("deploy"); running = o.bundled; },
    waitHealthy: async () => { events.push("healthy"); },
    sleep: async () => { events.push("wait"); },
    log: () => {},
  });
  return { r, events };
}

describe("host redeploy after an app update", () => {
  it("does nothing when the box already runs the host this app ships", async () => {
    const { r, events } = rig({ bundled: "aaaaaaaaaaaaaaaa", running: "aaaaaaaaaaaaaaaa" });
    expect(await r).toBe("current");
    expect(events).toEqual([]);
  });

  it("waits for every working Bot to finish (never forces), then deploys and waits for health", async () => {
    const { r, events } = rig({ bundled: "bbbbbbbbbbbbbbbb", running: "aaaaaaaaaaaaaaaa", busy: [["b1"], ["b1", "b2"]] });
    expect(await r).toBe("deployed");
    expect(events).toEqual(["busy:b1", "wait", "busy:b1,b2", "wait", "ready", "deploy", "healthy"]);
  });

  it("redeploys a host too old to report its build, and skips a development app with no bundled host", async () => {
    expect(await rig({ bundled: "bbbbbbbbbbbbbbbb", running: null }).r).toBe("deployed");
    expect(await rig({ bundled: null, running: "aaaaaaaaaaaaaaaa" }).r).toBe("skipped");
  });
});

// Release updates: an app update that ships a newer host build redeploys the Bots' computer's host.
describe("an app update with a newer bundled host build", () => {
  it("reads the new build id from the updated bundle's Resources and redeploys the box's older host", async () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "res-"));
    fs.mkdirSync(path.join(resources, "host", "dist"), { recursive: true });
    fs.writeFileSync(path.join(resources, "host", "dist", "build-id.txt"), "cccccccccccccccc\n");
    const events: string[] = [];
    let running = "aaaaaaaaaaaaaaaa";
    const r = await redeployHostIfChanged({
      bundledBuild: () => bundledHostBuild(resources),
      health: async () => ({ hostBuild: running }),
      prepare: async () => ({ ok: true, busyBotIds: [] }),
      deploy: async () => { events.push("deploy"); running = bundledHostBuild(resources)!; },
      waitHealthy: async () => { events.push("healthy"); },
      log: () => {},
    });
    expect(r).toBe("deployed");
    expect(events).toEqual(["deploy", "healthy"]);
    expect(running).toBe("cccccccccccccccc");
  });

  it("the packaged app runs it after the re-provision check, once connected (the health marker no longer waits for the box)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/main/index.ts"), "utf8");
    const after = src.slice(src.indexOf("const afterConnected = async"));
    const body = after.slice(0, after.indexOf("retryBoxUpdate = runReprovision;"));
    // Code audit 2026-09-29 §7.2: markHealthy runs at window + renderer load (launchHealth), not here.
    expect(body).not.toContain("markHealthy(");
    const i = [body.indexOf("reprovisionIfChanged("), body.indexOf("redeployHostIfChanged(")];
    expect(i.every((x) => x > 0)).toBe(true);
    expect(i[0]! < i[1]!).toBe(true);
    expect(body).toContain("bundledBuild: () => bundledHostBuild(process.resourcesPath)");
  });
});
