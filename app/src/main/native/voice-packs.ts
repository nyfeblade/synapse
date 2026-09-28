import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STR_SETUP } from "@synapse/shared";
import { engineDirs } from "../profile";
import type { registerNative } from "../native";

/**
 * Portable install: the optional "natural voices" (Qwen3) and "cloned voices" (F5) packs. Each is a
 * self-contained runtime — a pinned python-build-standalone, the exact packages the app was tested with
 * (native/<engine>/requirements.lock, --require-hashes, wheels only) — plus the model weights at a pinned
 * revision, every file sha256-checked. They go into Synapse's shared folder (…/Synapse/<engine>), never into
 * the user's own Python, Homebrew or Hugging Face cache, and nothing is ever fetched at speak time.
 * Downloads resume (.part + HTTP Range) and the pack is marked installed (pack.json) only when complete.
 */

export interface PackFile { path: string; bytes: number; sha256: string }
export interface ModelSource { repo: string; revision: string; files: PackFile[]; into: "model" | "hf" }
export interface PackDef { id: "qwen" | "f5"; label: string; wheelsBytes: number; models: ModelSource[]; probe: string }

/** The same pinned interpreter the bundled Kokoro runtime uses (native/kokoro/runtime.lock.json; a test keeps them in step). */
export const PACK_PYTHON = {
  version: "3.12.14",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260924/cpython-3.12.14%2B20260924-aarch64-apple-darwin-install_only.tar.gz",
  sha256: "9763f43db2481a6af36af82ec40302aab7a73632f880129d07a6e81aec846277",
  bytes: 25_153_879,
};
/** Bump when a pack's contents change: an older pack.json is then offered as an update. */
export const PACK_VERSION = 1;

const QWEN_PROBE = "import importlib.metadata as md, mlx.core; from mlx_audio.tts.utils import get_model_and_args; get_model_and_args('qwen3_tts', {}); print(md.version('mlx-audio'))";
const F5_PROBE = "import importlib.util as u, mlx.core; missing=[m for m in ('f5_tts_mlx','vocos_mlx','soundfile','numpy') if u.find_spec(m) is None]; assert not missing, 'missing: ' + ', '.join(missing)";

export const PACKS: readonly PackDef[] = [
  {
    id: "qwen", label: STR_SETUP.naturalVoices, wheelsBytes: 96_000_000, probe: QWEN_PROBE,
    models: [{
      repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", revision: "049ef77fe8816b536193c0c25f9a214d17921282", into: "model",
      files: [
        { path: "config.json", bytes: 6058, sha256: "2eea3665564268139c3beb8d497fd3c2e4524e9eed5452836cdf1de96ed3cdbd" },
        { path: "generation_config.json", bytes: 245, sha256: "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa" },
        { path: "merges.txt", bytes: 1671839, sha256: "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3" },
        { path: "model.safetensors", bytes: 1286743170, sha256: "3bcb2c4a127e6243e81a30b7126c7865f686d3559de4f938e5d3b150c6a9560d" },
        { path: "model.safetensors.index.json", bytes: 71447, sha256: "0c92041960fa189cf35ae538c8d9ca07c468edddd0c9bb52274c5d4d287a860b" },
        { path: "preprocessor_config.json", bytes: 127, sha256: "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119" },
        { path: "speech_tokenizer/config.json", bytes: 2336, sha256: "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167" },
        { path: "speech_tokenizer/configuration.json", bytes: 76, sha256: "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd" },
        { path: "speech_tokenizer/model.safetensors", bytes: 682293092, sha256: "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258" },
        { path: "speech_tokenizer/preprocessor_config.json", bytes: 234, sha256: "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb" },
        { path: "tokenizer_config.json", bytes: 7344, sha256: "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670" },
        { path: "vocab.json", bytes: 2776833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" },
      ],
    }],
  },
  {
    id: "f5", label: STR_SETUP.clonedVoices, wheelsBytes: 110_000_000, probe: F5_PROBE,
    models: [
      {
        repo: "lucasnewman/f5-tts-mlx", revision: "2d719cadec8fd3887c8599475a5f65924d523654", into: "hf",
        files: [
          { path: "duration_v2.safetensors", bytes: 86238439, sha256: "25c4701cf765a9175d4fac624b39baab9714cffb41a73465438326952a23348e" },
          { path: "model_v1.safetensors", bytes: 1348435761, sha256: "670900fd14e6c458b95da6e9ed317cdb20dbaf7a1c02ac06a05475a9d32b6a38" },
          { path: "model_v1_4b.safetensors", bytes: 232477651, sha256: "a7bdc5f6b021d4636205a97896383e8dc012de1b967aca85074e7a461eb1b007" },
          { path: "vocab.txt", bytes: 11255, sha256: "4e173934be56219eb38759fa8d4c48132d5a34454f0c44abce409bcf6a07ec46" },
        ],
      },
      {
        repo: "lucasnewman/vocos-mel-24khz", revision: "ee89d00fac94b61e1235e0869f3e8d49711b7484", into: "hf",
        files: [
          { path: "config.yaml", bytes: 461, sha256: "da9033922f969a47f0c160010226919e59f27761fd5066f3828d46de6650b0fc" },
          { path: "model.safetensors", bytes: 54348264, sha256: "7fd11dcafe62b373156b3a12c0199bbc09b0ce1636692f97eef99ffec02fadb2" },
        ],
      },
    ],
  },
];

/** The pack's folder: the shared …/Synapse/<engine> (every profile uses one copy). */
export function packRoot(userData: string, id: PackDef["id"]): string {
  return engineDirs(userData, id).at(-1)!;
}
export const packPython = (root: string) => path.join(root, "runtime", "python", "bin", "python3.12");
export const packModelDir = (root: string) => path.join(root, "model");
/** F5's weights, laid out as a Hugging Face cache (the sidecar runs with HF_HOME pointed here, offline). */
export const packHfHome = (root: string) => path.join(root, "hf");

/** Where one model file lands inside the pack. */
export function modelFilePath(root: string, m: ModelSource, f: PackFile): string {
  if (m.into === "model") return path.join(packModelDir(root), f.path);
  return path.join(packHfHome(root), "hub", `models--${m.repo.replace("/", "--")}`, "snapshots", m.revision, f.path);
}

export function packBytes(def: PackDef): number {
  return PACK_PYTHON.bytes + def.wheelsBytes + def.models.reduce((n, m) => n + m.files.reduce((k, f) => k + f.bytes, 0), 0);
}

export function packInstalled(root: string, exists: (p: string) => boolean = fs.existsSync, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): boolean {
  try {
    const j = JSON.parse(read(path.join(root, "pack.json"))) as { version?: number };
    return (j.version ?? 0) >= PACK_VERSION && exists(packPython(root));
  } catch { return false; }
}

export type PackProgress = { phase: "python" | "packages" | "model" | "checking"; received: number; total: number };

async function sha256Of(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * Downloads `url` to `dest`, resuming a `.part` with an HTTP Range request; checks size (and sha256 when
 * the pin has one). `onBytes` gets every chunk's length, so the caller can drive one bar across files.
 */
export async function fetchResumable(o: { url: string; dest: string; bytes: number; sha256: string; fetchFn?: typeof fetch; signal?: AbortSignal; onBytes(n: number): void }): Promise<void> {
  if (fs.existsSync(o.dest) && fs.statSync(o.dest).size === o.bytes && (!o.sha256 || (await sha256Of(o.dest)) === o.sha256)) { o.onBytes(o.bytes); return; }
  fs.mkdirSync(path.dirname(o.dest), { recursive: true });
  const part = `${o.dest}.part`;
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > o.bytes) { fs.rmSync(part, { force: true }); have = 0; }
  const res = await (o.fetchFn ?? fetch)(o.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${path.basename(o.dest)}`);
  if (have && res.status !== 206) have = 0; // the server ignored the range: start over
  o.onBytes(have);
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      o.onBytes(chunk.length);
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  const size = fs.statSync(part).size;
  if (size !== o.bytes) throw new Error(`${path.basename(o.dest)} ended early (${size} of ${o.bytes} bytes)`);
  if (o.sha256 && (await sha256Of(part)) !== o.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${path.basename(o.dest)} does not match its checksum`); }
  fs.renameSync(part, o.dest);
}

export type Run = (cmd: string, args: string[], signal?: AbortSignal, env?: Record<string, string>) => Promise<{ code: number; out: string }>;
const runProcess: Run = (cmd, args, signal, env) => new Promise((resolve) => {
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal, ...(env ? { env } : {}) });
  let out = "";
  c.stdout?.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-8000); });
  c.stderr?.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-8000); });
  c.on("error", (e) => resolve({ code: 1, out: `${out}\n${e.message}` }));
  c.on("close", (code) => resolve({ code: code ?? 1, out }));
});

/**
 * Install one pack into `root`. Idempotent: a runtime that already probes ok is kept, finished model
 * files are kept, and a partial download resumes. Throws a one-line reason on failure.
 */
export async function installPack(o: {
  def: PackDef; root: string; requirements: string; freeBytes(): number | null;
  onProgress(p: PackProgress): void; log(line: string): void;
  fetchFn?: typeof fetch; run?: Run; signal?: AbortSignal;
}): Promise<void> {
  const run = o.run ?? runProcess;
  // Fix round 1: pip sees nothing of the user's setup — no pip.conf (PIP_CONFIG_FILE=/dev/null plus --isolated), no
  // PIP_* or PYTHON* variable, no user index or proxy settings — so only the pinned, hash-checked files install.
  const pipEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: o.root, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8",
    PIP_CONFIG_FILE: "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1",
  };
  const total = packBytes(o.def);
  const free = o.freeBytes();
  if (free !== null && free < total * 1.6) throw new Error(`Not enough free space: ${STR_SETUP.size(total * 1.6)} needed, ${STR_SETUP.size(free)} free.`);
  let received = 0;
  const bump = (phase: PackProgress["phase"], n: number) => { received += n; o.onProgress({ phase, received: Math.min(received, total), total }); };
  const python = packPython(o.root);
  const probe = async () => (await run("/usr/bin/arch", ["-arm64", python, "-s", "-E", "-B", "-c", o.def.probe], o.signal)).code === 0;

  if (!(fs.existsSync(python) && await probe())) {
    // 1. The interpreter.
    const tarball = path.join(o.root, ".downloads", decodeURIComponent(path.basename(PACK_PYTHON.url)));
    await fetchResumable({ url: PACK_PYTHON.url, dest: tarball, bytes: PACK_PYTHON.bytes, sha256: PACK_PYTHON.sha256, fetchFn: o.fetchFn, signal: o.signal, onBytes: (n) => bump("python", n) });
    const tmp = path.join(o.root, "runtime.tmp");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const tar = await run("/usr/bin/tar", ["-xzf", tarball, "-C", tmp], o.signal);
    if (tar.code !== 0) throw new Error(`Couldn't unpack the voice runtime: ${tar.out.trim().split("\n").at(-1)}`);
    // 2. The packages, exactly as pinned (hash-checked, wheels only, nothing else pulled in).
    o.log(`voice pack ${o.def.id}: installing packages`);
    const pip = await run("/usr/bin/arch", ["-arm64", path.join(tmp, "python", "bin", "python3.12"), "-s", "-E", "-m", "pip", "install", "--isolated",
      "--disable-pip-version-check", "--no-input", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", o.requirements], o.signal, pipEnv);
    if (pip.code !== 0) throw new Error(`Couldn't install the voice packages: ${pip.out.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${pip.code}`}`);
    // A package that ships no wheel (F5's jieba): built from its pinned source archive, with the setuptools
    // pass 1 installed, and nothing else fetched to build it.
    const sdist = o.requirements.replace(/\.lock$/, "-sdist.lock");
    if (fs.existsSync(sdist)) {
      const src = await run("/usr/bin/arch", ["-arm64", path.join(tmp, "python", "bin", "python3.12"), "-s", "-E", "-m", "pip", "install", "--isolated",
        "--disable-pip-version-check", "--no-input", "--require-hashes", "--no-deps", "--no-build-isolation", "--no-binary=:all:", "-r", sdist], o.signal, pipEnv);
      if (src.code !== 0) throw new Error(`Couldn't install the voice packages: ${src.out.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${src.code}`}`);
    }
    bump("packages", o.def.wheelsBytes);
    fs.rmSync(path.join(o.root, "runtime"), { recursive: true, force: true });
    fs.renameSync(tmp, path.join(o.root, "runtime"));
    fs.rmSync(tarball, { force: true });
  } else {
    bump("packages", PACK_PYTHON.bytes + o.def.wheelsBytes);
  }

  // 3. The weights, file by file, resumable, checked.
  for (const m of o.def.models) {
    for (const f of m.files) {
      const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`;
      await fetchResumable({ url, dest: modelFilePath(o.root, m, f), bytes: f.bytes, sha256: f.sha256, fetchFn: o.fetchFn, signal: o.signal, onBytes: (n) => bump("model", n) });
    }
    if (m.into === "hf") {
      // What huggingface_hub's offline resolution reads: refs/main → the pinned snapshot.
      const refs = path.join(packHfHome(o.root), "hub", `models--${m.repo.replace("/", "--")}`, "refs");
      fs.mkdirSync(refs, { recursive: true });
      fs.writeFileSync(path.join(refs, "main"), m.revision);
    }
  }

  // 4. It loads.
  o.onProgress({ phase: "checking", received: total, total });
  if (!(await probe())) throw new Error("The voice runtime installed but doesn't load.");
  fs.writeFileSync(path.join(o.root, "pack.json"), JSON.stringify({ id: o.def.id, version: PACK_VERSION, installedAt: new Date().toISOString() }, null, 2));
}

export interface PackRow { id: PackDef["id"]; label: string; bytes: number; state: "available" | "installing" | "installed" | "failed"; progress: number; error?: string | null }

/** Settings and the setup screen: list, install (one at a time per pack), cancel. */
export function registerVoicePacks(o: {
  reg: typeof registerNative; emit(channel: string, payload: unknown): void;
  userData: string; nativeDir: string; log(line: string): void;
  /** An engine that already works without a pack (an env set up earlier, a path set by hand) counts as installed. */
  working(id: PackDef["id"]): Promise<boolean>;
  /** The pack finished: the engine re-probes. */
  installed(id: PackDef["id"]): void;
  freeBytes(): number | null;
  fetchFn?: typeof fetch; run?: Run;
}): { list(): Promise<PackRow[]> } {
  const busy = new Map<string, { progress: number; ac: AbortController }>();
  const failed = new Map<string, string>();
  const list = async (): Promise<PackRow[]> => Promise.all(PACKS.map(async (d) => {
    const root = packRoot(o.userData, d.id);
    const b = busy.get(d.id);
    const state: PackRow["state"] = b ? "installing" : packInstalled(root) || (await o.working(d.id).catch(() => false)) ? "installed" : failed.has(d.id) ? "failed" : "available";
    return { id: d.id, label: d.label, bytes: packBytes(d), state, progress: b?.progress ?? 0, error: failed.get(d.id) ?? null };
  }));
  const publish = () => void list().then((l) => o.emit("voice-packs", l));
  o.reg("voicePacks.list", () => list());
  o.reg("voicePacks.install", (a: { id?: unknown }) => {
    const def = PACKS.find((d) => d.id === a?.id);
    if (!def) throw new Error("Unknown voice pack.");
    if (busy.has(def.id)) return { started: false };
    const ac = new AbortController();
    busy.set(def.id, { progress: 0, ac });
    failed.delete(def.id);
    publish();
    let last = 0;
    void installPack({
      def, root: packRoot(o.userData, def.id), requirements: path.join(o.nativeDir, `${def.id}-requirements.lock`),
      freeBytes: o.freeBytes, log: o.log, fetchFn: o.fetchFn, run: o.run, signal: ac.signal,
      onProgress: (p) => {
        const b = busy.get(def.id);
        if (b) b.progress = p.received / p.total;
        if (Date.now() - last > 250) { last = Date.now(); publish(); }
      },
    }).then(() => {
      busy.delete(def.id);
      o.log(`voice pack ${def.id}: installed`);
      o.installed(def.id);
      publish();
    }, (e: unknown) => {
      busy.delete(def.id);
      const m = ac.signal.aborted ? "Stopped." : e instanceof Error ? e.message : String(e);
      failed.set(def.id, m);
      o.log(`voice pack ${def.id}: failed: ${m}`);
      publish();
    });
    return { started: true };
  });
  o.reg("voicePacks.cancel", (a: { id?: unknown }) => { busy.get(String(a?.id))?.ac.abort(); return { ok: true }; });
  return { list };
}
