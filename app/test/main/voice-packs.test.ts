import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKS, PACK_PYTHON, fetchResumable, installPack, modelFilePath, packBytes, packInstalled, packPython, type PackDef, type Run,
} from "../../src/main/native/voice-packs";

// Portable install: the optional voice packs download a pinned runtime and pinned weights into Synapse's own
// folder, resumably, every file checked — never the user's Python, Homebrew or Hugging Face cache.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "packs-")); dirs.push(d); return d; };
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** A fake HTTP server that honours Range, and can drop the connection after `cut` bytes once. */
function server(files: Record<string, Buffer>, o: { cut?: number } = {}) {
  const seen: Array<{ url: string; range: string | null }> = [];
  let cut = o.cut;
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.range ?? null;
    seen.push({ url, range });
    const body = files[url];
    if (!body) return new Response(null, { status: 404 });
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    let chunk = body.subarray(from);
    if (cut !== undefined) { chunk = chunk.subarray(0, cut); cut = undefined; }
    return new Response(new Uint8Array(chunk), { status: range ? 206 : 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe("fetchResumable", () => {
  it("resumes a cut download with a Range request and checks the result", async () => {
    const data = crypto.randomBytes(100_000);
    const s = server({ "https://x/f": data }, { cut: 40_000 });
    const dest = path.join(tmp(), "f");
    let n = 0;
    await expect(fetchResumable({ url: "https://x/f", dest, bytes: data.length, sha256: sha(data), fetchFn: s.fetchFn, onBytes: (b) => { n += b; } })).rejects.toThrow(/ended early/);
    expect(fs.existsSync(`${dest}.part`)).toBe(true);
    await fetchResumable({ url: "https://x/f", dest, bytes: data.length, sha256: sha(data), fetchFn: s.fetchFn, onBytes: () => {} });
    expect(s.seen.at(-1)!.range).toBe("bytes=40000-");
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
    expect(n).toBe(40_000);
  });

  it("refuses a file that doesn't match its pin, and keeps nothing of it", async () => {
    const data = Buffer.from("not the weights");
    const s = server({ "https://x/f": data });
    const dest = path.join(tmp(), "f");
    await expect(fetchResumable({ url: "https://x/f", dest, bytes: data.length, sha256: "0".repeat(64), fetchFn: s.fetchFn, onBytes: () => {} })).rejects.toThrow(/checksum/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it("a finished, matching file is not fetched again", async () => {
    const data = Buffer.from("weights");
    const s = server({ "https://x/f": data });
    const dest = path.join(tmp(), "f");
    fs.writeFileSync(dest, data);
    await fetchResumable({ url: "https://x/f", dest, bytes: data.length, sha256: sha(data), fetchFn: s.fetchFn, onBytes: () => {} });
    expect(s.seen).toEqual([]);
  });
});

describe("installPack", () => {
  const weights = Buffer.from("tiny weights");
  const def: PackDef = {
    id: "qwen", label: "Natural voices", wheelsBytes: 10, probe: "print(1)",
    models: [{ repo: "org/model", revision: "abc", into: "model", files: [{ path: "model.safetensors", bytes: weights.length, sha256: sha(weights) }] }],
  };
  const pyTar = Buffer.from("python tarball");

  function world(o: { probeOk?: () => boolean; pipOk?: boolean } = {}) {
    const root = tmp();
    const calls: string[][] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const run: Run = async (cmd, args, _signal, env) => {
      calls.push([cmd, ...args]);
      envs.push(env);
      if (cmd === "/usr/bin/tar") { const out = args[args.indexOf("-C") + 1]!; fs.mkdirSync(path.join(out, "python", "bin"), { recursive: true }); fs.writeFileSync(path.join(out, "python", "bin", "python3.12"), ""); return { code: 0, out: "" }; }
      if (args.includes("pip")) return { code: o.pipOk === false ? 1 : 0, out: o.pipOk === false ? "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES" : "" };
      return { code: (o.probeOk ?? (() => true))() ? 0 : 1, out: "" };
    };
    const s = server({ [PACK_PYTHON.url]: pyTar, "https://huggingface.co/org/model/resolve/abc/model.safetensors": weights });
    return { root, calls, envs, run, s };
  }
  const opts = (w: ReturnType<typeof world>) => ({
    def, root: w.root, requirements: "/app/native/qwen-requirements.lock", freeBytes: () => 1e12, log: () => {}, onProgress: () => {}, run: w.run, fetchFn: w.s.fetchFn,
  });

  it("installs the runtime (pinned packages, hash-checked, wheels only) and the weights, then marks it installed", async () => {
    const w = world({ probeOk: () => true });
    // The pinned interpreter's hash is the real one; serve bytes that match a patched pin for the test.
    const orig = { ...PACK_PYTHON };
    Object.assign(PACK_PYTHON, { sha256: sha(pyTar), bytes: pyTar.length });
    try { await installPack(opts(w)); } finally { Object.assign(PACK_PYTHON, orig); }
    const pip = w.calls.find((c) => c.includes("pip"))!;
    expect(pip).toEqual(expect.arrayContaining(["install", "--isolated", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", "/app/native/qwen-requirements.lock"]));
    // Fix round 1: no pip.conf, no PIP_* variable and no user index can change what gets installed.
    const env = w.envs[w.calls.indexOf(pip)]!;
    expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
    expect(Object.keys(env).filter((k) => k.startsWith("PIP_")).sort()).toEqual(["PIP_CONFIG_FILE", "PIP_DISABLE_PIP_VERSION_CHECK", "PIP_NO_INPUT"]);
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(fs.readFileSync(modelFilePath(w.root, def.models[0]!, def.models[0]!.files[0]!)).equals(weights)).toBe(true);
    expect(packInstalled(w.root)).toBe(true);
    expect(fs.existsSync(packPython(w.root))).toBe(true);
  });

  it("a failed package install says why in one line and leaves nothing half-installed", async () => {
    const w = world({ probeOk: () => false, pipOk: false });
    const orig = { ...PACK_PYTHON };
    Object.assign(PACK_PYTHON, { sha256: sha(pyTar), bytes: pyTar.length });
    try { await expect(installPack(opts(w))).rejects.toThrow(/DO NOT MATCH THE HASHES/); } finally { Object.assign(PACK_PYTHON, orig); }
    expect(packInstalled(w.root)).toBe(false);
    expect(fs.existsSync(path.join(w.root, "runtime"))).toBe(false);
  });

  it("refuses to start without room for it", async () => {
    const w = world();
    await expect(installPack({ ...opts(w), freeBytes: () => 1000 })).rejects.toThrow(/free space/);
    expect(w.calls).toEqual([]);
  });

  it("a runtime that already loads is kept: a retry only fetches what's missing", async () => {
    const w = world({ probeOk: () => true });
    fs.mkdirSync(path.dirname(packPython(w.root)), { recursive: true });
    fs.writeFileSync(packPython(w.root), "");
    await installPack(opts(w));
    expect(w.calls.some((c) => c.includes("pip") || c[0] === "/usr/bin/tar")).toBe(false);
    expect(w.s.seen.map((x) => x.url)).toEqual(["https://huggingface.co/org/model/resolve/abc/model.safetensors"]);
  });
});

describe("the pack pins", () => {
  it("use the same interpreter the bundled Kokoro runtime pins", () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../native/kokoro/runtime.lock.json"), "utf8"));
    expect({ url: PACK_PYTHON.url, sha256: PACK_PYTHON.sha256 }).toEqual({ url: lock.python.url, sha256: lock.python.sha256 });
  });

  it("every weight file is pinned by sha256, and each pack ships its package lock", () => {
    for (const p of PACKS) {
      for (const m of p.models) {
        expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
        for (const f of m.files) expect(f.sha256, `${p.id} ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
      }
      const lock = fs.readFileSync(path.resolve(__dirname, `../../native/${p.id}/requirements.lock`), "utf8");
      for (const line of lock.split("\n").filter((l) => l && !l.startsWith("#"))) expect(line, line).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      expect(packBytes(p)).toBeGreaterThan(1e9);
    }
  });

  it("F5's weights land in a Hugging Face layout the sidecar reads offline through HF_HOME", () => {
    const f5 = PACKS.find((p) => p.id === "f5")!;
    expect(modelFilePath("/B/f5", f5.models[0]!, f5.models[0]!.files[0]!))
      .toBe("/B/f5/hf/hub/models--lucasnewman--f5-tts-mlx/snapshots/2d719cadec8fd3887c8599475a5f65924d523654/duration_v2.safetensors");
  });
});
