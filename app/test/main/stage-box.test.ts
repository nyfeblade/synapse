import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(__dirname, "../../..");
const stageScript = path.resolve(__dirname, "../../scripts/stage-box.mjs");

function fakeRepo(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-repo-"));
  execFileSync("cp", ["-R", path.join(repo, "box"), path.join(r, "box")]);
  fs.writeFileSync(path.join(r, "box", "._provision.sh"), "appledouble");
  fs.writeFileSync(path.join(r, "box", "route.env.local"), "private");
  fs.mkdirSync(path.join(r, "host", "dist", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(r, "host", "dist", "host.mjs"), "console.log('host')\n");
  fs.writeFileSync(path.join(r, "host", "dist", "package.json"), "{}\n");
  fs.writeFileSync(path.join(r, "host", "dist", "prompts", "base.md"), "hi\n");
  return r;
}

// Controller ruling (2026-09-19): Synapse.app carries box/ plus the built host, so Settings → Update box works
// from the installed app with no repo and no npm.
describe("stage-box.mjs (what package.mjs hands packager as extraResource)", () => {
  it("copies box/ (no AppleDouble, no route.env.local) and adds the prebuilt host tarball", () => {
    const r = fakeRepo();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-out-"));
    const res = spawnSync(process.execPath, [stageScript, r, out], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    const box = path.join(out, "box");
    for (const f of ["provision.sh", "provision-from-mac.sh", "deploy.sh", "check-gateway.sh", "orb.sh", "desktop.env", "route.env", "files/bothost.service", "host-dist.tgz"]) {
      expect(fs.existsSync(path.join(box, f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(box, "._provision.sh"))).toBe(false);
    expect(fs.existsSync(path.join(box, "route.env.local"))).toBe(false);
    const listing = execFileSync("tar", ["-tzf", path.join(box, "host-dist.tgz")], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(listing).toEqual(expect.arrayContaining(["./host.mjs", "./package.json", "./prompts/base.md"]));
    expect(listing.some((l) => path.basename(l).startsWith("._"))).toBe(false);
  });

  // Portable install: only what the installed app runs ships — the dev spikes, test runner and token helper stay in the repo.
  it("ships an allowlist: the scripts the app runs, never the dev ones", () => {
    const r = fakeRepo();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-out-"));
    expect(spawnSync(process.execPath, [stageScript, r, out]).status).toBe(0);
    const top = fs.readdirSync(path.join(out, "box")).sort();
    expect(top).toEqual(["check-gateway.sh", "deploy.sh", "desktop.env", "files", "host-dist.tgz", "image-prep.sh", "orb.sh", "provision-from-mac.sh", "provision.sh", "route.env", "verify-box.sh"]);
  });

  it("fails loudly when the host was not built", () => {
    const r = fakeRepo();
    fs.rmSync(path.join(r, "host", "dist"), { recursive: true });
    const res = spawnSync(process.execPath, [stageScript, r, fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-out-"))], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/host\/dist/);
  });

  it("the bundled deploy.sh streams the prebuilt tarball without npm or the repo", () => {
    const r = fakeRepo();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-out-"));
    expect(spawnSync(process.execPath, [stageScript, r, out]).status).toBe(0);
    fs.rmSync(r, { recursive: true }); // no repo anywhere
    const box = path.join(out, "box");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "stagebox-bin-"));
    const log = path.join(bin, "log");
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho "node $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    // Like curl: a config on stdin (-K -, how check-gateway.sh passes the token) is read.
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\ncase "$*" in *"-K -"*) cat >/dev/null;; esac\ncase "$*" in *http_code*) echo 403;; *) echo '{"ok":true}';; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "orb"), [
      "#!/bin/sh", `echo "orb $*" >> "${log}"`,
      `case "$*" in *gateway.json*) echo '{"port":47800,"token":"t"}'; exit 0;; esac`,
      `n=$(ls "${bin}"/stdin.* 2>/dev/null | wc -l | tr -d ' '); cat > "${bin}/stdin.$n"`, "",
    ].join("\n"), { mode: 0o755 });
    const res = spawnSync("bash", [path.join(box, "deploy.sh")], {
      encoding: "utf8", cwd: os.tmpdir(), env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: os.tmpdir(), ORB: path.join(bin, "orb") },
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const calls = fs.readFileSync(log, "utf8");
    expect(calls).not.toMatch(/^npm|^node/m);
    expect(calls).toContain("orb -m box -u root systemctl restart bothost");
    expect(fs.readFileSync(path.join(bin, "stdin.0")).equals(fs.readFileSync(path.join(box, "host-dist.tgz")))).toBe(true);
    expect(res.stdout).toContain("PASS gateway /health");
  });
});
