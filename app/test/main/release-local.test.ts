import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateRepo, assertSignedForUpdates, parseRequirement, releaseArtifacts, writeLocalRelease } from "../../scripts/release-lib.mjs";

const REQ = 'identifier "com.nyfeblade.synapse" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"';

describe("npm run release: the local release folder", () => {
  it("copies the zip and its checksum and writes latest.json last", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    const zip = path.join(d, "Synapse-0.3.0-arm64.zip");
    fs.writeFileSync(zip, "zip-bytes");
    const dir = path.join(d, "releases");
    const SIG = `${"A".repeat(86)}==`;
    const m = writeLocalRelease({ zip, name: "Synapse", version: "0.3.0", hostBuild: "0123456789abcdef", requirement: REQ, dir, sig: SIG, now: () => 7 });
    const sha = crypto.createHash("sha256").update("zip-bytes").digest("hex");
    expect(m).toEqual({ name: "Synapse", version: "0.3.0", zip: "Synapse-0.3.0-arm64.zip", sha256: sha, sig: SIG, bytes: 9, hostBuild: "0123456789abcdef", requirement: REQ, createdAt: 7 });
    // Release updates: the signature sits next to the zip and in latest.json.
    expect(fs.readFileSync(path.join(dir, "Synapse-0.3.0-arm64.zip.sig"), "utf8")).toBe(`${SIG}\n`);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"))).toEqual(m);
    expect(fs.readFileSync(path.join(dir, "Synapse-0.3.0-arm64.zip.sha256"), "utf8")).toBe(`${sha}  Synapse-0.3.0-arm64.zip\n`);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("keeps the newest three builds", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
    const dir = path.join(d, "releases");
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      const zip = path.join(d, `Synapse-${v}-arm64.zip`);
      fs.writeFileSync(zip, v);
      writeLocalRelease({ zip, name: "Synapse", version: v, hostBuild: null, requirement: REQ, dir, sig: "c2ln" });
    }
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".zip")).sort()).toEqual(["Synapse-0.2.0-arm64.zip", "Synapse-0.3.0-arm64.zip", "Synapse-0.4.0-arm64.zip"]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".sig")).sort()).toEqual(["Synapse-0.2.0-arm64.zip.sig", "Synapse-0.3.0-arm64.zip.sig", "Synapse-0.4.0-arm64.zip.sig"]);
  });

  it("refuses an ad-hoc build and a public GitHub repository", () => {
    expect(parseRequirement(`Executable=/x\ndesignated => ${REQ}\n`)).toBe(REQ);
    expect(() => assertSignedForUpdates(REQ)).not.toThrow();
    expect(() => assertSignedForUpdates('cdhash H"abc"')).toThrow(/ad hoc/);
    expect(() => assertPrivateRepo("PRIVATE")).not.toThrow();
    expect(() => assertPrivateRepo("PUBLIC")).toThrow(/private/);
    expect(() => assertPrivateRepo("")).toThrow(/private/);
  });
});

describe("release artifacts carry the real version and the Synapse name", () => {
  it("names the zip and the DMG Synapse-<version>-arm64", () => {
    expect(releaseArtifacts("1.4.2")).toEqual({ zip: "Synapse-1.4.2-arm64.zip", dmg: "Synapse-1.4.2-arm64.dmg", tag: "v1.4.2" });
    expect(() => releaseArtifacts("1.4")).toThrow(/version/);
  });

  it("package.mjs, dmg.mjs and release.mjs name artifacts from package.json's version, never productName (\"Bots\")", () => {
    const scripts = path.resolve(__dirname, "../../scripts");
    for (const f of ["package.mjs", "dmg.mjs", "release.mjs", "publish-release.mjs"]) {
      const src = fs.readFileSync(path.join(scripts, f), "utf8");
      expect(src, f).toContain("releaseArtifacts(");
      expect(src, f).not.toMatch(/productName\}-/);
      expect(src, f).not.toMatch(/"Synapse\.dmg"/);
    }
    // One version source: the packager takes CFBundleShortVersionString from package.json (no override).
    expect(fs.readFileSync(path.join(scripts, "package.mjs"), "utf8")).not.toMatch(/appVersion|buildVersion/);
  });
});
