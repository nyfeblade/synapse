import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UpdateService, releaseZipName } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

// Review of 5d554660: TOCTOU on the local folder, a bad tag in the list, concurrent check/download,
// token scope, and a download size cap.
const keys = crypto.generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const shaOf = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const sign = (name: string, v: string, sha: string) => crypto.sign(null, Buffer.from(`${name}|${v}|${sha}`), keys.privateKey).toString("base64");
const zipFor = (v: string) => Buffer.from(`zip of ${v}`);

type Asset = { name: string; url: string };
const rel = (v: string, tag = `v${v}`, origin = "https://api.github.com") => ({
  tag_name: tag, draft: false, prerelease: false,
  assets: [
    { name: releaseZipName(v), url: `${origin}/repos/o/r/releases/assets/${v}-z` },
    { name: `${releaseZipName(v)}.sha256`, url: `${origin}/repos/o/r/releases/assets/${v}-h` },
    { name: `${releaseZipName(v)}.sig`, url: `${origin}/repos/o/r/releases/assets/${v}-s` },
  ] as Asset[],
});

function feed(releases: () => unknown[], o: { zipHeaders?: Record<string, string>; zipBody?: () => ReadableStream<Uint8Array>; gate?: Promise<void> } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const id = url.split("/").pop()!;
    const v = id.replace(/-[zhs]$/, "");
    if (id.endsWith("-z") && o.gate) await o.gate;
    const bytes = zipFor(v);
    return {
      ok: true, status: 200,
      headers: new Headers(id.endsWith("-z") ? (o.zipHeaders ?? {}) : {}),
      body: id.endsWith("-z") && o.zipBody ? o.zipBody() : null,
      json: async () => releases(),
      text: async () => (id.endsWith("-h") ? `${shaOf(bytes)}  x\n` : id.endsWith("-s") ? sign(releaseZipName(v), v, shaOf(bytes)) : ""),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function svc(fetchFn: typeof fetch, o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-h-"));
  const s = new UpdateService({ current: "0.2.0", feed: () => "o/r", packaged: true, appPath: "/Applications/Synapse.app", stageDir, fetchFn, run: fakeDitto(() => "0.3.0", "Synapse.app"), emit: () => {}, publicKey: pub, verifySignature: async () => {}, ...o });
  return { s, stageDir };
}

describe("local folder: the zip is copied into the private stage dir before it is hashed, verified and unpacked", () => {
  it("ditto unpacks the stage-dir copy, never the file in the (user-writable) release folder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    const bytes = Buffer.from("zip-bytes");
    const name = releaseZipName("0.3.0");
    fs.writeFileSync(path.join(dir, name), bytes);
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ name: "Synapse", version: "0.3.0", zip: name, sha256: shaOf(bytes), sig: sign(name, "0.3.0", shaOf(bytes)) }));
    const inner = fakeDitto("0.3.0", "Synapse.app");
    const seen: string[] = [];
    const run = vi.fn(async (cmd: string, args: string[]) => {
      seen.push(args[2]!);
      // Whatever lands in the folder after the check must not be what gets unpacked.
      fs.writeFileSync(path.join(dir, name), "evil swapped in");
      expect(fs.readFileSync(args[2]!, "utf8")).toBe("zip-bytes");
      return inner(cmd, args);
    });
    const { s, stageDir } = svc(vi.fn() as unknown as typeof fetch, { feed: () => null, folder: () => dir, run });
    await s.check();
    expect((await s.download()).status).toBe("ready");
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0]!)).toBe(stageDir);
  });
});

describe("GitHub list: a tag the semver parser rejects is skipped, not thrown on", () => {
  it("v01.0.0 (a leading zero) doesn't break the sort; the valid release is still offered", async () => {
    const { fn } = feed(() => [rel("1.0.0", "v01.0.0"), rel("0.3.0")]);
    const st = await svc(fn).s.check();
    expect(st).toMatchObject({ status: "available", latest: "0.3.0", error: null });
  });
});

describe("concurrent check and download", () => {
  it("two checks at once share one request", async () => {
    const { fn, calls } = feed(() => [rel("0.3.0")]);
    const { s } = svc(fn);
    const [a, b] = await Promise.all([s.check(), s.check()]);
    expect(a.status).toBe("available");
    expect(b.status).toBe("available");
    expect(calls.filter((c) => c.url.includes("/releases?"))).toHaveLength(1);
  });

  it("two downloads at once share one run", async () => {
    const { fn, calls } = feed(() => [rel("0.3.0")]);
    const { s } = svc(fn);
    await s.check();
    const [a, b] = await Promise.all([s.download(), s.download()]);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(calls.filter((c) => c.url.endsWith("-z"))).toHaveLength(1);
  });

  it("a check that finds a newer release mid-download can't change what that download installs", async () => {
    let releases = [rel("0.3.0")];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { fn, calls } = feed(() => releases, { gate });
    let bundle = "0.3.0";
    const { s } = svc(fn, { run: fakeDitto(() => bundle, "Synapse.app") });
    await s.check();
    const dl = s.download();
    await new Promise((r) => setTimeout(r, 10));
    releases = [rel("0.4.0"), rel("0.3.0")];
    bundle = "0.3.0";
    await s.check();
    open();
    const st = await dl;
    expect(st.status, st.error ?? "").toBe("ready");
    expect(st.latest).toBe("0.3.0");
    expect(calls.filter((c) => c.url.includes("/assets/")).map((c) => c.url.split("/").pop())).toEqual(["0.3.0-h", "0.3.0-z", "0.3.0-s"]);
    expect(s.swapArgs(1)[3]).toMatch(/healthy-0\.3\.0$/);
  });
});

describe("the token only ever goes to api.github.com", () => {
  it("an asset URL on another origin gets no Authorization header", async () => {
    const r = rel("0.3.0", "v0.3.0", "https://objects.example.com");
    const { fn, calls } = feed(() => [r]);
    const { s } = svc(fn, { token: () => "ghp_secret" });
    await s.check();
    await s.download();
    expect(calls.find((c) => c.url.includes("/releases?"))!.headers.authorization).toBe("Bearer ghp_secret");
    const assetCalls = calls.filter((c) => c.url.startsWith("https://objects.example.com"));
    expect(assetCalls.length).toBeGreaterThan(0);
    for (const c of assetCalls) expect(c.headers.authorization).toBeUndefined();
  });

  it("a look-alike origin (api.github.com.evil) gets no token either", async () => {
    const r = rel("0.3.0", "v0.3.0", "https://api.github.com.evil.example");
    const { fn, calls } = feed(() => [r]);
    const { s } = svc(fn, { token: () => "ghp_secret" });
    await s.check();
    await s.download();
    for (const c of calls.filter((c) => c.url.includes("evil"))) expect(c.headers.authorization).toBeUndefined();
  });
});

describe("the zip download is size-capped", () => {
  it("refuses a Content-Length over the cap without reading the body", async () => {
    const { fn } = feed(() => [rel("0.3.0")], { zipHeaders: { "content-length": String(10_000) } });
    const { s, stageDir } = svc(fn, { maxDownloadBytes: 1000 });
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/too large/);
    expect(fs.readdirSync(stageDir)).toEqual([]);
  });

  it("refuses a streamed body that runs past the cap (no or lying Content-Length), and leaves nothing behind", async () => {
    const chunk = new Uint8Array(400);
    const zipBody = () => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(chunk); c.close(); } });
    for (const zipHeaders of [{}, { "content-length": "10" }] as Record<string, string>[]) {
      const { fn } = feed(() => [rel("0.3.0")], { zipBody, zipHeaders });
      const { s, stageDir } = svc(fn, { maxDownloadBytes: 1000 });
      await s.check();
      const st = await s.download();
      expect(st.status).toBe("error");
      expect(st.error).toMatch(/too large/);
      expect(fs.readdirSync(stageDir)).toEqual([]);
    }
  });

  it("a streamed body under the cap installs", async () => {
    const bytes = zipFor("0.3.0");
    const zipBody = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes.subarray(0, 4))); c.enqueue(new Uint8Array(bytes.subarray(4))); c.close(); } });
    const { fn } = feed(() => [rel("0.3.0")], { zipBody });
    const { s } = svc(fn, { maxDownloadBytes: 1000 });
    await s.check();
    expect((await s.download()).status).toBe("ready");
  });
});
