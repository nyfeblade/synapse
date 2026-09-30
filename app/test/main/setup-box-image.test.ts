import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Exec } from "../../src/main/box-provider";
import { diskNeeded, downloadResumable, imageUrl, readImageManifest, type ImageManifest } from "../../src/main/setup/box-image";
import { boxSteps, type BoxStepDeps } from "../../src/main/setup/box-steps";
import { BoxProvisioner, type ProvisionState } from "../../src/main/setup/provisioner";

const ORB = "/Applications/OrbStack.app/Contents/MacOS/bin/orb";
const IMAGE = "0123456789abcdef";
const HOST = "fedcba9876543210";
const BODY = crypto.randomBytes(300_000);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");

/** A local image server: Range support, and (per path) a connection that drops halfway, or a server that ignores ranges. */
let server: http.Server;
let base = "";
const hits: Array<{ path: string; range: string | null }> = [];
let dropOnce = new Set<string>();
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = req.headers.range ?? null;
    hits.push({ path: req.url!, range });
    if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
    const m = /^bytes=(\d+)-$/.exec(range ?? "");
    const start = m && req.url !== "/norange" ? Number(m[1]) : 0;
    const part = BODY.subarray(start);
    res.writeHead(m && req.url !== "/norange" ? 206 : 200, { "content-length": String(part.length) });
    if (dropOnce.has(req.url!)) {
      dropOnce.delete(req.url!);
      res.write(part.subarray(0, 100_000), () => res.destroy());
      return;
    }
    res.end(part);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "box-image-"));

function manifest(o: Partial<ImageManifest> = {}): ImageManifest {
  return { format: 1, imageVersion: IMAGE, hostBuild: HOST, arch: "arm64", url: "https://example.invalid/box.tar.zst", sha256: SHA, bytes: BODY.length, unpackedBytes: 1_000_000, ...o };
}

describe("the manifest pinned in the app", () => {
  it("reads a well-formed box/image.json and refuses anything else", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "image.json"), JSON.stringify(manifest()));
    expect(readImageManifest(dir)).toMatchObject({ imageVersion: IMAGE, sha256: SHA });
    for (const bad of [{ url: "http://example.com/x" }, { sha256: "abc" }, { imageVersion: "zz" }, { arch: "amd64" }, { bytes: 0 }, { format: 2 }]) {
      fs.writeFileSync(path.join(dir, "image.json"), JSON.stringify({ ...manifest(), ...bad }));
      expect(readImageManifest(dir)).toBeNull();
    }
    fs.rmSync(path.join(dir, "image.json"));
    expect(readImageManifest(dir)).toBeNull();
  });

  it("takes an override URL only over https, a file, or this Mac's loopback (the hash is the trust either way)", () => {
    const m = manifest();
    expect(imageUrl(m)).toBe(m.url);
    expect(imageUrl(m, "http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(imageUrl(m, "file:///tmp/x.tar.zst")).toBe("file:///tmp/x.tar.zst");
    expect(imageUrl(m, "http://192.168.1.5/x")).toBeNull();
    expect(imageUrl(m, "ftp://example.com/x")).toBeNull();
  });

  it("asks for room for the download, the imported machine and 2 GiB, less what is already downloaded", () => {
    const m = manifest({ bytes: 700e6, unpackedBytes: 2.4e9 });
    expect(diskNeeded(m)).toBe(700e6 + 2.4e9 + 2 * 1024 ** 3);
    expect(diskNeeded(m, 300e6)).toBe(400e6 + 2.4e9 + 2 * 1024 ** 3);
  });
});

describe("the download", () => {
  it("resumes a dropped connection with a Range request and ends with every byte", async () => {
    const dir = tmp();
    const part = path.join(dir, "img.part");
    dropOnce = new Set(["/drop"]);
    hits.length = 0;
    const seen: number[] = [];
    await downloadResumable({ url: `${base}/drop`, part, bytes: BODY.length, signal: new AbortController().signal, onBytes: (n) => seen.push(n), backoffMs: 1 });
    expect(fs.readFileSync(part).equals(BODY)).toBe(true);
    expect(hits.map((h) => h.range)).toEqual([null, "bytes=100000-"]);
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
  });

  it("starts over when the server ignores the range", async () => {
    const dir = tmp();
    const part = path.join(dir, "img.part");
    fs.writeFileSync(part, BODY.subarray(0, 50_000));
    await downloadResumable({ url: `${base}/norange`, part, bytes: BODY.length, signal: new AbortController().signal, onBytes: () => {}, backoffMs: 1 });
    expect(fs.readFileSync(part).equals(BODY)).toBe(true);
  });

  it("gives up at once on a 404 (no retries)", async () => {
    const dir = tmp();
    hits.length = 0;
    await expect(downloadResumable({ url: `${base}/missing`, part: path.join(dir, "p"), bytes: BODY.length, signal: new AbortController().signal, onBytes: () => {}, backoffMs: 1 })).rejects.toThrow(/404/);
    expect(hits).toHaveLength(1);
  });

  it("copies a local file URL, resuming too", async () => {
    const dir = tmp();
    const src = path.join(dir, "img.tar.zst");
    fs.writeFileSync(src, BODY);
    const part = path.join(dir, "dl.part");
    fs.writeFileSync(part, BODY.subarray(0, 1234));
    await downloadResumable({ url: pathToFileURL(src).href, part, bytes: BODY.length, signal: new AbortController().signal, onBytes: () => {} });
    expect(fs.readFileSync(part).equals(BODY)).toBe(true);
  });
});

type Machine = { name: string; state: string; isolated: boolean; image: string | null; provisioned: string | null; created: boolean; host: string | null; gateway: boolean };

/** A fake OrbStack that can also import (the image's markers come with it), set config and delete. */
function fakeOrb(init: { machines?: Array<Partial<Machine> & { name: string }>; importFails?: boolean; importIsolated?: boolean; importHangs?: boolean } = {}) {
  const machines = new Map<string, Machine>((init.machines ?? []).map((m) => [m.name, { state: "running", isolated: true, image: null, provisioned: null, created: false, host: null, gateway: false, ...m }]));
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "list") return { ...ok, stdout: JSON.stringify([...machines.values()].map((m) => ({ name: m.name, state: m.state, config: { isolated: m.isolated } }))) };
    if (args[0] === "import") {
      if (init.importFails) return { code: 1, stdout: "", stderr: "import: bad archive" };
      const name = args[2]!;
      // Bug 435: orb never answered and was killed; the machine may be half there.
      if (init.importHangs) { machines.set(name, { name, state: "stopped", isolated: true, image: null, provisioned: null, created: false, host: null, gateway: false }); return { code: 124, stdout: "", stderr: "", timedOut: true }; }
      machines.set(name, { name, state: "stopped", isolated: init.importIsolated ?? true, image: IMAGE, provisioned: IMAGE, created: false, host: HOST, gateway: false });
      return ok;
    }
    if (args[0] === "config") return ok;
    if (args[0] === "delete") { machines.delete(args[2]!); return ok; }
    if (args[0] === "create") {
      const name = args.at(-1)!;
      machines.set(name, { name, state: "running", isolated: true, image: null, provisioned: null, created: false, host: null, gateway: false });
      return ok;
    }
    if (args[0] === "start") { const m = machines.get(args[1]!); if (m) m.state = "running"; return ok; }
    if (args[0] === "-m") {
      const m = machines.get(args[1]!)!;
      const script = args.at(-1)!;
      if (script.includes("created-by-synapse") && script.startsWith("install")) { m.created = true; return ok; }
      return { ...ok, stdout: `${m.image ?? ""}\n|\n${m.provisioned ?? ""}\n|\n${m.created ? "yes" : ""}\n|\n${m.host ?? ""}\n|\n${m.gateway ? "yes" : ""}\n` };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, machines, calls };
}

function deps(f: ReturnType<typeof fakeOrb>, o: { url?: string; manifest?: ImageManifest | null; free?: number | null; adopt?: { code: number; out: string }; cacheDir?: string; log?: string[] } = {}): BoxStepDeps {
  let connected = false;
  const log = o.log ?? [];
  return {
    exec: f.exec, orb: () => ORB, machine: "synapse-box", boxDir: "/App/Resources/box",
    imageVersion: () => IMAGE, hostBuild: () => HOST,
    reconnect: async () => { connected = !!f.machines.get("synapse-box")?.gateway; },
    connected: () => connected,
    forgetPin: () => log.push("forget-pin"),
    mac: { cpus: 10, totalMemBytes: 32 * 1024 ** 3 },
    run: async (_cmd, args, r) => {
      const script = args[0]!.split("/").at(-1)!;
      log.push(script);
      const m = f.machines.get(r.env.BOX_MACHINE!)!;
      if (script === "provision-from-mac.sh") { m.image = IMAGE; m.provisioned = IMAGE; }
      if (script === "deploy.sh") { m.host = HOST; m.gateway = true; }
    },
    image: {
      cacheDir: o.cacheDir ?? tmp(), freeBytes: () => (o.free === undefined ? 100e9 : o.free), urlOverride: o.url ?? `${base}/img`, arch: "arm64",
      manifest: () => (o.manifest === undefined ? manifest() : o.manifest),
      runPrep: async (args) => {
        log.push(`prep ${args.join(" ")}`);
        const r = o.adopt ?? { code: 0, out: "image-prep: adopted" };
        if (r.code === 0) f.machines.get("synapse-box")!.created = true;
        return r;
      },
    },
  };
}

async function runAll(d: BoxStepDeps, states: ProvisionState[] = []) {
  return new BoxProvisioner({ steps: boxSteps(d), publish: (s) => states.push(s) }).start();
}

describe("first run from the ready-made image", () => {
  it("downloads, verifies, imports, sizes, starts and adopts; provision is skipped and deploy runs; the bar only goes up", async () => {
    const f = fakeOrb();
    const log: string[] = [];
    const cacheDir = tmp();
    fs.writeFileSync(path.join(cacheDir, "synapse-box-1111111111111111-aaaaaaaaaaaa.tar.zst.part"), "an older version's download");
    const states: ProvisionState[] = [];
    const end = await runAll(deps(f, { log, cacheDir }), states);
    expect(end.phase).toBe("ready");
    expect(f.calls.some((c) => c[0] === "create")).toBe(false);
    const imp = f.calls.find((c) => c[0] === "import")!;
    expect(imp.slice(0, 3)).toEqual(["import", "-n", "synapse-box"]);
    expect(f.calls.filter((c) => c[0] === "config").map((c) => c.slice(2))).toEqual([
      ["machine.synapse-box.isolated", "true"], ["machine.synapse-box.cpu", "4"], ["machine.synapse-box.memory_mib", "8192"], ["machine.synapse-box.disk_bytes", String(64 * 1024 ** 3)],
    ]);
    expect(log).toEqual([`prep adopt ${IMAGE}`, "forget-pin", "deploy.sh"]);
    // The download, an older version's and the import marker are gone once it worked.
    expect(fs.readdirSync(cacheDir)).toEqual([]);
    const bars = states.map((s) => s.progress);
    expect(bars.every((p, i) => i === 0 || p >= bars[i - 1]!)).toBe(true);
    expect(new Set(states.map((s) => s.stage))).toEqual(new Set(["image", "download", "verify", "import", "start", "create", "provision", "start", "deploy", "connect", null]));
    // The image step owns most of the bar (create and provision are left out while it runs).
    const lastImage = states.filter((s) => s.step === "image").at(-1)!.progress;
    expect(lastImage).toBeGreaterThan(0.6);
  });

  it("a file that doesn't match the pinned SHA-256 never reaches OrbStack; setup carries on from scratch", async () => {
    const f = fakeOrb();
    const log: string[] = [];
    const cacheDir = tmp();
    const end = await runAll(deps(f, { log, cacheDir, manifest: manifest({ sha256: "0".repeat(64) }) }));
    expect(end.phase).toBe("ready");
    expect(f.calls.some((c) => c[0] === "import")).toBe(false);
    expect(f.calls.some((c) => c[0] === "create")).toBe(true);
    expect(log).toEqual(["forget-pin", "provision-from-mac.sh", "deploy.sh"]);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("an image adopt refuses (it held another install's files) is deleted, and the machine is made from scratch", async () => {
    const f = fakeOrb();
    const log: string[] = [];
    const end = await runAll(deps(f, { log, adopt: { code: 3, out: "image-prep: the image holds per-install files; refusing it" } }));
    expect(end.phase).toBe("ready");
    const order = f.calls.map((c) => c[0]).filter((c) => c === "import" || c === "delete" || c === "create");
    expect(order).toEqual(["import", "delete", "create"]);
    expect(log).toContain("provision-from-mac.sh");
  });

  it("OrbStack refusing the import, or a machine that isn't isolated, falls back too", async () => {
    for (const init of [{ importFails: true }, { importIsolated: false }]) {
      const f = fakeOrb(init);
      const end = await runAll(deps(f));
      expect(end.phase).toBe("ready");
      expect(f.calls.some((c) => c[0] === "create")).toBe(true);
      expect(f.machines.get("synapse-box")!.isolated).toBe(true);
    }
  });

  it("an import OrbStack never answers is killed, never retried, the half-import removed, then from scratch (bug 435)", async () => {
    const f = fakeOrb({ importHangs: true });
    const log: string[] = [];
    const end = await runAll(deps(f, { log }));
    expect(end.phase).toBe("ready");
    expect(f.calls.filter((c) => c[0] === "import")).toHaveLength(1);
    const del = f.calls.findIndex((c) => c[0] === "delete");
    expect(del).toBeGreaterThan(-1);
    expect(f.calls.findIndex((c) => c[0] === "create")).toBeGreaterThan(del);
    expect(f.machines.get("synapse-box")!.isolated).toBe(true);
  });

  it("no image for this version, no manifest, the switch off, or no disk: from scratch, nothing downloaded", async () => {
    for (const o of [{ manifest: manifest({ imageVersion: "1111111111111111" }) }, { manifest: null }, { url: "off" }, { free: 1e9 }, { free: null }]) {
      const f = fakeOrb();
      hits.length = 0;
      const end = await runAll(deps(f, o));
      expect(end.phase).toBe("ready");
      expect(f.calls.some((c) => c[0] === "import")).toBe(false);
      expect(f.calls.some((c) => c[0] === "create")).toBe(true);
      expect(hits).toHaveLength(0);
    }
  });

  it("a server that can't be reached falls back after its retries", async () => {
    const f = fakeOrb();
    const end = await runAll(deps(f, { url: `${base}/missing` }));
    expect(end.phase).toBe("ready");
    expect(f.calls.some((c) => c[0] === "create")).toBe(true);
  });

  it("an existing machine is never touched by the image step", async () => {
    const f = fakeOrb({ machines: [{ name: "synapse-box", image: IMAGE, provisioned: IMAGE, created: true, host: HOST, gateway: true }] });
    hits.length = 0;
    const end = await runAll(deps(f));
    expect(end.phase).toBe("ready");
    expect(hits).toHaveLength(0);
    expect(f.calls.some((c) => c[0] === "import" || c[0] === "delete")).toBe(false);
  });

  it("an import a quit left half done is removed and done again", async () => {
    const cacheDir = tmp();
    fs.writeFileSync(path.join(cacheDir, "importing-synapse-box"), "1\n");
    const f = fakeOrb({ machines: [{ name: "synapse-box", state: "stopped", isolated: false, image: IMAGE, provisioned: IMAGE }] });
    const end = await runAll(deps(f, { cacheDir }));
    expect(end.phase).toBe("ready");
    expect(f.calls.map((c) => c[0]).filter((c) => c === "delete" || c === "import")).toEqual(["delete", "import"]);
    expect(f.calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("Stop during the download keeps what arrived; Retry resumes it with a Range request", async () => {
    const f = fakeOrb();
    const cacheDir = tmp();
    dropOnce = new Set();
    const d = deps(f, { cacheDir });
    let p!: BoxProvisioner;
    let stopped = false;
    p = new BoxProvisioner({
      steps: boxSteps(d),
      publish: (s) => { if (!stopped && s.stage === "download" && s.progress > 0.05) { stopped = true; p.cancel(); } },
    });
    // A slow server for the first try: 16 KB at a time.
    const slow = http.createServer((req, res) => {
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      const start = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, { "content-length": String(BODY.length - start) });
      let i = start;
      const tick = () => { if (i >= BODY.length || res.destroyed) { res.end(); return; } res.write(BODY.subarray(i, i + 16_384)); i += 16_384; setTimeout(tick, 5); };
      tick();
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    d.image!.urlOverride = `http://127.0.0.1:${(slow.address() as { port: number }).port}/img`;
    const first = await p.start();
    expect(first.phase).toBe("cancelled");
    const part = fs.readdirSync(cacheDir).find((n) => n.endsWith(".part"))!;
    const have = fs.statSync(path.join(cacheDir, part)).size;
    expect(have).toBeGreaterThan(0);
    expect(have).toBeLessThan(BODY.length);
    const again = await p.start();
    slow.close();
    expect(again.phase).toBe("ready");
    expect(f.calls.some((c) => c[0] === "import")).toBe(true);
  });
});
