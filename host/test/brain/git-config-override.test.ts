import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBotEnv, GIT_BUILTIN_DIFF } from "../../brain/spawn-options";
import { loadConfig } from "../../config";

/**
 * Ruling (2): a real git test. A repo's own .git/config sets core.pager and diff.external to programs
 * that would run on a plain `git status`/`git diff` (the fast path). The GIT_CONFIG_* overrides that
 * botEnv puts in the Bot env must win over the repo config, so those keys are neutralized.
 */
const cfg = loadConfig({});
const gitEnv = buildBotEnv({ cfg, botId: "b1" });
let dir: string;
let hasGit = true;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-gitcfg-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
  try {
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    // Malicious repo config: these would run on `git status`/`git diff`.
    run("config", "core.pager", "sh -c 'touch pwned-pager'");
    run("config", "diff.external", "sh -c 'touch pwned-external'");
    run("config", "core.fsmonitor", "sh -c 'touch pwned-fsmonitor'");
  } catch {
    hasGit = false;
  }
});

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe("git repo-config execution overrides (Ruling 2)", () => {
  it("the Bot env's GIT_CONFIG_* values win over the repo config", () => {
    if (!hasGit) return;
    const env = { ...process.env, ...gitEnv, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    const get = (key: string) =>
      execFileSync("git", ["config", "--get", key], { cwd: dir, env }).toString().trim();
    expect(get("core.pager")).toBe("cat");
    expect(get("diff.external"), "the host's own differ, never the repo's").toBe(GIT_BUILTIN_DIFF);
    expect(get("core.fsmonitor")).toBe("false");
    expect(get("core.hooksPath")).toBe("/dev/null");
    expect(get("core.sshCommand")).toBe("ssh");
  });

  it("git status/diff never run the repo-config pager or external differ", () => {
    if (!hasGit) return;
    const env = { ...process.env, ...gitEnv, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir, env });
    execFileSync("git", ["commit", "-qm", "c1"], { cwd: dir, env });
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    // status, --stat, log and a full patch all run cleanly, and never the attacker's command.
    execFileSync("git", ["-c", "color.ui=never", "status"], { cwd: dir, env });
    execFileSync("git", ["diff", "--stat"], { cwd: dir, env });
    execFileSync("git", ["log", "--oneline"], { cwd: dir, env });
    execFileSync("git", ["diff"], { cwd: dir, env, stdio: "ignore" });
    for (const marker of ["pwned-pager", "pwned-external", "pwned-fsmonitor"]) {
      expect(fs.existsSync(path.join(dir, marker)), marker).toBe(false);
    }
  });

  // 2026-09-21 coding bench: an empty diff.external made every plain `git diff` die ("cannot run :"), and the
  // Bot spent 4-5 model calls per task working around it. The pinned differ must print git's own patch.
  it("a plain git diff / git show prints the real patch, and still never runs the repo's differ", () => {
    if (!hasGit) return;
    const env = { ...process.env, ...gitEnv, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...a: string[]) => execFileSync("git", ["-c", "color.ui=never", ...a], { cwd: dir, env }).toString();
    fs.writeFileSync(path.join(dir, "b c.txt"), "keep\n");
    fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
    git("add", "-A");
    git("commit", "-qm", "c2");
    fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
    fs.writeFileSync(path.join(dir, "b c.txt"), "kept\n");
    fs.rmSync(path.join(dir, "gone.txt"));
    fs.writeFileSync(path.join(dir, "new.txt"), "hi\n");
    git("add", "new.txt");

    const work = git("diff");
    expect(work).toContain("diff --git a/a.txt b/a.txt\n");
    expect(work).toMatch(/--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -1 \+1 @@\n-two\n\+three\n/);
    expect(work).toMatch(/--- a\/b c\.txt\t\n\+\+\+ b\/b c\.txt\t\n@@ -1 \+1 @@\n-keep\n\+kept\n/);
    expect(work).toMatch(/--- a\/gone\.txt\n\+\+\+ \/dev\/null\n@@ -1 \+0,0 @@\n-bye\n/);
    expect(git("diff", "--cached")).toMatch(/--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+hi\n/);
    expect(git("show", "HEAD")).toMatch(/\+\+\+ b\/gone\.txt\n@@ -0,0 \+1 @@\n\+bye\n/);
    // The same lines git's built-in differ prints (headers and hunks; only the index line may differ).
    const strip = (s: string) => s.split("\n").filter((l) => !l.startsWith("index ")).join("\n");
    expect(strip(work)).toBe(strip(git("diff", "--no-ext-diff")));
    expect(fs.existsSync(path.join(dir, "pwned-external"))).toBe(false);
    git("reset", "-q", "--hard");
  });
});

/**
 * Security re-review item 1 (CRITICAL): a fast-path `git log -1 --format=%G?` (or log.showSignature=true in the
 * repo config) runs gpg.program / gpg.<format>.program to verify a commit's gpgsig header. The pins make those
 * inert, and pin log.showSignature and every pager.<cmd> the fast path reaches.
 */
describe("git signature-verification programs never run from repo config (re-review item 1)", () => {
  const SIGS: Record<string, string> = {
    openpgp: "-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEEfake\n=abcd\n-----END PGP SIGNATURE-----",
    x509: "-----BEGIN SIGNED MESSAGE-----\nMIIfake\n-----END SIGNED MESSAGE-----",
    ssh: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHfake\n-----END SSH SIGNATURE-----",
  };
  let repo: string;
  let ok = true;
  const markers: string[] = [];

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "bots-gpgsig-"));
    const plain = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo };
    const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: repo, env: plain, input }).toString().trim();
    try {
      git(["init", "-q"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
      git(["add", "a.txt"]);
      git(["commit", "-qm", "c0"]);
      const tree = git(["rev-parse", "HEAD^{tree}"]);
      let parent = git(["rev-parse", "HEAD"]);
      for (const [fmt, sig] of Object.entries(SIGS)) {
        const header = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1700000000 +0000\ncommitter t <t@example.com> 1700000000 +0000\ngpgsig ${sig.split("\n").join("\n ")}\n\nsigned ${fmt}\n`;
        parent = git(["hash-object", "-t", "commit", "-w", "--stdin"], header);
      }
      git(["update-ref", "refs/heads/signed", parent]);
      git(["checkout", "-q", "signed"]);
      for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program"]) {
        const m = path.join(repo, `pwned-${key}`);
        markers.push(m);
        const script = path.join(repo, `${key}.sh`);
        fs.writeFileSync(script, `#!/bin/sh\ntouch '${m}'\nexit 1\n`, { mode: 0o755 });
        git(["config", key, script]);
      }
      git(["config", "log.showSignature", "true"]);
      git(["config", "pager.log", `sh -c 'touch ${path.join(repo, "pwned-pager-log")}'`]);
      markers.push(path.join(repo, "pwned-pager-log"));
    } catch {
      ok = false;
    }
  });

  afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

  it("pins every gpg program, log.showSignature and the fast-path pagers", () => {
    const env = { ...process.env, ...gitEnv, HOME: repo, GIT_CONFIG_NOSYSTEM: "1" };
    const get = (key: string) => execFileSync("git", ["config", "--get", key], { cwd: repo, env }).toString().trim();
    if (!ok) return;
    for (const key of ["gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program"]) expect(get(key)).toBe("/bin/false");
    expect(get("log.showSignature")).toBe("false");
    for (const cmd of ["status", "log", "diff", "show", "branch"]) expect(get(`pager.${cmd}`)).toBe("false");
    expect(gitEnv.GIT_PAGER).toBe("cat");
  });

  it("git log --format=%G?, git log -1 and git show on signed commits run no repo-configured program", () => {
    if (!ok) return;
    const env = { ...process.env, ...gitEnv, HOME: repo, GIT_CONFIG_NOSYSTEM: "1" };
    for (const args of [["log", "-3", "--format=%G? %s"], ["log", "-1"], ["show", "--no-patch", "HEAD"], ["log", "-3", "--format=%GS %GK"]]) {
      try { execFileSync("git", args, { cwd: repo, env, stdio: "ignore" }); } catch { /* verification failing is fine */ }
    }
    for (const m of markers) expect(fs.existsSync(m), m).toBe(false);
  });

  it("without the pins the same repo DOES run them (the test is real)", () => {
    if (!ok) return;
    const env = { ...process.env, HOME: repo, GIT_CONFIG_NOSYSTEM: "1" };
    try { execFileSync("git", ["log", "-3", "--format=%G? %s"], { cwd: repo, env, stdio: "ignore" }); } catch { /* ignore */ }
    expect(fs.existsSync(path.join(repo, "pwned-gpg.program")) || fs.existsSync(path.join(repo, "pwned-gpg.openpgp.program"))).toBe(true);
    for (const m of markers) fs.rmSync(m, { force: true });
  });
});
