/**
 * The JavaScript packages Synapse ships, for app/build/THIRD-PARTY-NOTICES.txt (bug 283).
 *
 * Three sets, each the production-dependency closure read from the installed node_modules:
 *   app   the app's own dependencies (app/package.json), packed into app.asar;
 *   host  the host's dependencies that esbuild inlines into host.mjs (host/package.json minus EXTERNAL);
 *   box   the EXTERNAL ones, which box/deploy.sh installs from npm into the box next to host.mjs.
 * Workspace packages (@synapse/*) are ours and left out; optional platform packages are left out too.
 *
 *   node app/scripts/third-party.mjs          prints the generated list
 *   node app/scripts/third-party.mjs --write  rewrites it inside THIRD-PARTY-NOTICES.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const NOTICES = path.join(here, "..", "build", "THIRD-PARTY-NOTICES.txt");
const BEGIN = "# BEGIN GENERATED PACKAGE LIST (node app/scripts/third-party.mjs --write)";
const END = "# END GENERATED PACKAGE LIST";

/** host/build.mjs's EXTERNAL list, read from its source so there is one copy of it. */
export function hostExternals(repoRoot) {
  const src = fs.readFileSync(path.join(repoRoot, "host", "build.mjs"), "utf8");
  const m = /const EXTERNAL = \[([^\]]*)\]/.exec(src);
  if (!m) throw new Error("host/build.mjs: no EXTERNAL list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function findPackageJson(name, fromDir) {
  for (let d = fromDir; ; d = path.dirname(d)) {
    const p = path.join(d, "node_modules", name, "package.json");
    if (fs.existsSync(p)) return p;
    if (path.dirname(d) === d) return null;
  }
}

/** Bug 297: packages whose terms aren't an open-source licence, stated as they are. */
const TERMS = {
  "@anthropic-ai/claude-agent-sdk": "© Anthropic PBC; use is subject to Anthropic's Commercial Terms of Service (https://www.anthropic.com/legal/commercial-terms)",
};

function licenceOf(pkg) {
  if (pkg.name && Object.hasOwn(TERMS, pkg.name)) return TERMS[pkg.name];
  const l = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => x.type ?? x).join(" OR ") : null);
  if (typeof l === "object" && l) return l.type ?? "see the package";
  if (!l) return "see the package";
  return String(l).replace(/^SEE LICENSE IN (.+)$/i, "see the package's $1");
}

/** name -> licence, for the closure of `names` resolved from `fromDir`. */
function closure(names, fromDir) {
  const out = new Map();
  const queue = names.map((n) => [n, fromDir]);
  while (queue.length) {
    const [name, dir] = queue.shift();
    if (name.startsWith("@synapse/")) continue;
    const p = findPackageJson(name, dir);
    if (!p) throw new Error(`third-party: ${name} is not installed (npm install first)`);
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (out.has(pkg.name)) continue;
    out.set(pkg.name, licenceOf(pkg));
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, path.dirname(p)]);
  }
  return out;
}

export function bundledPackages(repoRoot) {
  const read = (ws) => JSON.parse(fs.readFileSync(path.join(repoRoot, ws, "package.json"), "utf8"));
  const external = hostExternals(repoRoot);
  const hostDeps = Object.keys(read("host").dependencies ?? {});
  return {
    app: closure(Object.keys(read("app").dependencies ?? {}), path.join(repoRoot, "app")),
    host: closure(hostDeps.filter((n) => !external.includes(n)), path.join(repoRoot, "host")),
    box: closure(hostDeps.filter((n) => external.includes(n)), path.join(repoRoot, "host")),
  };
}

const section = (title, m) =>
  [`${title} (${m.size})`, ...[...m].sort(([a], [b]) => a.localeCompare(b)).map(([n, l]) => `  ${n} — ${l}`)].join("\n");

/** The generated block, without its BEGIN/END lines. */
export function renderPackageList(pkgs) {
  return [
    section("JavaScript packages inside the app (app.asar)", pkgs.app),
    section("JavaScript packages inlined into the host (Resources/host/dist/host.mjs)", pkgs.host),
    section("JavaScript packages installed from npm into the box by box/deploy.sh (not in the app)", pkgs.box),
  ].join("\n\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(here, "..", "..");
  const list = renderPackageList(bundledPackages(repoRoot));
  if (process.argv.includes("--write")) {
    const text = fs.readFileSync(NOTICES, "utf8");
    const start = text.indexOf(BEGIN), end = text.indexOf(END);
    if (start < 0 || end < start) throw new Error(`${NOTICES}: no generated block`);
    fs.writeFileSync(NOTICES, `${text.slice(0, start)}${BEGIN}\n${list}${text.slice(end)}`);
    console.log(`third-party: wrote ${NOTICES}`);
  } else process.stdout.write(list);
}
