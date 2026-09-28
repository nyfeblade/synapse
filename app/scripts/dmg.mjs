#!/usr/bin/env node
// Portable install: `npm run dmg` — Synapse-<version>-arm64.dmg for another Mac. Runs after `npm run package` (which builds,
// bundles the Kokoro runtime, signs and verifies Synapse.app):
//   1. refuses an ad-hoc app (an ad-hoc build loses every macOS permission and can't update an install),
//      unless SYNAPSE_ADHOC_SIGN=1 says a throwaway build is fine;
//   2. stages Synapse.app beside an /Applications symlink, so the window is "drag Synapse to Applications";
//   3. hdiutil create -format UDZO, then verify;
//   4. signs the DMG with the same "Synapse Local Signing" identity (5 s probe first: a keychain prompt fails fast);
//   5. prints its size.
// Nothing is uploaded or published: the DMG lands in app/dist-release/Synapse-<version>-arm64.dmg.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSignedForUpdates, parseRequirement, releaseArtifacts } from "./release-lib.mjs";
import { preflightSigning } from "./sign-app.mjs";
import { IDENTITY_NAME, findIdentity } from "./signing-identity.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

/** The staging folder's layout: the app and a link to /Applications, nothing else. */
export function stageDmg(app, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // ditto keeps the signature, the symlinks inside the frameworks and the extended attributes intact.
  execFileSync("ditto", [app, path.join(dir, path.basename(app))]);
  fs.symlinkSync("/Applications", path.join(dir, "Applications"));
  return dir;
}

export function hdiutilCreateArgs(o) {
  return ["create", "-volname", o.volname, "-srcfolder", o.src, "-fs", "HFS+", "-format", "UDZO", "-imagekey", "zlib-level=9", "-ov", o.out];
}

function sizeOf(file) {
  const b = fs.statSync(file).size;
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;
}

function main() {
  const app = path.join(here, "dist-release", "Synapse-darwin-arm64", "Synapse.app");
  if (!fs.existsSync(app)) throw new Error(`dmg: ${path.relative(here, app)} is missing; run npm run package first.`);
  const adhocOk = process.env.SYNAPSE_ADHOC_SIGN === "1";
  const shown = spawnSync("codesign", ["-d", "-r-", app], { encoding: "utf8", timeout: 5_000 });
  const requirement = parseRequirement(`${shown.stdout}\n${shown.stderr}`);
  let adhoc = false;
  try { assertSignedForUpdates(requirement); } catch { adhoc = true; }
  if (adhoc && !adhocOk) throw new Error(`dmg: Synapse.app is signed ad hoc. An installed Synapse keeps its permissions and accepts updates only from "${IDENTITY_NAME}". Package on the Mac that has it (or SYNAPSE_ADHOC_SIGN=1 for a throwaway DMG).`);
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8", timeout: 120_000 });
  if (verify.status !== 0) throw new Error(`dmg: Synapse.app's signature doesn't verify: ${verify.stderr.trim()}`);

  const out = path.join(here, "dist-release", releaseArtifacts(pkg.version).dmg);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-dmg-"));
  try {
    stageDmg(app, stage);
    fs.rmSync(out, { force: true });
    const t0 = Date.now();
    execFileSync("hdiutil", hdiutilCreateArgs({ volname: "Synapse", src: stage, out }), { stdio: "inherit" });
    execFileSync("hdiutil", ["verify", out], { stdio: ["ignore", "ignore", "inherit"] });
    console.log(`dmg: created and verified in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  if (!adhoc) {
    const identity = findIdentity();
    if (!identity) throw new Error(`dmg: the "${IDENTITY_NAME}" identity is gone from this keychain; the DMG is unsigned.`);
    preflightSigning(identity);
    execFileSync("codesign", ["--force", "-s", identity, "--timestamp=none", out], { stdio: "inherit", timeout: 60_000 });
    execFileSync("codesign", ["--verify", out], { stdio: "inherit", timeout: 60_000 });
    console.log(`dmg: signed with "${IDENTITY_NAME}"`);
  }
  console.log(`dmg: ${out} — ${sizeOf(out)} (Synapse.app inside: ${execFileSync("du", ["-sh", app], { encoding: "utf8" }).split("\t")[0]})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
