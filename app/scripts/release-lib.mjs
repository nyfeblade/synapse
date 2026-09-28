// npm run release, the testable half: the local release folder the app updates from
// (app/src/main/native/updater.ts reads latest.json there first), and the two refusals.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Release updates: every release artifact carries the real version (app/package.json, the one version source)
 * and the Synapse name (the bundle name; productName is Synapse too since bug 284). The updater looks for exactly
 * this zip name (updater.ts, releaseZipName).
 */
export function releaseArtifacts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`release: "${version}" isn't a plain version (x.y.z) in app/package.json.`);
  const base = `Synapse-${version}-arm64`;
  return { zip: `${base}.zip`, dmg: `${base}.dmg`, tag: `v${version}` };
}

/** The `designated => …` line of `codesign -d -r-` output. */
export function parseRequirement(text) {
  const m = /designated => (.+)/.exec(String(text));
  return m ? m[1].trim() : "";
}

/** Only a build signed with the stable "Synapse Local Signing" identity can be verified by the updater. */
export function assertSignedForUpdates(requirement) {
  if (!/certificate leaf = H"[0-9a-f]{40}"/i.test(requirement) || /^cdhash /.test(requirement)) {
    throw new Error('release: this build is signed ad hoc, so no installed Synapse could verify it. Package with the "Synapse Local Signing" identity (see docs/release.md).');
  }
}

/** The GitHub release feed must be the user's PRIVATE repository; nothing is ever published publicly. */
export function assertPrivateRepo(visibility) {
  if (String(visibility).trim().toUpperCase() !== "PRIVATE") throw new Error(`release: the GitHub repository isn't private (visibility: ${visibility || "unknown"}), so nothing was published.`);
}

const writeAtomic = (file, data) => {
  const part = `${file}.part`;
  fs.writeFileSync(part, data, { mode: 0o600 });
  fs.renameSync(part, file);
};

/**
 * Copies the zip, its checksum and its Ed25519 signature (`sig`, base64 over "zip|version|sha256"; release-sign.mjs),
 * then writes latest.json LAST, so the app never sees a manifest for a half-copied zip.
 */
export function writeLocalRelease({ zip, name, version, hostBuild, requirement, dir, sig, now = Date.now, keep = 3 }) {
  if (typeof sig !== "string" || !sig.trim()) throw new Error("release: the build isn't signed (no .sig), so it wasn't added to the release folder.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(zip);
  const dest = path.join(dir, base);
  fs.copyFileSync(zip, `${dest}.part`);
  fs.renameSync(`${dest}.part`, dest);
  const bytes = fs.readFileSync(dest);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  writeAtomic(`${dest}.sha256`, `${sha256}  ${base}\n`);
  writeAtomic(`${dest}.sig`, `${sig.trim()}\n`);
  const manifest = { name, version, zip: base, sha256, sig: sig.trim(), bytes: bytes.length, hostBuild: hostBuild ?? null, requirement, createdAt: now() };
  writeAtomic(path.join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const zips = fs.readdirSync(dir).filter((f) => /^[\w.-]+\.zip$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
  const byAge = zips.filter((z) => z.f !== base).sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1));
  for (const old of byAge.slice(Math.max(0, keep - 1))) {
    fs.rmSync(path.join(dir, old.f), { force: true });
    fs.rmSync(path.join(dir, `${old.f}.sha256`), { force: true });
    fs.rmSync(path.join(dir, `${old.f}.sig`), { force: true });
  }
  return manifest;
}
