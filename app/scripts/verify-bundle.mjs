import fs from "node:fs";
import path from "node:path";

/**
 * The static half of "does the shipped bundle actually work".
 *
 * It used to be two greps of the asar header for two package names, which is why a bundle that
 * could not find its own host (defect 2) and a bundle shipping `main.cjs.map` — the entire
 * TypeScript source of the Mac side — both packaged without complaint. Everything here is a path
 * the RUNNING code computes, asserted at the path the code computes it.
 *
 * The other half is `e2e/packaged/packaged-smoke.e2e.ts`, which launches the artefact. Neither
 * replaces the other: nothing static can tell you the app draws a window.
 */

/** Every path the packaged app resolves at runtime, relative to the .app. */
export const RUNTIME_PATHS = [
  // box-lifecycle.ts defaultBoxDir() → path.join(resourcesPath, "box")
  "Contents/Resources/box/deploy.sh",
  "Contents/Resources/box/provision-from-mac.sh",
  "Contents/Resources/box/orb.sh",
  "Contents/Resources/box/route.env",
  "Contents/Resources/box/desktop.env",
  "Contents/Resources/box/files",
  "Contents/Resources/box/host-dist.tgz",
  // gateway-bootstrap.ts hostBundlePath() → path.join(resourcesPath, "host", "dist", "host.mjs")
  "Contents/Resources/host/dist/host.mjs",
  // host/secrets/crypto.ts require()s libsodium at runtime exactly like secret-sync.ts does, and
  // Node resolves that from <bundle>/Contents/Resources/host/node_modules — nowhere else. Without
  // it the local host exits during start-up with "Cannot find module 'libsodium-wrappers'".
  "Contents/Resources/host/node_modules/libsodium-wrappers/package.json",
  "Contents/Resources/host/node_modules/libsodium/package.json",
  // index.ts registerDictation() → resolveUnpacked(path.join(__dirname, "native", …))
  "Contents/Resources/app.asar.unpacked/dist/native/bots-dictation",
  "Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh",
  // index.ts registerKokoro() → resolveUnpacked(path.join(__dirname, "native", "kokoro_server.py")) (bug 107)
  "Contents/Resources/app.asar.unpacked/dist/native/kokoro_server.py",
  // index.ts scheduleVoiceSelfTest() → resolveUnpacked(path.join(__dirname, "native", "voice-selftest.wav")) (5.8)
  "Contents/Resources/app.asar.unpacked/dist/native/voice-selftest.wav",
  // index.ts registerF5() / registerQwen() → the same resolveUnpacked path (bugs 163, 164). F5's
  // was never copied into dist/native, so every build reported cloned voices as missing.
  "Contents/Resources/app.asar.unpacked/dist/native/f5_server.py",
  "Contents/Resources/app.asar.unpacked/dist/native/qwen_server.py",
  // index.ts registerMacApps() → resolveUnpacked(path.join(__dirname, "native", …)) (mac-apps, bug-log 151).
  // The helper must keep its own code signature, which is why it is spawn()ed from outside the archive:
  // its TCC grants (Accessibility, Automation) are bound to that signature.
  "Contents/Resources/app.asar.unpacked/dist/native/bots-mac",
  "Contents/Resources/app.asar.unpacked/dist/native/fake-macapp.sh",
  // Portable install: first-run setup runs these from the bundle (setup/box-steps.ts, setup/reprovision.ts),
  // and deploy.sh runs check-gateway.sh.
  "Contents/Resources/box/provision.sh",
  "Contents/Resources/box/check-gateway.sh",
  "Contents/Resources/box/verify-box.sh",
  // Portable install: kokoro.ts bundledKokoroDir() → <resourcesPath>/kokoro — the runtime, the model and
  // the voice every Bot falls back to (scripts/kokoro-runtime.mjs builds it).
  "Contents/Resources/kokoro/python/bin/python3.12",
  "Contents/Resources/kokoro/python/lib/libpython3.12.dylib",
  "Contents/Resources/kokoro/python/lib/python3.12/site-packages/mlx_audio",
  "Contents/Resources/kokoro/python/lib/python3.12/site-packages/en_core_web_sm",
  "Contents/Resources/kokoro/python/lib/python3.12/site-packages/espeakng_loader/espeak-ng-data/en_dict",
  "Contents/Resources/kokoro/model/config.json",
  "Contents/Resources/kokoro/model/kokoro-v1_0.safetensors",
  "Contents/Resources/kokoro/manifest.json",
  // The licences of what the app bundles.
  "Contents/Resources/THIRD-PARTY-NOTICES.txt",
  // Synapse's own licence and NOTICE (Apache-2.0 §4).
  "Contents/Resources/LICENSE",
  "Contents/Resources/NOTICE",
  // voice-packs.ts installs the optional packs from these pinned locks (next to the sidecars).
  "Contents/Resources/app.asar.unpacked/dist/native/qwen-requirements.lock",
  "Contents/Resources/app.asar.unpacked/dist/native/f5-requirements.lock",
  "Contents/Resources/app.asar.unpacked/dist/native/f5-requirements-sdist.lock",
];

/** Unpacked helpers are spawn()ed, so they have to be executable as well as present. */
export const EXECUTABLE_PATHS = RUNTIME_PATHS.filter((p) => (p.includes("app.asar.unpacked/dist/native/") && !p.endsWith(".lock") && !p.endsWith(".wav")) || p.endsWith("/bin/python3.12"));

/** Every voice the app offers by name (kokoro.ts KOKORO_VOICES) must ship in the bundled model. */
export const BUNDLED_VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_fenrir", "af_nicole", "am_puck", "bm_fable"];
/** The oldest macOS the app runs on (Info.plist LSMinimumSystemVersion; the helpers are built for it). */
export const MIN_MACOS = "14.0";

/** Packed into app.asar by esbuild/vite/the packager and no business being in a shipped bundle. */
const FORBIDDEN = [
  { re: /\.map$/, why: "source map" },
  { re: /(^|\/)test-results(\/|$)/, why: "test output" },
  { re: /(^|\/)[\w.-]*\.config\.ts$/, why: "build config" },
  { re: /(^|\/)node_modules\/\.vite/, why: "vitest cache" },
];

/** Required inside the archive: secret-sync.ts require()s these at runtime, so they must physically ship. */
export const REQUIRED_ASAR_PACKAGES = ["libsodium-wrappers", "libsodium"];

export function forbiddenAsarEntries(entries) {
  return entries.filter((e) => FORBIDDEN.some((f) => f.re.test(e.path))).map((e) => e.path);
}

/** dist/native/** must be unpacked: Electron cannot spawn() an executable inside app.asar. */
export function packedNativeEntries(entries) {
  return entries.filter((e) => /(^|\/)dist\/native\/.+/.test(e.path) && !e.unpacked).map((e) => e.path);
}

export function missingRuntimePaths(app, exists) {
  return RUNTIME_PATHS.filter((rel) => !exists(path.join(app, rel)));
}

/** Returns a list of human-readable problems; empty means the bundle is sound. */
export function verifyBundle(o) {
  const exists = o.exists ?? ((p) => fs.existsSync(p));
  const isExecutable = o.isExecutable ?? ((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  const entries = o.asarEntries();
  const problems = [];

  for (const rel of missingRuntimePaths(o.app, exists)) problems.push(`missing from the bundle: ${rel}`);
  for (const rel of EXECUTABLE_PATHS) {
    const p = path.join(o.app, rel);
    if (exists(p) && !isExecutable(p)) problems.push(`not executable: ${rel}`);
  }
  const packed = packedNativeEntries(entries);
  if (packed.length) problems.push(`dist/native must be unpacked, but app.asar packs: ${packed.join(", ")}`);
  for (const dep of REQUIRED_ASAR_PACKAGES) {
    if (!entries.some((e) => e.path.includes(`/node_modules/${dep}/`))) {
      problems.push(`app.asar is missing node_modules/${dep} — the app will crash on launch`);
    }
  }
  const forbidden = forbiddenAsarEntries(entries);
  if (forbidden.length) problems.push(`app.asar must not ship: ${forbidden.join(", ")}`);
  for (const v of BUNDLED_VOICES) {
    const rel = `Contents/Resources/kokoro/model/voices/${v}.safetensors`;
    if (!exists(path.join(o.app, rel))) problems.push(`missing from the bundle: ${rel}`);
  }
  // Source maps are the TypeScript source: none next to the local host either.
  for (const rel of (o.resourceFiles?.() ?? [])) if (/^Contents\/Resources\/host\/.*\.map$/.test(rel)) problems.push(`must not ship: ${rel}`);
  return problems;
}

// ---- the checks that need the real tools (package.mjs runs them on the built app; tests inject them) ----

const MACHO = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "feedface", "cefaedfe"]);
/** Every Mach-O file under `dir` (by magic number, not by name: python's .so files are Mach-O too). */
export function machOFiles(dir, o = {}) {
  const read = o.readMagic ?? ((f) => { const fd = fs.openSync(f, "r"); try { const b = Buffer.alloc(4); return fs.readSync(fd, b, 0, 4, 0) === 4 ? b.toString("hex") : ""; } finally { fs.closeSync(fd); } });
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && MACHO.has(read(p))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Every Mach-O in the bundle carries a valid signature by the expected identity (portable install: the
 * bundled Python and all its extension modules, the helpers). `describe(file)` returns codesign -dvv's
 * text; `verify(file)` throws when the signature doesn't hold.
 */
export function unsignedMachO(files, o) {
  const problems = [];
  for (const f of files) {
    try { o.verify(f); } catch (e) { problems.push(`${f}: signature does not verify (${String(e instanceof Error ? e.message : e).split("\n")[0]})`); continue; }
    const d = o.describe(f);
    if (o.adhoc) { if (!/Signature=adhoc/.test(d)) problems.push(`${f}: not ad hoc as expected`); continue; }
    if (!d.includes(`Authority=${o.authority}`)) problems.push(`${f}: signed by ${(/Authority=(.*)/.exec(d)?.[1]) ?? "no authority (ad hoc)"}, not ${o.authority}`);
  }
  return problems;
}

/** `vtool -show-build` text → the minos it records. */
export function parseMinos(text) {
  return /minos\s+([\d.]+)/.exec(String(text))?.[1] ?? null;
}

const vparts = (v) => v.split(".").map((n) => Number(n) || 0);
export function versionLE(a, b) {
  const [x, y] = [vparts(a), vparts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); }
  return true;
}

/** The helpers run on MIN_MACOS, and the dictation helper has whisper linked in (a package build requires it). */
export function helperProblems(o) {
  const problems = [];
  for (const h of o.helpers) {
    const minos = parseMinos(o.showBuild(h));
    if (!minos || !versionLE(minos, MIN_MACOS)) problems.push(`${path.basename(h)} needs macOS ${minos ?? "?"}; the app promises ${MIN_MACOS}`);
  }
  if (o.dictation && !o.hasWhisper(o.dictation)) problems.push("bots-dictation was built without whisper (app/native/whisper/install.sh --libs-only)");
  return problems;
}

/**
 * Bug 295: a file Synapse builds itself must not carry the builder's home folder: whisper.cpp's __FILE__ asserts put
 * `/Users/<builder>/<repo>/…` into bots-dictation, and a bundle built where node_modules links into another checkout
 * carries esbuild's module comments climbing out of the repo. Each file is read as bytes; returns one line per leak.
 */
const HOME_PATH = /\/Users\/[^/\s\0"'`]+\/[^\s\0"'`]*/;
const OUT_OF_REPO = /(?:\.\.\/){4,}[^\s\0"'`]*node_modules\/[^\s\0"'`]*/;
export function builderPathLeaks(files, read = (f) => fs.readFileSync(f)) {
  const problems = [];
  for (const f of files) {
    const text = read(f).toString("latin1");
    const m = HOME_PATH.exec(text) ?? OUT_OF_REPO.exec(text);
    if (m) problems.push(`${f}: carries a build machine's path (${m[0].slice(0, 120)})`);
  }
  return problems;
}

/** Flattens @electron/asar's header into `{ path, unpacked }` rows. */
export function asarEntriesFrom(header) {
  const rows = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = `${prefix}/${name}`;
      if (child.files) { rows.push({ path: p, unpacked: child.unpacked === true }); walk(child, p); }
      else rows.push({ path: p, unpacked: child.unpacked === true });
    }
  };
  walk(header, "");
  return rows;
}
