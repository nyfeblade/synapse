#!/usr/bin/env node
// Portable install: the Kokoro voice ships INSIDE Synapse.app (Contents/Resources/kokoro), so a new
// Mac speaks without any Python, venv or model of its own. Nothing here reads or writes a voice path outside Synapse's own data.
//
//   <kokoro>/python/   python-build-standalone (arm64, install_only), pinned by sha256, with the
//                      sidecar's exact import closure pip-installed into its own site-packages
//                      (native/kokoro/requirements.lock: --require-hashes, --no-deps, wheels only)
//   <kokoro>/model/    mlx-community/Kokoro-82M-4bit at a pinned revision, every file sha256-checked
//   <kokoro>/manifest.json
//
// Downloads and the built runtime are cached under <repo>/.build-cache (or SYNAPSE_BUILD_CACHE), never
// in git: a second package run copies the cached runtime (APFS clone) instead of rebuilding it.
//
//   node scripts/kokoro-runtime.mjs stage <destDir>          → <destDir>/kokoro
//   node scripts/kokoro-runtime.mjs speak <kokoroDir> <out.wav> ["text"]
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(here, "native", "kokoro", "runtime.lock.json");
const REQS = path.join(here, "native", "kokoro", "requirements.lock");
const SERVER = path.join(here, "native", "kokoro", "kokoro_server.py");

/** Where the bundled runtime lives inside the .app, and the paths inside it (kokoro.ts reads the same). */
export const KOKORO_RESOURCE = "kokoro";
// python3.12, not the python3 symlink: electron-packager rewrites a relative symlink into an absolute one
// pointing at its staging folder, which is gone by the time the app runs. The runtime ships no symlinks.
export const PYTHON_REL = path.join("python", "bin", "python3.12");
export const MODEL_REL = "model";
/** Bump when trimRuntime or the staging recipe changes, so the cached runtime is rebuilt. */
const RECIPE = 7;

export function cacheRoot(repoRoot, env = process.env) {
  return env.SYNAPSE_BUILD_CACHE ? path.resolve(env.SYNAPSE_BUILD_CACHE) : path.join(repoRoot, ".build-cache");
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** The cache key for a built runtime: the locks, the recipe, and nothing else. */
export function runtimeKey(lockText, reqsText) {
  return crypto.createHash("sha256").update(`${RECIPE}\0${lockText}\0${reqsText}`).digest("hex").slice(0, 16);
}

/** Download `url` to `dest` unless a copy with the right hash is already there. curl: redirects, retries, resumable. */
export function fetchVerified(url, dest, sha256, log = console.log) {
  if (fs.existsSync(dest) && sha256File(dest) === sha256) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  log(`kokoro-runtime: downloading ${url}`);
  execFileSync("curl", ["-fL", "--retry", "3", "--retry-delay", "2", "-C", "-", "-sS", "-o", part, url], { stdio: ["ignore", "inherit", "inherit"] });
  const got = sha256File(part);
  if (got !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`kokoro-runtime: ${path.basename(dest)} has sha256 ${got}, the lock says ${sha256}`);
  }
  fs.renameSync(part, dest);
  return dest;
}

/**
 * What the sidecar never uses, removed from the runtime (≈90 MB): pip, the IDE/Tk/test stdlib, every
 * console script (their shebangs point at the build machine), headers, tests, and the non-English
 * language data of espeak-ng, Babel and misaki. English G2P, spaCy's en model and espeak's English
 * fallback all stay: the self-test below speaks through every one of them.
 */
export function trimRuntime(py) {
  const lib = path.join(py, "lib", "python3.12");
  const sp = path.join(lib, "site-packages");
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
  for (const d of ["idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "test", "pydoc_data", "unittest/test", "__phello__"]) rm(path.join(lib, d));
  for (const f of fs.readdirSync(path.join(lib, "lib-dynload"))) if (/^_tkinter\./.test(f)) rm(path.join(lib, "lib-dynload", f));
  for (const f of fs.readdirSync(path.join(py, "lib"))) if (/^(tcl|tk|itcl|thread)\d|^lib(tcl|tk)/.test(f)) rm(path.join(py, "lib", f));
  rm(path.join(py, "include"));
  rm(path.join(py, "share"));
  for (const f of fs.readdirSync(path.join(py, "bin"))) if (f !== "python3.12") rm(path.join(py, "bin", f));
  rm(path.join(py, "lib", "pkgconfig"));
  for (const f of fs.readdirSync(sp)) if (/^(pip|setuptools|_distutils_hack|distutils-precedence\.pth)/.test(f)) rm(path.join(sp, f));
  rm(path.join(sp, "mlx", "include"));
  rm(path.join(sp, "mlx", "share"));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (e.name === "tests" || e.name === "__pycache__") rm(p); else walk(p);
    }
  };
  walk(sp);
  walk(lib);
  const espeak = path.join(sp, "espeakng_loader", "espeak-ng-data");
  for (const f of fs.readdirSync(espeak)) if (/_dict$/.test(f) && f !== "en_dict") rm(path.join(espeak, f));
  const babel = path.join(sp, "babel", "locale-data");
  for (const f of fs.readdirSync(babel)) if (!/^(root|en|en_US|en_GB)\.dat$/.test(f)) rm(path.join(babel, f));
  const misaki = path.join(sp, "misaki", "data");
  for (const f of fs.readdirSync(misaki)) if (!/^((us|gb)_(gold|silver)\.json|__init__\.py)$/.test(f)) rm(path.join(misaki, f));
}

/** The model at its pinned revision, every file hash-checked, config patched exactly like the reference setup's. */
function stageModel(lock, cache, dest, log) {
  const m = lock.model;
  const dir = path.join(cache, "models", `${m.repo.replace("/", "--")}-${m.revision}`);
  for (const [rel, sha] of Object.entries(m.files)) {
    fetchVerified(`https://huggingface.co/${m.repo}/resolve/${m.revision}/${rel}`, path.join(dir, rel), sha, log);
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), path.join(dest, rel));
  }
  const cfg = path.join(dest, "config.json");
  fs.writeFileSync(cfg, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), ...m.configPatch }, null, 2)}\n`);
}

function build(repoRoot, out, log) {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const cache = cacheRoot(repoRoot);
  const tarball = fetchVerified(lock.python.url, path.join(cache, "downloads", decodeURIComponent(path.basename(lock.python.url))), lock.python.sha256, log);
  fs.mkdirSync(out, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", out]);
  const py = path.join(out, "python");
  const python = path.join(py, "bin", "python3");
  const wheels = path.join(cache, "wheels");
  // --isolated + no config file + a clean env: the builder's pip.conf, PIP_* variables or index can't change what installs.
  const pipEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: out, TMPDIR: process.env.TMPDIR ?? "/tmp", PIP_CONFIG_FILE: "/dev/null" };
  const pip = (args) => execFileSync("/usr/bin/arch", ["-arm64", python, "-s", "-E", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-cache-dir", ...args], { stdio: ["ignore", "ignore", "inherit"], env: pipEnv });
  log("kokoro-runtime: fetching the pinned wheels (cached after the first run)");
  pip(["download", "--require-hashes", "--no-deps", "--only-binary=:all:", "-d", wheels, "-r", REQS]);
  log("kokoro-runtime: installing into the runtime's own site-packages");
  pip(["install", "--require-hashes", "--no-deps", "--no-index", "--find-links", wheels, "--only-binary=:all:", "--no-compile", "-r", REQS]);
  trimRuntime(py);
  // Every bundled Python package with the licence its own metadata declares (THIRD-PARTY-NOTICES points here).
  const licences = execFileSync("/usr/bin/arch", ["-arm64", path.join(out, PYTHON_REL), "-s", "-E", "-B", "-c", [
    "import importlib.metadata as m",
    "rows = []",
    "for d in m.distributions():",
    "    md = d.metadata",
    "    lic = md.get('License-Expression') or md.get('License') or ''",
    "    lic = lic if lic and len(lic) < 80 else ''",
    "    if not lic:",
    "        cl = [c.split('::')[-1].strip() for c in (md.get_all('Classifier') or []) if c.startswith('License ::')]",
    "        lic = ', '.join(cl) or 'see the package'",
    "    rows.append('%s %s — %s' % (md['Name'], md['Version'], lic))",
    "print('\\n'.join(sorted(rows, key=str.lower)))",
  ].join("\n")], { encoding: "utf8" });
  fs.writeFileSync(path.join(out, "LICENSES.txt"), `Python ${lock.python.version} (python-build-standalone ${lock.python.build}) — PSF-2.0\n${lock.model.repo} — Apache-2.0\n\n${licences}`);
  stageModel(lock, cache, path.join(out, MODEL_REL), log);
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify({
    python: lock.python.version, pythonBuild: lock.python.build, model: `${lock.model.repo}@${lock.model.revision}`,
    key: runtimeKey(fs.readFileSync(LOCK, "utf8"), fs.readFileSync(REQS, "utf8")),
  }, null, 2)}\n`);
}

/**
 * Fix round 1: every file of a built runtime — path, size and sha256 — as one hash. Sealed in .complete when the
 * runtime is built, and checked before every reuse: a cached runtime anything touched is rebuilt, never shipped.
 */
export function treeHash(dir) {
  const h = crypto.createHash("sha256");
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() || d.isSymbolicLink())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)))
    .filter((rel) => rel !== ".complete")
    .sort();
  for (const rel of files) {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    h.update(`${rel}\0${st.isSymbolicLink() ? "link:" + fs.readlinkSync(p) : `${st.size}:${sha256File(p)}`}\n`);
  }
  return h.digest("hex");
}

export function sealCachedRuntime(dir) {
  fs.writeFileSync(path.join(dir, ".complete"), `${JSON.stringify({ tree: treeHash(dir), sealedAt: new Date().toISOString() })}\n`);
}

export function cachedRuntimeIntact(dir) {
  try {
    const seal = JSON.parse(fs.readFileSync(path.join(dir, ".complete"), "utf8"));
    return typeof seal.tree === "string" && seal.tree === treeHash(dir);
  } catch {
    return false;
  }
}

/** Every symlink under `dir` (relative paths). electron-packager rewrites them to absolute staging paths. */
export function symlinksUnder(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isSymbolicLink())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)));
}

/** The import test the app runs (kokoro.ts PROBE), without writing a byte into the runtime (-B). */
export function probeRuntime(kokoroDir) {
  execFileSync("/usr/bin/arch", ["-arm64", path.join(kokoroDir, PYTHON_REL), "-s", "-E", "-B", "-c",
    "import importlib.util as u, mlx.core; missing=[m for m in ('mlx_audio','misaki','spacy','numpy','en_core_web_sm','espeakng_loader') if u.find_spec(m) is None]; assert not missing, 'missing: ' + ', '.join(missing)"],
  { stdio: ["ignore", "ignore", "inherit"], timeout: 60_000 });
}

/** Build (or reuse from the cache) the runtime, then copy it to <destDir>/kokoro. */
export function stageKokoro(repoRoot, destDir, { log = console.log } = {}) {
  const key = runtimeKey(fs.readFileSync(LOCK, "utf8"), fs.readFileSync(REQS, "utf8"));
  const cache = cacheRoot(repoRoot);
  const built = path.join(cache, "kokoro", `runtime-${key}`);
  if (!cachedRuntimeIntact(built)) {
    if (fs.existsSync(built)) log(`kokoro-runtime: the cached runtime ${path.basename(built)} changed since it was built; rebuilding`);
    const tmp = `${built}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    build(repoRoot, tmp, log);
    const links = symlinksUnder(tmp);
    if (links.length) throw new Error(`kokoro-runtime: the runtime must hold no symlinks (the packager breaks them): ${links.join(", ")}`);
    probeRuntime(tmp);
    sealCachedRuntime(tmp);
    fs.rmSync(built, { recursive: true, force: true });
    fs.renameSync(tmp, built);
  } else log(`kokoro-runtime: reusing the cached runtime ${path.basename(built)}`);
  const dest = path.join(destDir, KOKORO_RESOURCE);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // cp -c: an APFS clone, so the ~600 MB copy costs no disk and no time.
  execFileSync("cp", ["-cR", built, dest]);
  fs.rmSync(path.join(dest, ".complete"), { force: true });
  return dest;
}

/**
 * Say `text` with the runtime at `kokoroDir` through the real sidecar (its --self-test) and write the
 * PCM to a 24 kHz mono WAV. Returns the RMS, so a caller can assert the take is not silent.
 */
export function speak(kokoroDir, out, text = "Hello from Synapse. This voice ships inside the app.", o = {}) {
  const server = o.server ?? SERVER;
  return new Promise((resolve, reject) => {
    const c = spawn("/usr/bin/arch", ["-arm64", path.join(kokoroDir, PYTHON_REL), "-s", "-E", "-B", server, "--model-dir", path.join(kokoroDir, MODEL_REL), "--self-test", text], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    const pcm = [];
    let err = "";
    c.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    c.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const hl = buf.readUInt16BE(4);
        const header = JSON.parse(buf.subarray(6, 6 + hl).toString("utf8"));
        if (header.type === "audio") pcm.push(Buffer.from(buf.subarray(6 + hl, 4 + n)));
        buf = buf.subarray(4 + n);
      }
    });
    c.on("error", reject);
    c.on("close", (code) => {
      const f32 = Buffer.concat(pcm);
      const samples = f32.length / 4;
      if (code !== 0 || !samples) return reject(new Error(`kokoro self-test failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" | ")}`));
      let sum = 0;
      const s16 = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) {
        const v = f32.readFloatLE(i * 4);
        sum += v * v;
        s16.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
      }
      const h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + s16.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(s16.length, 40);
      fs.writeFileSync(out, Buffer.concat([h, s16]));
      resolve({ rms: Math.sqrt(sum / samples), seconds: samples / 24000 });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, text] = process.argv.slice(2);
  try {
    if (cmd === "stage" && a) console.log(`staged ${stageKokoro(path.resolve(here, ".."), path.resolve(a))}`);
    else if (cmd === "speak" && a && b) {
      const r = await speak(path.resolve(a), path.resolve(b), text);
      console.log(`spoke ${r.seconds.toFixed(2)} s, rms ${r.rms.toFixed(4)} → ${b}`);
      if (r.rms < 0.005) process.exit(1);
    } else { console.error("usage: kokoro-runtime.mjs stage <destDir> | speak <kokoroDir> <out.wav> [text]"); process.exit(2); }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
