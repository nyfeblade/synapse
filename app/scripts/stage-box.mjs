// Stages what Synapse.app ships in Contents/Resources/box (packager extraResource):
// the repo's box/ (provision scripts, deploy.sh, files/, desktop.env, route.env, orb.sh) plus
// host-dist.tgz, the prebuilt host that the bundled deploy.sh streams into the box (no npm, no repo).
// Usage: node stage-box.mjs <repoRoot> <destDir>   → <destDir>/box
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = (name) => name.startsWith("._") || name === ".DS_Store" || name === "route.env.local" || name === "host-dist.tgz";
/**
 * Portable install: an ALLOWLIST of box/'s top level — what the installed app runs (first-run setup, box
 * updates, Settings → Update/Recover, verify after an update). The dev spikes, the test runner, the token
 * helper and the per-Bot-account migration scripts stay in the repo.
 */
export const SHIPPED_BOX = new Set(["check-gateway.sh", "deploy.sh", "desktop.env", "files", "orb.sh", "provision-from-mac.sh", "provision.sh", "route.env", "verify-box.sh"]);

export function stageBox(repoRoot, destDir) {
  const hostDist = path.join(repoRoot, "host", "dist");
  if (!fs.existsSync(path.join(hostDist, "host.mjs"))) throw new Error(`stage-box: ${hostDist} has no host.mjs; run npm run build -w @synapse/host first (host/dist)`);
  const box = path.join(destDir, "box");
  const src = path.join(repoRoot, "box");
  fs.rmSync(box, { recursive: true, force: true });
  fs.cpSync(src, box, {
    recursive: true,
    filter: (p) => {
      if (SKIP(path.basename(p))) return false;
      const rel = path.relative(src, p);
      return rel === "" || SHIPPED_BOX.has(rel.split(path.sep)[0]);
    },
  });
  execFileSync("tar", ["-C", hostDist, "-czf", path.join(box, "host-dist.tgz"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return box;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoRoot, destDir] = process.argv.slice(2);
  if (!repoRoot || !destDir) { console.error("usage: node stage-box.mjs <repoRoot> <destDir>"); process.exit(2); }
  try {
    console.log(`staged ${stageBox(path.resolve(repoRoot), path.resolve(destDir))}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
