/**
 * exempt-tool-pinning (bug 235): the exempt tools (claude, codex, npx, playwright…) live where a sandboxed Bot can
 * write — ~/.local/bin/claude is a symlink into ~/.local/share/claude/versions/… — so the next approved one-shot could
 * run the Bot's code outside the sandbox.
 *  1. The tool runs by its resolved realpath, which the card shows.
 *  2. PATH is the fixed system PATH only, plus the realpath dir of a shebang interpreter (node) when the tool is a script.
 *  3. The sandbox denies writes to each exempt tool's install tree (~/.local/share/claude, ~/.local/bin/claude, the npm
 *     global package dirs), never /opt/homebrew/bin as a whole.
 *  4. The tool's realpath + size + mtime are pinned when its card is shown/approved; a change before exec is refused.
 * HOME is a temp dir; PATH is narrowed so the user's real tools are never resolved or run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, STR5, localBindTarget } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore, bindHash } from "../../src/coordinator/local-exec/policy";
import { FIXED_PATH, exemptInstallTrees, pinTool } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let saved: { HOME?: string; PATH?: string };
let claudeV1: string;
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "etp-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = FIXED_PATH; // only the temp home's ~/.local/bin (a fallback dir) can supply `claude`
  // The native installer's layout: ~/.local/bin/claude -> ~/.local/share/claude/versions/1.0/claude
  const v1 = path.join(home, ".local", "share", "claude", "versions", "1.0");
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  claudeV1 = path.join(v1, "claude");
  fs.writeFileSync(claudeV1, `#!/bin/sh\necho "CLAUDE-RAN $0"\ngit --version\necho "PATH=$PATH"\n`, { mode: 0o755 });
  fs.symlinkSync(claudeV1, path.join(home, ".local", "bin", "claude"));
  // Bug 239: claude is no longer exempt (it runs in the sandbox); the pinning is exercised on an exempt tool, playwright,
  // installed the same way (a ~/.local/bin link into a versions dir). The claude tree stays write-protected (below).
  fs.symlinkSync(claudeV1, path.join(home, ".local", "bin", "playwright"));
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
async function sh(command: string, approvalId: string | null = null, pin?: ReturnType<typeof pinTool>): Promise<string> {
  const chunks: string[] = [];
  await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c), ...(pin ? { pin } : {}) });
  return chunks.join("");
}
const store = () => {
  const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 2), { home: () => home, userData: () => userData });
  p.setBotMode("b1", "full-auto");
  return p;
};
const req = (command: string, approvalId: string | null = null) => ({ execId: "x", botId: "b1", approvalId, op: "run-command" as const, command, cwd: home });

describe("1. the card shows the realpath", () => {
  it("playwright → the version file, not the ~/.local/bin symlink", () => {
    const v = store().check(req("playwright test"));
    expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL)).toBe(true);
    expect((v as { reason: string }).reason).toContain(`playwright → ${claudeV1}`);
  });
});

describe.runIf(process.platform === "darwin")("1 + 2. the run (live, temp HOME)", () => {
  it("runs the realpath with the fixed PATH; a git planted beside the tool (or in ~/.local/bin) isn't used", async () => {
    for (const d of [path.dirname(claudeV1), path.join(home, ".local", "bin")]) {
      fs.writeFileSync(path.join(d, "git"), "#!/bin/sh\necho POISONED-GIT\n", { mode: 0o755 });
    }
    const out = await sh("playwright test");
    expect(out).toContain(`CLAUDE-RAN ${claudeV1}`);
    expect(out).not.toContain("POISONED");
    expect(out).toMatch(/git version/);
    expect(out).toContain(`PATH=${FIXED_PATH}\n`);
  });

  it("a node-script tool gets only its interpreter's realpath dir added", async () => {
    const pkg = path.join(home, "npm-global", "lib", "node_modules", "playwright");
    fs.mkdirSync(pkg, { recursive: true });
    const js = path.join(pkg, "cli.js");
    fs.writeFileSync(js, "#!/usr/bin/env node\nconsole.log('CODEX-RAN PATH=' + process.env.PATH)\n", { mode: 0o755 });
    const gbin = path.join(home, "npm-global", "bin");
    fs.mkdirSync(gbin);
    fs.symlinkSync(js, path.join(gbin, "playwright"));
    fs.writeFileSync(path.join(gbin, "git"), "#!/bin/sh\necho POISONED\n", { mode: 0o755 });
    const nodeDir = path.dirname(process.execPath);
    process.env.PATH = `${gbin}:${nodeDir}:${FIXED_PATH}`;
    const out = await sh("playwright test");
    expect(out).toContain(`CODEX-RAN PATH=${FIXED_PATH}:${path.dirname(fs.realpathSync.native(process.execPath))}`); // bug 236: the interpreter dir goes after
    expect(out).not.toContain(gbin);
  });
});

describe("4. pinned between card and exec", () => {
  const approve = (p: LocalPolicyStore, command: string, id: string) =>
    p.recordApproval(id, { botId: "b1", expiresAt: Date.now() + 60_000, bind: bindHash("run-command", localBindTarget(req(command))) });

  it("unchanged: the approval runs, and hands the pin to the executor", () => {
    const p = store();
    p.check(req("playwright test")); // the card
    approve(p, "playwright test", "a1");
    const v = p.check(req("playwright test", "a1"));
    expect(v.ok).toBe(true);
    expect((v as { pin?: { realpath: string } }).pin?.realpath).toBe(claudeV1);
  });

  it("a repointed symlink after the card is refused; the next card shows the new path", () => {
    const p = store();
    p.check(req("playwright test"));
    approve(p, "playwright test", "a1");
    const v2 = path.join(home, ".local", "share", "claude", "versions", "2.0");
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(path.join(v2, "claude"), "#!/bin/sh\necho EVIL\n", { mode: 0o755 });
    fs.rmSync(path.join(home, ".local", "bin", "playwright"));
    fs.symlinkSync(path.join(v2, "claude"), path.join(home, ".local", "bin", "playwright"));
    const v = p.check(req("playwright test", "a1"));
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain(STR5.macToolChanged);
    const again = p.check(req("playwright test"));
    expect((again as { reason: string }).reason).toContain(`playwright → ${path.join(v2, "claude")}`);
  });

  it("the same file rewritten after the card is refused", () => {
    const p = store();
    p.check(req("playwright test"));
    approve(p, "playwright test", "a1");
    fs.appendFileSync(claudeV1, "echo EVIL\n");
    expect(p.check(req("playwright test", "a1")).ok).toBe(false);
  });

  it("an approval with no pin (no card seen by this run) is refused, not run", () => {
    const p = store();
    approve(p, "playwright test", "a1");
    expect(p.check(req("playwright test", "a1")).ok).toBe(false);
  });

  it.runIf(process.platform === "darwin")("the executor re-checks the pin right before exec", async () => {
    const pin = pinTool("playwright", { home });
    fs.appendFileSync(claudeV1, "echo EVIL\n");
    await expect(sh("playwright test", "a1", pin)).rejects.toThrow(STR5.macToolChanged);
  });
});

describe("3. the install trees are write-denied", () => {
  it("the profile names ~/.local/share/claude, ~/.local/bin/claude and an npm global package dir — never a whole bin dir", () => {
    const pkg = path.join(home, "npm-global", "lib", "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "#!/bin/sh\n", { mode: 0o755 });
    const gbin = path.join(home, "npm-global", "bin");
    fs.mkdirSync(gbin);
    fs.symlinkSync(path.join(pkg, "bin", "codex.js"), path.join(gbin, "codex"));
    process.env.PATH = `${gbin}:${FIXED_PATH}`;
    const trees = exemptInstallTrees(home);
    expect(trees.subpaths).toContain(path.join(home, ".local", "share", "claude"));
    expect(trees.subpaths).toContain(pkg);
    expect(trees.literals).toContain(path.join(home, ".local", "bin", "claude"));
    expect(trees.literals).toContain(path.join(gbin, "codex"));
    expect(trees.subpaths).not.toContain(gbin);
    expect(trees.subpaths).not.toContain("/opt/homebrew/bin");
    const profile = ownDataSandboxProfile(userData, home);
    expect(profile).toContain(`(subpath "${path.join(home, ".local", "share", "claude")}")`);
    expect(profile).toContain(`(literal "${path.join(home, ".local", "bin", "claude")}")`);
  });

  it.runIf(process.platform === "darwin")("under the wrapper, the claude install tree can't be written, replaced or repointed", async () => {
    const link = path.join(home, ".local", "bin", "claude");
    await sh(`echo 'echo EVIL' >> '${claudeV1}' 2>&1; mkdir -p '${home}/.local/share/claude/versions/9.9' 2>&1; ln -sfn /bin/echo '${link}' 2>&1; python3 -c "import os; os.replace('${home}/x', '${link}')" 2>&1; cp /bin/echo '${path.dirname(claudeV1)}/git' 2>&1`);
    expect(fs.readFileSync(claudeV1, "utf8")).not.toContain("EVIL");
    expect(fs.existsSync(path.join(home, ".local", "share", "claude", "versions", "9.9"))).toBe(false);
    expect(fs.realpathSync.native(link)).toBe(claudeV1);
    expect(fs.existsSync(path.join(path.dirname(claudeV1), "git"))).toBe(false);
  });
});
