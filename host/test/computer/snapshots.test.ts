import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SnapshotService, type SnapshotControl } from "../../computer/snapshots";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  const calls: string[] = [];
  const control: SnapshotControl = {
    create: async (id, parts) => { calls.push(`create ${id} ${parts.join(",")}`); const b = Buffer.alloc(9 * 1024 * 1024, 7); fs.writeFileSync(path.join(dir, `${id}.tar.zst`), b); return createHash("sha256").update(b).digest("hex"); },
    restore: async (id, parts) => { calls.push(`restore ${id} ${parts.join(",")}`); },
    remove: async (id) => { calls.push(`remove ${id}`); fs.rmSync(path.join(dir, `${id}.tar.zst`), { force: true }); },
  };
  let t = 1000;
  const events: string[] = [];
  const svc = new SnapshotService({ dir, control, now: () => ++t, beforeRestore: async () => { events.push("quiesce"); }, afterRestore: () => events.push("restart") });
  return { dir, calls, svc, events };
}

describe("SnapshotService (CMP-12)", () => {
  it("creates one snapshot at a time, indexes it, and keeps only the newest on the box", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.svc.create("manual"), s.svc.create("manual")]);
    expect(a.id).toBe(b.id); // single flight
    expect(a).toMatchObject({ reason: "manual", parts: ["workspace", "home", "agent-data"], bytes: 9 * 1024 * 1024 });
    const c = await s.svc.create("before_update");
    expect(s.svc.list().map((x) => x.id)).toEqual([c.id]);
    expect(s.calls).toContain(`remove ${a.id}`);
    expect(s.svc.status()).toEqual({ latest: c, running: false });
  });

  it("serves 4 MiB chunks and accepts an upload that must match its sha256", async () => {
    const s = setup();
    const info = await s.svc.create("manual");
    const server = http.createServer(async (req, res) => { if (!(await s.svc.raw(req, res, new URL(req.url!, "http://x")))) { res.statusCode = 404; res.end(); } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const parts: Buffer[] = [];
    for (let off = 0; off < info.bytes; off += 4 * 1024 * 1024) parts.push(Buffer.from(await (await fetch(`${base}/snapshots/${info.id}?offset=${off}&length=${4 * 1024 * 1024}`)).arrayBuffer()));
    expect(parts.map((p) => p.length)).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024]);
    const whole = Buffer.concat(parts);
    const id = "snap-upload01";
    const sha = createHash("sha256").update(whole).digest("hex");
    for (let off = 0; off < whole.length; off += 4 * 1024 * 1024) {
      const r = await fetch(`${base}/snapshots/${id}?offset=${off}&total=${whole.length}&sha256=${sha}`, { method: "PUT", body: whole.subarray(off, off + 4 * 1024 * 1024) });
      expect(r.status).toBe(200);
    }
    expect(s.svc.list().some((x) => x.id === id)).toBe(true);
    const bad = await fetch(`${base}/snapshots/snap-upload02?offset=0&total=3&sha256=${"0".repeat(64)}`, { method: "PUT", body: Buffer.from("abc") });
    expect(bad.status).toBe(422);
    server.close();
  });

  it("restore quiesces, restores through the helper, then restarts the host", async () => {
    const s = setup();
    const info = await s.svc.create("manual");
    await s.svc.restore(info.id, ["workspace", "home"]);
    expect(s.events).toEqual(["quiesce", "restart"]);
    expect(s.calls.at(-1)).toBe(`restore ${info.id} workspace,home`);
  });

  describe("raw() error handling (T21 fix round 1)", () => {
    async function server(s: ReturnType<typeof setup>) {
      const srv = http.createServer(async (req, res) => { if (!(await s.svc.raw(req, res, new URL(req.url!, "http://x")))) { res.statusCode = 404; res.end(); } });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
    }

    it("GET for an id matching the regex but missing on disk responds 404, not a thrown ENOENT", async () => {
      const s = setup();
      const { srv, base } = await server(s);
      const r = await fetch(`${base}/snapshots/snap-gone000?offset=0&length=4096`);
      expect(r.status).toBe(404);
      srv.close();
    });

    it("GET with a non-numeric length responds 400 instead of throwing on Buffer.alloc(NaN)", async () => {
      const s = setup();
      const info = await s.svc.create("manual");
      const { srv, base } = await server(s);
      const r = await fetch(`${base}/snapshots/${info.id}?offset=0&length=not-a-number`);
      expect(r.status).toBe(400);
      srv.close();
    });

    it("GET with a non-numeric offset responds 400 instead of throwing", async () => {
      const s = setup();
      const info = await s.svc.create("manual");
      const { srv, base } = await server(s);
      const r = await fetch(`${base}/snapshots/${info.id}?offset=not-a-number&length=4096`);
      expect(r.status).toBe(400);
      srv.close();
    });

    it("PUT with a non-numeric total responds 400 instead of leaving the upload wedged", async () => {
      const s = setup();
      const { srv, base } = await server(s);
      const r = await fetch(`${base}/snapshots/snap-badtotal1?offset=0&total=not-a-number&sha256=${"0".repeat(64)}`, { method: "PUT", body: Buffer.from("abc") });
      expect(r.status).toBe(400);
      srv.close();
    });
  });
});
