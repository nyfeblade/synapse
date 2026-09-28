import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The SHIPPED artefact under dist-release — never the dev tree. The whole point of this suite is
 * that it runs what a user would double-click: `npm test` and `npm run e2e` both run the repo, and
 * that is exactly why a packaged-only defect (a keychain call that blocks before any window exists)
 * shipped with 3373 green tests behind it.
 */
export function findPackagedApp(root = path.join(appRoot, "dist-release")): string {
  const bundles = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name, "Synapse.app"))
        .filter((p) => fs.existsSync(p))
    : [];
  if (!bundles.length) {
    throw new Error(`no packaged Synapse.app under ${root} — run \`npm run package -w @synapse/app\` first`);
  }
  const app = bundles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!;
  const exe = path.join(app, "Contents", "MacOS", "Synapse");
  if (!fs.existsSync(exe)) throw new Error(`${app} has no Contents/MacOS/Synapse`);
  return exe;
}

export const bundleRoot = (exe: string): string => path.resolve(exe, "..", "..", "..");
