import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRawHeader } from "@electron/asar";
import { packager } from "@electron/packager";
import { APP_BUNDLE_ID, extendInfo } from "./info-plist.mjs";
import { chooseSigningIdentity, signApp } from "./sign-app.mjs";
import { IDENTITY_NAME } from "./signing-identity.mjs";
import { stageBox } from "./stage-box.mjs";
import { asarEntriesFrom, builderPathLeaks, helperProblems, machOFiles, unsignedMachO, verifyBundle } from "./verify-bundle.mjs";
import { stageKokoro } from "./kokoro-runtime.mjs";
import { releaseArtifacts } from "./release-lib.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const out = path.join(here, "dist-release");
// The app is "Synapse" (Dock, Spotlight, Finder, productName; bug 284). An older install's data folder is
// moved from …/Bots on first launch (src/main/data-rename.ts), and bots:// still opens as an alias of
// synapse:// for one release (bug 286). Release artifacts are named Synapse-<version>-arm64
// (releaseArtifacts), from package.json's version — the one version source: the packager copies it into
// CFBundleShortVersionString, which app.getVersion() reads.
const bundleName = "Synapse";
// Settings → Update / Recover box runs box/ from inside the bundle (Contents/Resources/box), with the
// prebuilt host deploy.sh streams, so the installed app needs neither the repo nor npm.
const repoRoot = path.resolve(here, "..");
// PACKAGE_BUILD=1: no source maps and no dev-only eval bundles in the host that ships (host/build.mjs).
execFileSync("npm", ["run", "build", "-w", "@synapse/host"], { cwd: repoRoot, stdio: "inherit", env: { ...process.env, PACKAGE_BUILD: "1" } });
// secret-sync.ts loads libsodium-wrappers through a real runtime require (its ESM build is broken —
// see the comment there), so esbuild never inlines it and the package must physically ship. npm
// workspaces hoist it to the REPO root, which the packager (dir: app/) would not include, so vendor
// it into dist/node_modules — the first place Node's resolver looks when require() is called from
// dist/main.cjs. It must NOT go in app/node_modules: creating that directory makes the packager's
// dependency walker resolve the workspace's deps there instead of at the repo root, and packaging
// then fails on @synapse/shared.
const vendor = path.join(here, "dist", "node_modules");
for (const dep of ["libsodium-wrappers", "libsodium"]) {
  const from = path.join(repoRoot, "node_modules", dep);
  if (!fs.existsSync(from)) throw new Error(`package: ${dep} is not installed at the repo root`);
  fs.cpSync(from, path.join(vendor, dep), { recursive: true, dereference: true, force: true });
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-box-"));
const stagedBox = stageBox(repoRoot, stage);
// gateway-bootstrap.ts resolves the local host at <resourcesPath>/host/dist/host.mjs. Only box/
// used to ship (as host-dist.tgz, for the box to unpack), so the packaged app could never start a
// local host of its own — FUZZ=1 died with "The local host exited during start-up", which is why
// nothing could drive the shipped artefact. Ship host/dist as its own resource; verify-bundle.mjs
// asserts the path the code computes, so this cannot silently rot again.
const stagedHost = path.join(stage, "host");
fs.cpSync(path.join(repoRoot, "host", "dist"), path.join(stagedHost, "dist"), { recursive: true, dereference: true });
// host/secrets/crypto.ts require()s libsodium at runtime, the same way secret-sync.ts does, and
// Node only looks in node_modules beside the bundle it is running. Without this the local host
// exits during start-up with "Cannot find module 'libsodium-wrappers'".
for (const dep of ["libsodium-wrappers", "libsodium"]) {
  fs.cpSync(path.join(repoRoot, "node_modules", dep), path.join(stagedHost, "node_modules", dep), { recursive: true, dereference: true, force: true });
}
// Portable install: the Kokoro voice ships inside the app — a pinned Python runtime, its exact packages and
// the model (scripts/kokoro-runtime.mjs; built once, then reused from .build-cache) — and the licences of
// everything the app bundles.
const stagedKokoro = stageKokoro(repoRoot, stage);
const stagedNotices = path.join(stage, "THIRD-PARTY-NOTICES.txt");
fs.copyFileSync(path.join(here, "build", "THIRD-PARTY-NOTICES.txt"), stagedNotices);
// Apache-2.0 §4: every copy carries the licence and the NOTICE file (the repo root's, the only copies).
const stagedLicence = path.join(stage, "LICENSE");
const stagedNotice = path.join(stage, "NOTICE");
fs.copyFileSync(path.join(repoRoot, "LICENSE"), stagedLicence);
fs.copyFileSync(path.join(repoRoot, "NOTICE"), stagedNotice);
const SHIPPED_TOP = new Set(["dist", "node_modules", "package.json"]);
const [appDir] = await packager({
  dir: here, name: bundleName, platform: "darwin", arch: "arm64", out, overwrite: true, prune: true,
  icon: path.join(here, "build", "icon.icns"),
  extraResource: [stagedBox, stagedHost, stagedKokoro, stagedNotices, stagedLicence, stagedNotice],
  // A shipped *.map carries the whole TypeScript source; test-results/ and *.config.ts are build-time
  // only. verify-bundle.mjs fails the build if any of them get in anyway.
  // ALLOWLIST, not a denylist: only these top-level entries ship. The denylist needed a new entry for
  // every dev-only folder (walk/, then motion/) and failed the build each time one was added.
  ignore: (p) => {
    if (p === "") return false;
    const top = p.split("/")[1];
    if (!SHIPPED_TOP.has(top)) return true;
    return /\.map$/.test(p) || /^\/[\w.-]*\.config\.ts$/.test(p) || /(^|\/)node_modules\/\.vite(-temp)?(\/|$)/.test(p);
  },
  // Electron can only spawn() an executable living outside app.asar (the dictation helper needs a
  // real spawn, not execFile's temp-copy extraction, to keep its code signature and macOS
  // microphone/Speech TCC grant intact) — so the native helpers are unpacked next to the archive.
  asar: { unpack: "**/dist/native/**" },
  // Bug 99: the bundle id is the signing identifier (it was electron-packager's default
  // com.electron.synapse, while the signature said com.nyfeblade.synapse), and the Info.plist
  // carries both usage strings TCC needs for the dictation helper.
  appBundleId: APP_BUNDLE_ID,
  helperBundleId: `${APP_BUNDLE_ID}.helper`,
  extendInfo: extendInfo(bundleName),
});
const app = path.join(appDir, `${bundleName}.app`);
fs.rmSync(stage, { recursive: true, force: true });
// Every path the running code computes, asserted at the path the code computes it; every
// dist/native entry unpacked and executable; no source maps, test output or build configs in the
// archive. A runtime-required package that never made it in only shows up as "Cannot find module"
// on launch, and a path the code computes but the packager never shipped only shows up as a dead
// app — so both are decided here, at build time.
{
  const entries = asarEntriesFrom(getRawHeader(path.join(app, "Contents", "Resources", "app.asar")).header);
  const hostDir = path.join(app, "Contents", "Resources", "host");
  const resourceFiles = () => fs.readdirSync(hostDir, { recursive: true }).map((f) => path.join("Contents/Resources/host", String(f)));
  const problems = verifyBundle({ app, asarEntries: () => entries, resourceFiles });
  // The helpers run on the macOS the plist promises, and the dictation helper carries whisper.
  const native = path.join(app, "Contents", "Resources", "app.asar.unpacked", "dist", "native");
  problems.push(...helperProblems({
    helpers: [path.join(native, "bots-dictation"), path.join(native, "bots-mac")],
    showBuild: (h) => execFileSync("vtool", ["-show-build", h], { encoding: "utf8" }),
    dictation: path.join(native, "bots-dictation"),
    hasWhisper: (h) => fs.readFileSync(h).includes("whisper_init_from_file_with_params"),
  }));
  // Bug 295: nothing Synapse builds itself carries the build machine's home folder.
  problems.push(...builderPathLeaks([path.join(native, "bots-dictation"), path.join(native, "bots-mac"), path.join(hostDir, "dist", "host.mjs")]));
  if (problems.length) throw new Error(`package: the bundle is not shippable:\n  - ${problems.join("\n  - ")}`);
}
// Bug 99: sign with the stable local identity ("Synapse Local Signing", created once in the login
// keychain by scripts/signing-identity.mjs), so the designated requirement — and with it the
// Microphone / Speech Recognition grants and the keychain ACL — is the same for every build. Ad
// hoc (a bare cdhash, new every build) remains the fallback for CI or a Mac without the identity;
// src/main/keychain.ts namespaces its item by whichever identity this is.
{
  const { identity, adhoc } = chooseSigningIdentity();
  const t0 = Date.now();
  signApp(app, { identity, entitlements: path.join(here, "build", "entitlements.mac.plist") });
  // Portable install: every Mach-O in the bundle — the bundled Python and each of its extension modules,
  // espeak's dylib, MLX, the helpers — carries this identity's valid signature.
  const machO = machOFiles(path.join(app, "Contents", "Resources"));
  const unsigned = unsignedMachO(machO, {
    authority: IDENTITY_NAME, adhoc,
    verify: (f) => execFileSync("codesign", ["--verify", "--strict", f], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 }),
    describe: (f) => { const r = spawnSync("codesign", ["-dvv", f], { encoding: "utf8", timeout: 30_000 }); return `${r.stdout}${r.stderr}`; },
  });
  if (unsigned.length) throw new Error(`package: not every Mach-O is signed by "${IDENTITY_NAME}":\n  - ${unsigned.join("\n  - ")}`);
  console.log(`package: signed ${adhoc ? "ad hoc" : `with "${IDENTITY_NAME}" (${identity})`}; ${machO.length} Mach-O files in Resources verified (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const zip = path.join(out, releaseArtifacts(pkg.version).zip);
execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
fs.writeFileSync(`${zip}.sha256`, `${crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex")}  ${path.basename(zip)}\n`);
console.log(`packaged ${zip}`);
