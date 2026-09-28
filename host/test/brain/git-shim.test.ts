import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureGitShim, gitShimDir, NAMED_EXEC_KEYS } from "../../brain/git-shim";
import { buildBotEnv, GIT_BUILTIN_DIFF, GIT_NEUTRAL_KEYS } from "../../brain/spawn-options";
import { tmpConfig } from "../helpers";

/**
 * Bug-log 121 (coordinator decision 2026-09-22): Bots trust shared /workspace repos another account owns, and
 * only there, because nothing in a repo's config can run a program in a Bot's git. Real git; "owned by another
 * account" is git's own test switch GIT_TEST_ASSUME_DIFFERENT_OWNER (the ownership check git runs on the box).
 */
const made: string[] = [];
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"]).toString().trim();

describe("the audit: every repo-config key that can run a program is pinned (fixed names) or neutralized per call (repo-chosen names)", () => {
  it("pins the full fixed-name list in every Bot env", () => {
    expect([...GIT_NEUTRAL_KEYS].sort()).toEqual([
      "core.alternateRefsCommand", "core.askPass", "core.editor", "core.fsmonitor", "core.gitProxy", "core.hooksPath", "core.pager", "core.sshCommand",
      "credential.helper", "diff.external", "gpg.openpgp.program", "gpg.program", "gpg.ssh.defaultKeyCommand", "gpg.ssh.program", "gpg.x509.program",
      "init.templateDir", "interactive.diffFilter", "log.showSignature", "pager.branch", "pager.diff", "pager.log", "pager.remote", "pager.show", "pager.status",
      "protocol.ext.allow", "sequence.editor", "uploadpack.packObjectsHook",
    ].sort());
  });

  it("neutralizes the full repo-named list per call", () => {
    expect(NAMED_EXEC_KEYS.map((r) => r.pattern)).toEqual([
      "filter.*.clean", "filter.*.smudge", "filter.*.process", "filter.*.required", "diff.*.textconv", "diff.*.command", "merge.*.driver",
      "remote.*.uploadpack", "remote.*.receivepack", "credential.helper", "credential.*.helper", "pager.*", "alias.*", "submodule.*.update",
      "difftool.*.cmd", "difftool.*.path", "mergetool.*.cmd", "mergetool.*.path", "man.*.cmd", "man.*.path", "browser.*.cmd", "browser.*.path",
      "tar.*.command", "sendemail.*", "gpg.*.program",
    ]);
  });

  it("puts the shim first on the PATH, which only the host writes", () => {
    const cfg = tmpConfig();
    made.push(path.dirname(cfg.workspace));
    const env = buildBotEnv({ cfg, botId: "b1" });
    expect(env.PATH!.split(":")[0]).toBe(gitShimDir(cfg));
    expect(env.PATH!.startsWith(path.join(cfg.ccManagedDir!, "git-bin") + ":")).toBe(true);
  });
});

function world() {
  const cfg = tmpConfig();
  made.push(path.dirname(cfg.workspace));
  const shim = ensureGitShim(cfg, GIT_BUILTIN_DIFF, REAL_GIT)!;
  expect(fs.statSync(shim).mode & 0o777).toBe(0o750);
  const pwn = path.join(path.dirname(cfg.workspace), "pwned");
  fs.mkdirSync(pwn);
  const evil = path.join(path.dirname(cfg.workspace), "evil.sh");
  fs.writeFileSync(evil, `#!/bin/sh\ntouch ${JSON.stringify(pwn)}/"$1"\ncat "$2" 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  const g = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  const makeRepo = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    g(dir, "init", "-q", ".");
    g(dir, "config", "user.email", "a@b"); g(dir, "config", "user.name", "a");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    g(dir, "add", "a.txt"); g(dir, "commit", "-qm", "init");
    // The malicious config another account planted, after the first commit.
    const cfgLines = [
      `[core]\n\tfsmonitor = ${evil} fsmonitor`,
      `[diff "evil"]\n\ttextconv = ${evil} textconv\n\tcommand = ${evil} diffcmd`,
      `[filter "evil"]\n\tclean = ${evil} clean\n\tsmudge = ${evil} smudge\n\tprocess = ${evil} process\n\trequired = true`,
      `[alias]\n\tst = !${evil} alias`,
      `[pager]\n\tstatus = ${evil} pager`,
      `[credential]\n\thelper = !${evil} cred`,
      `[remote "origin"]\n\turl = ${dir}\n\tuploadpack = ${evil} uploadpack`,
      `[merge "evil"]\n\tdriver = ${evil} merge`,
    ];
    fs.appendFileSync(path.join(dir, ".git", "config"), cfgLines.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=evil filter=evil merge=evil\n");
    fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(pwn)}/hook\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    return dir;
  };
  // A Bot's git: its env, and the other owner simulated the way git itself checks it.
  const env = { ...buildBotEnv({ cfg, botId: "b1" }), PATH: `${gitShimDir(cfg)}:${path.dirname(REAL_GIT)}:/usr/bin:/bin`, HOME: path.dirname(cfg.workspace), GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_NOSYSTEM: "1" };
  const bot = (cwd: string, cmd: string) => spawnSync("bash", ["-c", cmd], { cwd, env, encoding: "utf8" });
  const pwned = () => fs.readdirSync(pwn);
  return { cfg, makeRepo, bot, pwned, env };
}

describe("a /workspace repo owned by another account (bug-log 121)", () => {
  it("works for a Bot with plain git status / diff / log -p / add / commit, and nothing in its config runs", () => {
    const w = world();
    const repo = w.makeRepo(path.join(w.cfg.workspace, "team", "app"));
    fs.mkdirSync(path.join(repo, "src"));
    for (const cmd of ["git status", "git diff", "git log -p -1", "git -C .. -C app status --short", "git add a.txt", "git commit -qm change", "git show", "git st; true", "git fetch -q origin; true", "git credential fill </dev/null; true"]) {
      const r = w.bot(repo, cmd);
      expect(r.status, `${cmd}: ${r.stderr}`).toBe(0);
      expect(r.stderr, cmd).not.toMatch(/dubious ownership/);
    }
    expect(w.bot(repo, "git fetch origin").stderr).toMatch(/refused: this repo's config sets remote\.origin\.uploadpack/);
    expect(w.bot(path.join(repo, "src"), "git status --short").status, "from a subfolder").toBe(0);
    expect(w.bot(repo, "git log --oneline").stdout.split("\n").filter(Boolean)).toHaveLength(2);
    expect(w.pwned()).toEqual([]);
  });

  it("the fixture is live: trusted WITHOUT the shim's neutralization, the same repo does run the planted programs", () => {
    const w = world();
    const repo = w.makeRepo(path.join(w.cfg.workspace, "control"));
    const trustOnly = `GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT+1)) GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=safe.directory GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=${repo}`;
    w.bot(repo, `export ${trustOnly}; ${REAL_GIT} diff; ${REAL_GIT} add a.txt; ${REAL_GIT} fetch -q origin; true`);
    expect(w.pwned().sort()).toEqual(expect.arrayContaining(["process", "uploadpack"]));
    // A textconv-only repo: git diff runs it when trusted without the shim, and not through the shim.
    const tc = path.join(w.cfg.workspace, "tc");
    fs.mkdirSync(tc);
    const g = (...a: string[]) => execFileSync(REAL_GIT, a, { cwd: tc, env: { ...process.env, HOME: tc, GIT_CONFIG_NOSYSTEM: "1" } });
    g("init", "-q", "."); g("config", "user.email", "a@b"); g("config", "user.name", "a");
    fs.writeFileSync(path.join(tc, "b.txt"), "1\n"); g("add", "."); g("commit", "-qm", "i");
    fs.appendFileSync(path.join(tc, ".git", "config"), `[diff "tv"]\n\ttextconv = ${path.dirname(w.cfg.workspace)}/evil.sh textconv-only\n`);
    fs.writeFileSync(path.join(tc, ".gitattributes"), "*.txt diff=tv\n");
    fs.writeFileSync(path.join(tc, "b.txt"), "2\n");
    w.bot(tc, "git diff b.txt");
    expect(w.pwned()).not.toContain("textconv-only");
    w.bot(tc, `export GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT+1)) GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=safe.directory GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=${tc}; ${REAL_GIT} diff b.txt`);
    expect(w.pwned()).toContain("textconv-only");
  });

  it("fails closed: git by absolute path (no shim), a repo outside /workspace, or a /workspace link out of it is refused", () => {
    const w = world();
    const repo = w.makeRepo(path.join(w.cfg.workspace, "team", "app"));
    expect(w.bot(repo, `${REAL_GIT} status`).stderr).toMatch(/dubious ownership/);
    const outside = w.makeRepo(path.join(path.dirname(w.cfg.workspace), "home-of-another-bot", "repo"));
    expect(w.bot(outside, "git status").stderr).toMatch(/dubious ownership/);
    fs.symlinkSync(outside, path.join(w.cfg.workspace, "link"));
    expect(w.bot(path.join(w.cfg.workspace, "link"), "git status").stderr).toMatch(/dubious ownership/);
    expect(w.pwned()).toEqual([]);
  });

  it("a name can't smuggle a value: an odd subsection is still neutralized", () => {
    const w = world();
    const repo = w.makeRepo(path.join(w.cfg.workspace, "odd"));
    fs.appendFileSync(path.join(repo, ".git", "config"), `[diff "x=y"]\n\ttextconv = ${path.dirname(w.cfg.workspace)}/evil.sh odd\n`);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=x=y\n");
    expect(w.bot(repo, "git diff").status).toBe(0);
    expect(w.pwned()).toEqual([]);
  });

  it("writes the shim once and rewrites it only when stale", () => {
    const cfg = tmpConfig();
    made.push(path.dirname(cfg.workspace));
    const f = ensureGitShim(cfg, GIT_BUILTIN_DIFF, REAL_GIT)!;
    const t = fs.statSync(f).mtimeMs;
    expect(ensureGitShim(cfg, GIT_BUILTIN_DIFF, REAL_GIT)).toBe(f);
    expect(fs.statSync(f).mtimeMs).toBe(t);
    fs.writeFileSync(f, "#!/bin/sh\nexec /usr/bin/git \"$@\"\n");
    ensureGitShim(cfg, GIT_BUILTIN_DIFF, REAL_GIT);
    expect(fs.readFileSync(f, "utf8")).toContain("Synapse git shim");
    expect(os.platform()).toBeTruthy();
  });
});

const sqq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
const ME = os.userInfo().username;
/** A group I'm in that isn't my primary one ("writable by another group"). */
const OTHER_GID = execFileSync("id", ["-G"]).toString().trim().split(/\s+/).find((g) => g !== execFileSync("id", ["-g"]).toString().trim())!;

/**
 * A Bot's git with its own gh login. HOME is a fresh 0700 dir (the Bot's home); the repo is either in it
 * (~/code/app, the Bot's own) or in the shared /workspace. `botUser` undefined = the default pattern (bot-<12 hex>),
 * which this Mac user is not.
 */
function botWorld(o: { botUser?: string | null; where?: "home" | "workspace"; realGit?: string } = {}) {
  const cfg = tmpConfig();
  const root = path.dirname(cfg.workspace);
  made.push(root);
  fs.chmodSync(root, 0o700);
  // The Bot's own home (0700), apart from the shared /workspace as on the box.
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const pwn = path.join(root, "pwned");
  fs.mkdirSync(pwn);
  const evil = path.join(root, "evil.sh");
  fs.writeFileSync(evil, `#!/bin/sh\ntouch ${JSON.stringify(pwn)}/"$1"\necho password=from-evil\n`, { mode: 0o755 });
  const gh = path.join(root, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\necho "$@" >> ${JSON.stringify(path.join(root, "gh-calls"))}\n[ "$3" = get ] && { echo username=x-access-token; echo password=from-gh; }\nexit 0\n`, { mode: 0o755 });
  ensureGitShim(cfg, GIT_BUILTIN_DIFF, o.realGit ?? REAL_GIT, { gh, homeCmd: `printf %s ${sqq(home)}`, ...(o.botUser === null ? {} : { botUser: o.botUser ?? ME }) });
  const where = o.where ?? "home";
  const repo = where === "home" ? path.join(home, "code", "app") : path.join(cfg.workspace, "app");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync(REAL_GIT, ["init", "-q", "."], { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
  const env: Record<string, string> = {
    ...buildBotEnv({ cfg, botId: "b1" }), PATH: `${gitShimDir(cfg)}:${path.dirname(REAL_GIT)}:/usr/bin:/bin`, HOME: home,
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...(where === "workspace" ? { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } : {}),
  };
  const plant = (text: string) => fs.appendFileSync(path.join(repo, ".git", "config"), text);
  const git = (cmd: string, extra: Record<string, string> = {}, cwd = repo) => spawnSync("bash", ["-c", cmd], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  const fill = (host: string, cwd = repo, extra: Record<string, string> = {}) => git(`printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill`, extra, cwd);
  const ghCalls = () => { try { return fs.readFileSync(path.join(root, "gh-calls"), "utf8"); } catch { return ""; } };
  const planted = (tag: string) => `[credential]\n\thelper = !${evil} ${tag}-generic\n[credential "https://github.com"]\n\thelper = !${evil} ${tag}-github\n`;
  return { cfg, root, home, repo, plant, git, fill, ghCalls, planted, pwned: () => fs.readdirSync(pwn) };
}
const MSG = /GitHub sign-in is only used in repos your Bot owns; clone it into your own folder \(e\.g\. ~\/code\) to push\./;

describe("bug 195 S1: the gh credential helper exists only in repos the Bot alone can write", () => {
  it("a Bot-owned repo in the Bot's own home: only gh answers for github.com and gist, planted helpers never run", () => {
    const w = botWorld();
    w.plant(w.planted("repo"));
    fs.writeFileSync(path.join(w.home, ".gitconfig"), w.planted("home"));
    const r = w.fill("github.com");
    expect(r.stdout, r.stderr).toContain("password=from-gh");
    expect(w.fill("gist.github.com").stdout).toContain("password=from-gh");
    expect(w.ghCalls()).toMatch(/^auth git-credential get$/m);
    expect(w.pwned()).toEqual([]);
  });

  it("outside any repo (a clone into the Bot's folder): gh answers", () => {
    const w = botWorld();
    expect(w.fill("github.com", path.dirname(w.repo)).stdout).toContain("password=from-gh");
  });

  it("any other host gets no helper at all", () => {
    const w = botWorld();
    w.plant(w.planted("repo"));
    const r = w.fill("example.com");
    expect(r.stdout).not.toMatch(/password=/);
    expect(w.ghCalls()).toBe("");
    expect(w.pwned()).toEqual([]);
  });

  it("a shared /workspace repo other Bots can write: no gh helper, no credential, and a push says why", () => {
    const w = botWorld({ where: "workspace" });
    w.plant(w.planted("repo"));
    expect(w.fill("github.com").stdout).not.toMatch(/password=/);
    expect(w.ghCalls()).toBe("");
    expect(w.pwned()).toEqual([]);
    expect(w.git("git push file:///nonexistent HEAD").stderr).toMatch(MSG);
    expect(w.git("git status").stderr).not.toMatch(MSG);
  });

  it("a repo config writable by another group: no gh helper", () => {
    const w = botWorld();
    const c = path.join(w.repo, ".git", "config");
    execFileSync("chgrp", [OTHER_GID, c]);
    fs.chmodSync(c, 0o664);
    expect(w.fill("github.com").stdout).not.toMatch(/password=/);
    expect(w.ghCalls()).toBe("");
  });

  it("a planted .git/modules/x/config (world-writable, with a proxy): no gh helper", () => {
    const w = botWorld();
    const m = path.join(w.repo, ".git", "modules", "x");
    fs.mkdirSync(m, { recursive: true });
    fs.writeFileSync(path.join(m, "config"), "[http \"https://github.com\"]\n\tproxy = http://127.0.0.1:9\n");
    fs.chmodSync(path.join(m, "config"), 0o666);
    expect(w.fill("github.com").stdout).not.toMatch(/password=/);
    expect(w.ghCalls()).toBe("");
  });

  it("an included config file others can write: no gh helper", () => {
    const w = botWorld();
    const inc = path.join(w.root, "shared.inc");
    fs.writeFileSync(inc, "[user]\n\tname = x\n");
    fs.chmodSync(inc, 0o666);
    w.plant(`[include]\n\tpath = ${inc}\n`);
    expect(w.fill("github.com").stdout).not.toMatch(/password=/);
  });

  it("GIT_DIR or --git-dir pointing elsewhere: no gh helper", () => {
    const w = botWorld();
    expect(w.fill("github.com", w.repo, { GIT_DIR: path.join(w.repo, ".git") }).stdout).not.toMatch(/password=/);
    expect(w.git(`printf 'protocol=https\\nhost=github.com\\n\\n' | git --git-dir=${sqq(path.join(w.repo, ".git"))} credential fill`).stdout).not.toMatch(/password=/);
  });

  it("with gh active: submodule recursion is pinned off and submodule update/sync are refused", () => {
    const w = botWorld();
    w.plant("[submodule]\n\trecurse = true\n[fetch]\n\trecurseSubmodules = true\n");
    expect(w.git("git config --get submodule.recurse").stdout.trim()).toBe("false");
    expect(w.git("git config --get fetch.recurseSubmodules").stdout.trim()).toBe("false");
    for (const c of ["git submodule update --init", "git submodule --quiet sync"]) {
      const r = w.git(c);
      expect(r.status, c).not.toBe(0);
      expect(r.stderr, c).toMatch(/refused/);
    }
    expect(w.git("git submodule status").stderr).not.toMatch(/refused/);
  });

  it("a process that isn't a Bot account (box, bothost) gets no gh helper", () => {
    const w = botWorld({ botUser: null });
    expect(w.fill("github.com").stdout).not.toMatch(/password=/);
    expect(w.ghCalls()).toBe("");
  });
});

describe("bug 195 N1: where gh is active, the repo's config can't proxy or MITM git", () => {
  const HOSTILE = [
    "[http]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n\textraHeader = X-Evil: 1\n",
    "[http \"https://github.com\"]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n\textraHeader = X-Evil: 2\n",
    "[http \"https://github.com/org\"]\n\tproxy = http://127.0.0.1:9\n\tsslVerify = false\n",
    "[remote \"origin\"]\n\turl = https://github.com/org/repo\n\tproxy = http://127.0.0.1:9\n",
  ].join("");
  const eff = (w: ReturnType<typeof botWorld>, key: string, url = "https://github.com/org/repo") => w.git(`git config --get-urlmatch ${key} ${url}`).stdout.trim();

  it("proxy, sslVerify=false and extra headers are pinned away for github.com (git's own url matching)", () => {
    const w = botWorld();
    w.plant(HOSTILE);
    expect(eff(w, "http.proxy")).toBe("");
    expect(eff(w, "http.sslverify")).toBe("true");
    expect(w.git("git config --get-urlmatch --get-all http.extraheader https://github.com/org/repo").stdout).not.toMatch(/X-Evil/);
    expect(w.git("git config --get remote.origin.proxy").stdout.trim()).toBe("");
    expect(eff(w, "http.proxy", "https://example.com/x")).toBe("");
  });

  it("a CA, client cert or cookie file in the config refuses the transport", () => {
    for (const k of ["[http]\n\tsslCAInfo = /tmp/evil-ca.pem\n", "[http \"https://github.com\"]\n\tsslCAPath = /tmp/evil\n", "[http]\n\tsslCert = /tmp/c.pem\n", "[http \"https://github.com\"]\n\tcookieFile = /tmp/c\n"]) {
      const w = botWorld();
      w.plant(k);
      const r = w.git("git ls-remote https://github.com/org/repo");
      expect(r.status, k).not.toBe(0);
      expect(r.stderr, k).toMatch(/refused/);
      expect(w.git("git status").status, "local commands still work").toBe(0);
    }
  });

  it("proxy and TLS env vars are cleared for git", () => {
    const cfg0 = tmpConfig();
    made.push(path.dirname(cfg0.workspace));
    const fake = path.join(path.dirname(cfg0.workspace), "git-env");
    fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = config ] && exec ${JSON.stringify(REAL_GIT)} "$@"\nenv\n`, { mode: 0o755 });
    const w = botWorld({ realGit: fake });
    const out = w.git("git version", { GIT_SSL_NO_VERIFY: "1", HTTPS_PROXY: "http://x", https_proxy: "http://x", HTTP_PROXY: "http://x", http_proxy: "http://x", ALL_PROXY: "http://x", GIT_SSL_CAINFO: "/x", CURL_CA_BUNDLE: "/x" }).stdout;
    expect(out).not.toMatch(/^(GIT_SSL_NO_VERIFY|HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy|ALL_PROXY|GIT_SSL_CAINFO|CURL_CA_BUNDLE)=/m);
    expect(out).toMatch(/^HOME=/m);
  });

  it("a process that isn't a Bot account keeps git's config as it was (no gh helper, no pins)", () => {
    const w = botWorld({ botUser: null });
    w.plant(HOSTILE);
    expect(eff(w, "http.proxy")).toBe("http://127.0.0.1:9");
  });
});
