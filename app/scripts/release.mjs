// npm run release (after npm run package, which builds, signs and zips):
//   1. refuses an ad-hoc build: an installed Synapse only takes a build that satisfies its own
//      designated requirement (the "Synapse Local Signing" certificate, bug 99);
//   2. signs the zip with the Ed25519 update key (release-sign.mjs; the key file lives outside the repo)
//      and writes <zip>.sig and <zip>.sha256 beside it;
//   3. copies the zip, its checksum and signature into the local release folder and writes latest.json
//      (with the signature) there. The app's Settings → Updates checks this folder first.
// Publishing to GitHub is a separate step: npm run publish-release -- <owner/repo> (publish-release.mjs).
// RELEASE_DIR overrides the folder (default ~/Library/Application Support/Synapse/releases).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSignedForUpdates, parseRequirement, releaseArtifacts, writeLocalRelease } from "./release-lib.mjs";
import { signZip } from "./release-sign.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const zip = path.join(here, "dist-release", releaseArtifacts(pkg.version).zip);
const app = path.join(here, "dist-release", "Synapse-darwin-arm64", "Synapse.app");
if (!fs.existsSync(zip) || !fs.existsSync(app)) throw new Error(`release: ${path.relative(here, zip)} is missing; run npm run package first.`);

// Reading a signature never touches the signing key, so this can't raise a keychain prompt.
const shown = spawnSync("codesign", ["-d", "-r-", app], { encoding: "utf8", timeout: 5_000 });
const requirement = parseRequirement(`${shown.stdout}\n${shown.stderr}`);
assertSignedForUpdates(requirement);

const sig = signZip(zip);
console.log(`release: signed ${path.basename(zip)} (${path.basename(zip)}.sig)`);

let hostBuild = null;
try { hostBuild = fs.readFileSync(path.join(here, "..", "host", "dist", "build-id.txt"), "utf8").trim(); } catch { /* an old host build */ }
const dir = process.env.RELEASE_DIR || path.join(os.homedir(), "Library", "Application Support", "Synapse", "releases");
const m = writeLocalRelease({ zip, name: "Synapse", version: pkg.version, hostBuild, requirement, dir, sig });
console.log(`release: ${m.zip} (${m.version}) → ${dir}`);
