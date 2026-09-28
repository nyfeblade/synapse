/**
 * exempt-tool-pinning, re-check gaps (bug 236):
 *  1. A shebang interpreter's dir goes AFTER the fixed PATH, and is write-denied as a whole in the sandbox.
 *  2. Every search dir × exempt name is write-denied as a literal, existing or not (a `claude` planted into
 *     /opt/homebrew/bin ahead of the real one) — never the search dir as a whole; recomputed per run.
 *  3. Only one simple command (optionally after `cd <dir> &&`) runs unwrapped; chains, `hash`, `PATH=` stay sandboxed.
 *  4. The app-side write-file / edit-file (no sandbox) refuse the same places, in the fixed rules.
 * HOME is a temp dir, and a temp dir stands in for /opt/homebrew/bin; PATH is narrowed to the temp dirs + FIXED_PATH.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { macSandboxExemptSimple } from "@synapse/shared";
import { LocalExecutor } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { FIXED_PATH, exemptInstallTrees } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let brew: string;
let claudeV1: string;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "etg-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "probe.txt"), "SECRET-PROBE");
  brew = path.join(home, "stand-in-homebrew-bin");
  fs.mkdirSync(brew);
  const v1 = path.join(home, ".local", "share", "claude", "versions", "1.0");
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  claudeV1 = path.join(v1, "claude");
  fs.writeFileSync(claudeV1, "#!/bin/sh\necho CLAUDE-RAN\n", { mode: 0o755 });
  fs.symlinkSync(claudeV1, path.join(home, ".local", "bin", "claude"));
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${brew}:${FIXED_PATH}`;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
async function sh(command: string): Promise<string> {
  const chunks: string[] = [];
  await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return chunks.join("");
}

function interpreterTool(): { interp: string } {
  // `codex` is a script run by `#!/usr/bin/env mynode`; mynode lives in its own dir (as node does in a Cellar/nvm dir).
  const interp = path.join(home, "node-dist", "bin");
  fs.mkdirSync(interp, { recursive: true });
  fs.writeFileSync(path.join(interp, "mynode"), "#!/bin/sh\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(interp, "git"), "#!/bin/sh\necho POISONED-GIT\n", { mode: 0o755 });
  // Bug 239: the exempt node-script tool is playwright (codex is no longer exempt).
  const pkg = path.join(home, "npm-global", "lib", "node_modules", "playwright");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "cli.js"), "#!/usr/bin/env mynode\necho \"CODEX PATH=$PATH\"\ngit --version\n", { mode: 0o755 });
  fs.symlinkSync(path.join(pkg, "cli.js"), path.join(brew, "playwright"));
  process.env.PATH = `${brew}:${interp}:${FIXED_PATH}`;
  return { interp };
}

describe("1. the interpreter's dir", () => {
  it("is write-denied as a whole (and is not a shared bin dir)", () => {
    const { interp } = interpreterTool();
    const t = exemptInstallTrees(home);
    expect(t.subpaths).toContain(interp);
    expect(t.subpaths).not.toContain(brew);
  });

  it.runIf(process.platform === "darwin")("comes AFTER the fixed PATH: a git planted beside the interpreter isn't used", async () => {
    const { interp } = interpreterTool();
    const out = await sh("playwright test");
    expect(out).toContain(`CODEX PATH=${FIXED_PATH}:${interp}\n`);
    expect(out).not.toContain("POISONED");
    expect(out).toMatch(/git version/);
  });

  it.runIf(process.platform === "darwin")("under the wrapper, the interpreter's dir can't be written", async () => {
    const { interp } = interpreterTool();
    await sh(`cp /usr/bin/true '${interp}/git2' 2>&1; echo x > '${interp}/mynode' 2>&1`);
    expect(fs.existsSync(path.join(interp, "git2"))).toBe(false);
    expect(fs.readFileSync(path.join(interp, "mynode"), "utf8")).toContain("exec /bin/sh");
  });
});

describe("2. a new file that would shadow an exempt tool", () => {
  it("every search dir × exempt name is a literal, existing or not — never the dir", () => {
    const t = exemptInstallTrees(home);
    for (const n of ["claude", "codex", "npx", "playwright", "node"]) expect(t.literals).toContain(path.join(brew, n));
    expect(t.literals).toContain(path.join(home, ".local", "bin", "codex"));
    expect(t.subpaths).not.toContain(brew);
    expect(t.subpaths).not.toContain(path.join(home, ".local", "bin"));
  });

  it.runIf(process.platform === "darwin")("under the wrapper, a planted <brew>/claude is denied; other files there are not", async () => {
    await sh(`cp /bin/echo '${brew}/claude' 2>&1; ln -s /bin/echo '${home}/.local/bin/codex' 2>&1; echo ok > '${brew}/unrelated'`);
    expect(fs.existsSync(path.join(brew, "claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".local", "bin", "codex"))).toBe(false);
    expect(fs.readFileSync(path.join(brew, "unrelated"), "utf8").trim()).toBe("ok");
  });

  it.runIf(process.platform === "darwin")("a tool installed after start-up is covered on the next run (no cache)", async () => {
    await sh("true"); // an earlier run
    const late = path.join(home, "late-bin");
    fs.mkdirSync(late);
    process.env.PATH = `${late}:${process.env.PATH}`;
    await sh(`cp /bin/echo '${late}/claude' 2>&1`);
    expect(fs.existsSync(path.join(late, "claude"))).toBe(false);
  });
});

describe("3. only a single simple command runs unwrapped", () => {
  it.each(["playwright test", "cd pkg && swift build", "cd 'my dir' && swift test", "swift build 2>&1", "xcodebuild -scheme A build"])(
    "unwrapped: %s", (cmd) => expect(macSandboxExemptSimple(cmd)).not.toBeNull());
  it.each([
    "claude -p x && ./evil", "claude -p x; ./evil", "claude -p x || ./evil", "claude -p x | tee out", "claude -p x > out",
    "hash claude=/tmp/evil ; claude -p hi", "hash claude=/tmp/evil && claude -p hi", "PATH=/tmp/evil claude -p hi", "env PATH=/tmp/evil claude -p hi",
    `claude -p "$(cat prompt)"`, "claude -p x &", "cd a && cd b && claude -p x", "cd $(pwd) && claude -p x", "command claude -p x",
  ])("stays sandboxed: %s", (cmd) => expect(macSandboxExemptSimple(cmd)).toBeNull());

  it.runIf(process.platform === "darwin")("live: `claude -p x && …` runs inside the sandbox (the app data stays unreadable)", async () => {
    const out = await sh(`claude -p x && cat ${home}/Library/App*/Bo*/probe.txt`);
    expect(out).not.toContain("SECRET-PROBE");
  });
});

describe("4. app-side write-file / edit-file refuse the same places", () => {
  const store = () => {
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 4), { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    p.grant("b1", "write-file");
    p.grant("b1", "edit-file");
    p.setBotMode("b1", "full-auto");
    return p;
  };
  it.each([
    () => claudeV1,
    () => path.join(home, ".local", "share", "claude", "versions", "9.9", "claude"),
    () => path.join(home, ".local", "bin", "claude"),
    () => path.join(brew, "claude"),
  ])("write-file and edit-file are refused (%#)", (target) => {
    const p = store();
    for (const op of ["write-file", "edit-file"] as const) {
      const v = p.check({ execId: "x", botId: "b1", approvalId: null, op, path: target(), content: "evil", oldString: "a", newString: "b" });
      expect(v.ok, `${op} ${target()}`).toBe(false);
      expect((v as { reason: string }).reason).toMatch(/never|fixed safety rule/i);
    }
  });
  it("an ordinary file in the stand-in bin dir is not refused by this rule", () => {
    const v = store().check({ execId: "x", botId: "b1", approvalId: null, op: "write-file", path: path.join(brew, "notes.txt"), content: "x" });
    expect((v as { reason?: string }).reason ?? "").not.toMatch(/exempt tool|install/i);
  });
});
