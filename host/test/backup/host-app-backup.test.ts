import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("host app: backup routes, restore at boot, run state in /health", () => {
  it("snapshots, restores on the next start, and says so in /health", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const auth = { authorization: `Bearer ${app.token}` };
    const base = `http://127.0.0.1:${port}`;
    const created = await (await fetch(`${base}/api/createAgent`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Nova" }) })).json() as { result: { id: string } };
    const first = await (await fetch(`${base}/health`, { headers: auth })).json();
    expect(first).toMatchObject({ previousRun: null, lastRestore: null });
    expect(await (await fetch(`${base}/backup/snapshot`)).status).toBe(401); // the gateway's bearer check covers raw routes
    const snap = Buffer.from(await (await fetch(`${base}/backup/snapshot`, { headers: auth })).arrayBuffer());
    // The Bot is deleted after the backup.
    await fetch(`${base}/api/deleteAgent`, { method: "POST", headers: auth, body: JSON.stringify({ id: created.result.id }) });
    const sha = createHash("sha256").update(snap).digest("hex");
    expect((await fetch(`${base}/backup/restore`, { method: "PUT", headers: { ...auth, "x-backup-sha256": sha }, body: snap })).status).toBe(200);
    await app.close();
    app = await createHostApp(cfg);
    const p2 = (await app.listen()).port;
    const h = await (await fetch(`http://127.0.0.1:${p2}/health`, { headers: { authorization: `Bearer ${app.token}` } })).json();
    expect(h).toMatchObject({ previousRun: { clean: true }, lastRestore: { ok: true, bots: 1 } });
    const list = await (await fetch(`http://127.0.0.1:${p2}/api/listAgents`, { method: "POST", headers: { authorization: `Bearer ${app.token}` }, body: "{}" })).json() as { result: { agents: { id: string }[] } };
    expect(list.result.agents.map((a) => a.id)).toContain(created.result.id);
    expect(fs.existsSync(path.join(cfg.hostPrivate, "restore-pending.json"))).toBe(false);
  });

  it("reports an unclean previous run (a crash) in /health", async () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    fs.writeFileSync(path.join(cfg.hostPrivate, "host-run.json"), JSON.stringify({ bootId: "b-old", startedAt: 5, clean: false }));
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const h = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${app.token}` } })).json();
    expect(h).toMatchObject({ previousRun: { bootId: "b-old", startedAt: 5, clean: false } });
  });
});
