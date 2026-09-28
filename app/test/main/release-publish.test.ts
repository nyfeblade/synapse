import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scripts = path.resolve(__dirname, "../../scripts");
const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")).version as string;

describe("npm run release:bump", () => {
  it("bumps patch, minor and major", async () => {
    const m = (await import(path.join(scripts, "release-bump.mjs"))) as { bumpVersion(v: string, kind: string): string };
    expect(m.bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(m.bumpVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(m.bumpVersion("0.9.3", "major")).toBe("1.0.0");
    expect(() => m.bumpVersion("0.1.0", "huge")).toThrow(/patch, minor or major/);
    expect(() => m.bumpVersion("0.1", "patch")).toThrow(/version/);
  });

  /** A throwaway git repo shaped like this one: app/package.json, package-lock.json, the script. */
  function repo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bump-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    fs.mkdirSync(path.join(d, "app", "scripts"), { recursive: true });
    fs.copyFileSync(path.join(scripts, "release-bump.mjs"), path.join(d, "app", "scripts", "release-bump.mjs"));
    fs.writeFileSync(path.join(d, "app", "package.json"), `{\n  "name": "@synapse/app",\n  "productName": "Bots",\n  "version": "0.1.0",\n  "private": true\n}\n`);
    fs.writeFileSync(path.join(d, "package-lock.json"), `${JSON.stringify({ name: "bots", lockfileVersion: 3, packages: { "": { name: "bots" }, app: { name: "@synapse/app", version: "0.1.0" }, "node_modules/@synapse/app": { resolved: "app", link: true } } }, null, 2)}\n`);
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    const bump = (...a: string[]) => spawnSync(process.execPath, [path.join(d, "app", "scripts", "release-bump.mjs"), ...a], { encoding: "utf8", cwd: d, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    return { d, git, bump };
  }

  it("bumps app/package.json and the lockfile, commits, and tags v<version> locally", () => {
    const r = repo();
    const out = r.bump("minor");
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(r.d, "app", "package.json"), "utf8")).version).toBe("0.2.0");
    expect(fs.readFileSync(path.join(r.d, "app", "package.json"), "utf8")).toContain('  "productName": "Bots",\n  "version": "0.2.0",\n');
    expect(JSON.parse(fs.readFileSync(path.join(r.d, "package-lock.json"), "utf8")).packages.app.version).toBe("0.2.0");
    expect(r.git("tag", "--points-at", "HEAD").trim()).toBe("v0.2.0");
    expect(r.git("log", "-1", "--format=%s").trim()).toBe("release: v0.2.0");
    expect(r.git("status", "--porcelain", "--untracked-files=no").trim()).toBe("");
    expect(r.git("remote").trim()).toBe("");
  });

  it("defaults to patch", () => {
    const r = repo();
    expect(r.bump().status).toBe(0);
    expect(r.git("tag").trim()).toBe("v0.1.1");
  });

  it("refuses with uncommitted changes to tracked files, and when the tag already exists", () => {
    const r = repo();
    fs.appendFileSync(path.join(r.d, "package-lock.json"), "\n");
    const dirty = r.bump("patch");
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/uncommitted/);
    r.git("checkout", "--", "package-lock.json");
    r.git("tag", "v0.1.1");
    const dup = r.bump("patch");
    expect(dup.status).toBe(1);
    expect(dup.stderr).toMatch(/v0\.1\.1 already exists/);
    expect(JSON.parse(fs.readFileSync(path.join(r.d, "app", "package.json"), "utf8")).version).toBe("0.1.0");
  });
});

describe("npm run publish-release: the private-repo guard", () => {
  /** A fake `gh` and `npm` on PATH that log their argv; `gh repo view` answers FAKE_VISIBILITY. */
  function rig(visibility: string | null) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
    const bin = path.join(d, "bin");
    fs.mkdirSync(bin);
    const log = path.join(d, "calls.log");
    fs.writeFileSync(log, "");
    const w = (n: string, body: string) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "${n} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    w("gh", `case "$1 $2" in "repo view") ${visibility === null ? 'echo "GraphQL: Could not resolve to a Repository" >&2; exit 1' : `echo "${visibility}"; exit 0`};; esac\nexit 1`);
    w("npm", "exit 0");
    const run = (...a: string[]) => spawnSync(process.execPath, [path.join(scripts, "publish-release.mjs"), ...a], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYNAPSE_UPDATE_KEY: path.join(d, "no-such.key") },
    });
    const calls = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { run, calls };
  }
  const published = (calls: string[]) => calls.some((c) => /^gh release (create|upload)/.test(c));
  const built = (calls: string[]) => calls.some((c) => c.startsWith("npm "));

  it("needs owner/repo", () => {
    const r = rig("PRIVATE");
    for (const args of [[], ["--dry-run"], ["not a repo", "--dry-run"], ["https://github.com/o/r", "--dry-run"]]) {
      const out = r.run(...args);
      expect(out.status, args.join(" ")).toBe(1);
      expect(out.stderr).toMatch(/owner\/repo/);
    }
    expect(published(r.calls())).toBe(false);
  });

  it("REFUSES a public repo without --public, before building anything", () => {
    for (const args of [["o/r", "--dry-run"], ["o/r"]]) {
      const r = rig("PUBLIC");
      const out = r.run(...args);
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/isn't private/);
      expect(out.stderr).toMatch(/--public/);
      expect(published(r.calls())).toBe(false);
      expect(built(r.calls())).toBe(false);
    }
  });

  it("refuses an internal repo, and a repo gh can't see", () => {
    for (const vis of ["INTERNAL", null]) {
      const r = rig(vis);
      const out = r.run("o/r", "--dry-run");
      expect(out.status, String(vis)).toBe(1);
      expect(published(r.calls())).toBe(false);
    }
  });

  it("a private repo passes the guard; the dry run prints the plan and publishes nothing", () => {
    const r = rig("PRIVATE");
    const out = r.run("o/r", "--dry-run");
    expect(out.status, out.stderr).toBe(0);
    expect(r.calls()).toContain("gh repo view o/r --json visibility -q .visibility");
    for (const f of [`Synapse-${version}-arm64.zip`, `Synapse-${version}-arm64.zip.sha256`, `Synapse-${version}-arm64.zip.sig`, `Synapse-${version}-arm64.dmg`]) expect(out.stdout).toContain(f);
    // Owner decision 2026-09-26: the GPL sources ride along with every release.
    for (const f of ["espeak-ng-1.52.0.tar.gz", "phonemizer_fork-3.3.2.tar.gz"]) expect(out.stdout).toContain(f);
    expect(out.stdout).toMatch(/fetch[^\n]*https:\/\/github\.com\/espeak-ng\/espeak-ng\/archive\/refs\/tags\/1\.52\.0\.tar\.gz/);
    expect(out.stdout).toContain(`gh release create v${version}`);
    expect(out.stdout).toMatch(/dry run/i);
    expect(published(r.calls())).toBe(false);
    expect(built(r.calls())).toBe(false);
  });

  it("a public repo passes only with an explicit --public", () => {
    const r = rig("PUBLIC");
    const out = r.run("o/r", "--public", "--dry-run");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/PUBLIC/);
    expect(published(r.calls())).toBe(false);
  });

  it("a real run refuses before building when the signing key is missing", () => {
    const r = rig("PRIVATE");
    const out = r.run("o/r");
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/keygen/);
    expect(built(r.calls())).toBe(false);
    expect(published(r.calls())).toBe(false);
  });
});

describe("publish-release re-checks visibility right before gh release create", () => {
  type Gh = (args: string[]) => { status: number | null; stdout: string; stderr: string };
  async function load() {
    return (await import(path.join(scripts, "publish-release.mjs"))) as { createRelease(o: { repo: string; allowPublic: boolean; createArgs: string[]; gh: Gh }): string };
  }
  const recorder = (visibilities: string[]) => {
    const calls: string[][] = [];
    const gh: Gh = (args) => {
      calls.push(args);
      if (args[0] === "repo") return { status: 0, stdout: `${visibilities.shift() ?? ""}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { gh, calls };
  };
  const createArgs = ["release", "create", "v9.9.9", "a.zip", "--repo", "o/r"];

  it("a repo that turned public during the build is refused, and nothing is created", async () => {
    const { createRelease } = await load();
    const r = recorder(["PUBLIC"]);
    expect(() => createRelease({ repo: "o/r", allowPublic: false, createArgs, gh: r.gh })).toThrow(/isn't private/);
    expect(r.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["repo view"]);
  });

  it("still private: checks, then creates", async () => {
    const { createRelease } = await load();
    const r = recorder(["PRIVATE"]);
    expect(createRelease({ repo: "o/r", allowPublic: false, createArgs, gh: r.gh })).toBe("PRIVATE");
    expect(r.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["repo view", "release create"]);
  });

  it("main() goes through createRelease (the re-check), not a bare gh release create", () => {
    const src = fs.readFileSync(path.join(scripts, "publish-release.mjs"), "utf8");
    const main = src.slice(src.indexOf("function main("));
    expect(main).toContain("createRelease(");
    expect(main).not.toMatch(/gh\(createArgs/);
  });
});

// Owner decision 2026-09-26: every GitHub release carries the exact source archives of the GPL-3.0 parts of the bundled
// voice (espeak-ng, as espeakng-loader builds it, and phonemizer-fork), fetched at release time from their canonical
// URLs and checked against the SHA-256 pinned in app/native/kokoro/gpl-sources.json. Nothing here touches the network.
describe("the GPL source archives go out with every release", () => {
  type Source = { name: string; version: string; asset: string; url: string; sha256: string; bundledBy: string };
  const appDir = path.resolve(__dirname, "../..");
  async function load() {
    return (await import(path.join(scripts, "gpl-sources.mjs"))) as {
      gplSources(): Source[];
      fetchGplSources(dir: string, o?: { fetch?: (url: string, dest: string, sha: string) => string; log?: (l: string) => void }): string[];
    };
  }
  async function loadPublish() {
    return (await import(path.join(scripts, "publish-release.mjs"))) as {
      releasePlan(o: { version: string; dist: string; sourcesDir: string; repo: string }): { assets: string[]; createArgs: string[]; sources: Source[] };
    };
  }

  it("pins espeak-ng and phonemizer-fork at the versions the voice runtime installs, by SHA-256 and canonical URL", async () => {
    const { gplSources } = await load();
    const src = gplSources();
    expect(src.map((s) => s.name)).toEqual(["espeak-ng", "phonemizer-fork"]);
    const lock = fs.readFileSync(path.join(appDir, "native", "kokoro", "requirements.lock"), "utf8");
    for (const s of src) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(lock, s.bundledBy).toMatch(new RegExp(`^${s.bundledBy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"));
      expect(s.asset).toBe(path.basename(s.asset));
    }
    const [espeak, phon] = src;
    expect(espeak!.bundledBy).toBe("espeakng-loader==0.2.4");
    expect(espeak!.url).toBe("https://github.com/espeak-ng/espeak-ng/archive/refs/tags/1.52.0.tar.gz");
    expect(phon!.bundledBy).toBe("phonemizer-fork==3.3.2");
    expect(phon!.url).toMatch(/^https:\/\/files\.pythonhosted\.org\/packages\/.+\/phonemizer_fork-3\.3\.2\.tar\.gz$/);
  });

  it("fetches each archive through the hash-checked download, into the given folder", async () => {
    const { gplSources, fetchGplSources } = await load();
    const calls: string[][] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpl-"));
    const got = fetchGplSources(dir, { fetch: (url, dest, sha) => { calls.push([url, dest, sha]); return dest; }, log: () => {} });
    expect(calls).toEqual(gplSources().map((s) => [s.url, path.join(dir, s.asset), s.sha256]));
    expect(got).toEqual(gplSources().map((s) => path.join(dir, s.asset)));
  });

  it("an archive that doesn't match its pinned SHA-256 is refused and not kept (fake curl, no network)", async () => {
    const { fetchGplSources } = await load();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gpl-curl-"));
    const bin = path.join(d, "bin");
    fs.mkdirSync(bin);
    // curl ... -o <part> <url>: write something that is not the archive.
    fs.writeFileSync(path.join(bin, "curl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then echo tampered > "$2"; shift; fi; shift; done\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(() => fetchGplSources(path.join(d, "out"), { log: () => {} })).toThrow(/sha256/);
    } finally { process.env.PATH = oldPath; }
    expect(fs.readdirSync(path.join(d, "out"))).toEqual([]);
  });

  it("gh release create gets the zip, its checksum and signature, the DMG and both source archives", async () => {
    const { releasePlan } = await loadPublish();
    const p = releasePlan({ version: "9.9.9", dist: "/d", sourcesDir: "/s", repo: "o/r" });
    expect(p.assets).toEqual(["/d/Synapse-9.9.9-arm64.zip", "/d/Synapse-9.9.9-arm64.zip.sha256", "/d/Synapse-9.9.9-arm64.zip.sig", "/d/Synapse-9.9.9-arm64.dmg",
      "/s/espeak-ng-1.52.0.tar.gz", "/s/phonemizer_fork-3.3.2.tar.gz"]);
    expect(p.createArgs.slice(0, 3)).toEqual(["release", "create", "v9.9.9"]);
    for (const a of p.assets) expect(p.createArgs).toContain(a);
    expect(p.createArgs[p.createArgs.indexOf("--notes") + 1]).toMatch(/espeak-ng 1\.52\.0[^\n]*phonemizer-fork 3\.3\.2/);
  });

  it("main() fetches the sources before the build, and publishes the plan's assets", () => {
    const src = fs.readFileSync(path.join(scripts, "publish-release.mjs"), "utf8");
    const main = src.slice(src.indexOf("function main("));
    expect(main).toContain("releasePlan(");
    const fetchAt = main.indexOf("fetchGplSources(");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(main.indexOf('"run", "release"'));
    expect(fetchAt).toBeGreaterThan(main.indexOf("if (dryRun)"));
  });
});
