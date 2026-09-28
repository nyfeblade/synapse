#!/usr/bin/env node
// npm run publish-release -- <owner/repo> [--public] [--dry-run]
// Release updates, one command: build + code-sign + zip (npm run package), Ed25519-sign the zip and fill the local
// release folder (release.mjs), make the DMG (dmg.mjs), then `gh release create v<version>` on <owner/repo> with
//   Synapse-<v>-arm64.zip, .zip.sha256, .zip.sig and Synapse-<v>-arm64.dmg, and the exact source archives of the
//   GPL-3.0 parts of the bundled voice (espeak-ng, phonemizer-fork: native/kokoro/gpl-sources.json), fetched from their
//   canonical URLs and checked against their pinned SHA-256 before the build starts.
// REFUSES unless the repo is PRIVATE (gh repo view), or --public is passed explicitly. The guard runs first,
// before anything is built. --dry-run runs the guard and the readiness checks and prints the plan; it builds
// and publishes nothing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGplSources, gplSources, gplSourcesDir } from "./gpl-sources.mjs";
import { releaseArtifacts } from "./release-lib.mjs";
import { assertKeyMatchesPinned } from "./release-sign.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(here, "..");
const USAGE = "usage: npm run publish-release -- <owner/repo> [--public] [--dry-run]";

export function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const unknown = [...flags].filter((f) => f !== "--public" && f !== "--dry-run");
  if (unknown.length) throw new Error(`publish-release: unknown option ${unknown.join(", ")}. ${USAGE}`);
  const rest = argv.filter((a) => !a.startsWith("--"));
  if (rest.length !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(rest[0]) || rest[0].split("/").some((p) => p === "." || p === "..")) {
    throw new Error(`publish-release: give the target GitHub repo as owner/repo. ${USAGE}`);
  }
  return { repo: rest[0], allowPublic: flags.has("--public"), dryRun: flags.has("--dry-run") };
}

/** The guard: PRIVATE passes; PUBLIC passes only with --public; anything else (internal, unknown) is refused. */
export function assertPublishTarget(visibility, { repo, allowPublic }) {
  const v = String(visibility ?? "").trim().toUpperCase();
  if (v === "PRIVATE") return v;
  if (v === "PUBLIC" && allowPublic) return v;
  if (v === "PUBLIC") throw new Error(`publish-release: ${repo} isn't private (it is PUBLIC), so nothing was built or published. Pass --public if you really mean to publish Synapse publicly.`);
  throw new Error(`publish-release: ${repo} isn't private (visibility: ${v || "unknown"}), so nothing was built or published.`);
}

const gh = (args, opts = {}) => spawnSync("gh", args, { encoding: "utf8", ...opts });

/** The repo's visibility through the guard; throws (nothing built or published) when it isn't allowed. */
export function checkedVisibility({ repo, allowPublic, gh: run = gh }) {
  const view = run(["repo", "view", repo, "--json", "visibility", "-q", ".visibility"]);
  if (view.status !== 0) throw new Error(`publish-release: gh couldn't read ${repo} (${(view.stderr || "").trim() || `exit ${view.status}`}), so nothing was published. Is gh logged in (gh auth status) and the name right?`);
  return assertPublishTarget(view.stdout, { repo, allowPublic });
}

/** The last step: the guard AGAIN (the repo may have changed during a ten-minute build), then gh release create. */
export function createRelease({ repo, allowPublic, createArgs, gh: run = gh }) {
  const visibility = checkedVisibility({ repo, allowPublic, gh: run });
  const r = run(createArgs, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`publish-release: gh release create failed (exit ${r.status}).`);
  return visibility;
}

/** What gets published: the four build artifacts from `dist`, then each GPL source archive from `sourcesDir`. */
export function releasePlan({ version, dist, sourcesDir, repo }) {
  const art = releaseArtifacts(version);
  const sources = gplSources();
  const assets = [
    ...[art.zip, `${art.zip}.sha256`, `${art.zip}.sig`, art.dmg].map((f) => path.join(dist, f)),
    ...sources.map((s) => path.join(sourcesDir, s.asset)),
  ];
  const notes = `Synapse ${version}\n\nThe source code of the GPL-3.0 components of the bundled voice is attached: ${sources.map((s) => `${s.name} ${s.version} (${s.asset})`).join(", ")}.`;
  const createArgs = ["release", "create", art.tag, ...assets, "--repo", repo, "--title", `Synapse ${version}`, "--notes", notes];
  return { art, assets, createArgs, sources };
}

function main(argv) {
  const { repo, allowPublic, dryRun } = parseArgs(argv);

  // 1. The guard, before anything else.
  const visibility = checkedVisibility({ repo, allowPublic });
  if (visibility === "PUBLIC") console.warn(`publish-release: ${repo} is PUBLIC and --public was passed: anyone will be able to download this build.`);

  const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  const sourcesDir = gplSourcesDir(repoRoot);
  const { art, assets, createArgs, sources } = releasePlan({ version: pkg.version, dist: path.join(here, "dist-release"), sourcesDir, repo });

  // 2. Readiness: the signing key matches the key the app embeds, HEAD is the bumped + tagged commit,
  //    and the release doesn't exist yet. All before a ten-minute build.
  const problems = [];
  try { assertKeyMatchesPinned(); } catch (e) { problems.push(e.message); }
  const git = (...a) => spawnSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });
  if (!git("tag", "--points-at", "HEAD").stdout.split("\n").includes(art.tag)) problems.push(`HEAD isn't tagged ${art.tag}. Run npm run release:bump first (or check out the tagged commit).`);
  if (git("status", "--porcelain", "--untracked-files=no").stdout.trim()) problems.push("There are uncommitted changes to tracked files; the build wouldn't match the tag.");
  if (gh(["release", "view", art.tag, "--repo", repo]).status === 0) problems.push(`${repo} already has a release ${art.tag}. Bump the version first.`);
  // Publishing to this code repo itself: gh wants the tag pushed first (it won't guess which commit it means).
  // A separate releases-only repo needs no push; gh makes the tag there.
  const origin = git("remote", "get-url", "origin").stdout.trim().replace(/\.git$/, "");
  if (origin && (origin.endsWith(`/${repo}`) || origin.endsWith(`:${repo}`)) && !git("ls-remote", "--tags", "origin", `refs/tags/${art.tag}`).stdout.trim()) {
    problems.push(`${art.tag} isn't on ${repo} yet. Push it first: git push origin HEAD ${art.tag}`);
  }

  if (dryRun) {
    console.log(`publish-release (dry run): ${repo} is ${visibility}; the guard passed. Nothing was built or published.`);
    console.log(problems.length ? `Not ready yet:\n  - ${problems.join("\n  - ")}` : "Ready.");
    const fetches = sources.map((s) => `  fetch ${s.url} → ${s.asset} (sha256 ${s.sha256.slice(0, 12)}…)`).join("\n");
    console.log(`Would run:\n${fetches}\n  npm run release        (package, sign ${art.zip}, local release folder)\n  node scripts/dmg.mjs   (${art.dmg})\n  gh ${createArgs.map((a) => (path.isAbsolute(a) ? path.basename(a) : a)).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    return;
  }
  if (problems.length) throw new Error(`publish-release: not ready, nothing was built or published:\n  - ${problems.join("\n  - ")}`);

  // 3. The GPL source archives, fetched and hash-checked before the ten-minute build, so a dead link or a changed
  //    archive stops the release before anything is built.
  fetchGplSources(sourcesDir);

  // 4. Build, sign, DMG, publish.
  execFileSync("npm", ["run", "release"], { cwd: here, stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "scripts", "dmg.mjs")], { cwd: here, stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "scripts", "release-sign.mjs"), "verify", assets[0]], { stdio: "inherit" });
  for (const f of assets) if (!fs.existsSync(f)) throw new Error(`publish-release: ${path.basename(f)} is missing after the build; nothing was published.`);
  createRelease({ repo, allowPublic, createArgs });
  console.log(`publish-release: published ${art.tag} to ${repo} (${visibility}).`);
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
