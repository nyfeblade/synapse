#!/usr/bin/env node
// npm run release:bump [patch|minor|major]   (default patch)
// Release updates: app/package.json's "version" is the ONE version source (the packager puts it in the bundle's
// CFBundleShortVersionString, which app.getVersion() and the updater read; the artifacts are named from it).
// This bumps it (and the lockfile's copy), commits "release: vX.Y.Z" and makes the annotated tag vX.Y.Z.
// Local only: nothing is pushed. Refuses with uncommitted changes to tracked files, or when the tag exists.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function bumpVersion(v, kind = "patch") {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`release:bump: "${v}" isn't a plain version (x.y.z).`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "major") return `${maj + 1}.0.0`;
  throw new Error(`release:bump: say patch, minor or major (got "${kind}").`);
}

function main(argv) {
  const kind = argv[0] ?? "patch";
  const git = (...a) => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("release:bump: there are uncommitted changes to tracked files. Commit or set them aside first.");
  const pkgFile = path.join(repoRoot, "app", "package.json");
  const pkgText = fs.readFileSync(pkgFile, "utf8");
  const current = JSON.parse(pkgText).version;
  const next = bumpVersion(current, kind);
  const tag = `v${next}`;
  if (git("tag", "--list", tag)) throw new Error(`release:bump: the tag ${tag} already exists.`);
  // Only the version line changes, so the file's formatting stays as it is.
  const updated = pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
  if (JSON.parse(updated).version !== next) throw new Error("release:bump: couldn't update app/package.json's version.");
  fs.writeFileSync(pkgFile, updated);
  const files = ["app/package.json"];
  const lockFile = path.join(repoRoot, "package-lock.json");
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (lock.packages?.app) {
      lock.packages.app.version = next;
      fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
      files.push("package-lock.json");
    }
  }
  git("add", "--", ...files);
  git("commit", "-q", "-m", `release: ${tag}`, "--", ...files);
  git("tag", "-a", tag, "-m", `Synapse ${next}`);
  console.log(`release:bump: ${current} → ${next}; committed and tagged ${tag} (local only, nothing pushed).`);
  console.log("Next: npm run publish-release -- <owner/repo>   (or npm run release for the local release folder only)");
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
