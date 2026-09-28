/**
 * mac-keychain-guard, the credential ruling: the sandbox keeps its Security-server deny (so nothing inside reaches the
 * keychain), and each tool that needs a credential gets a narrow one:
 *  1. claude — the Anthropic API key only, as a per-run key-proxy token (mac-api-key-mode.test.ts covers it); the app's
 *     data folder, where the Mac's copy of the key lives, is read-denied in the sandbox. No Claude login is ever used.
 *  2 + 3. (Second ruling) Bots never use the user's Mac credentials: Mac-side git push/fetch/pull/clone/ls-remote and
 *     gh stay in the sandbox (anonymous HTTPS works); when credentials were needed the run says to use the Bot's own
 *     computer (bug 195). ~/.config/gh and ~/.local/share/gh stay write-protected for the user's own Terminal.
 *  4. Anything else that needs the keychain gets a refusal naming the keychain.
 * HOME is a temp dir; the keychain is never read — claude, gh and the git credential helper are stubs.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, STR5, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { loadPolicyKey } from "../../src/coordinator/local-exec/policy-key";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";
import { disposeScratchPolicy } from "../../src/coordinator/local-exec/wiring";

let home: string;
let userData: string;
let bin: string;
let key: Buffer;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mcr-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  const k = loadPolicyKey(userData);
  if (!k.ok) throw new Error("no key");
  key = k.key;
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${FIXED_PATH}`;
});
afterEach(() => {
  disposeScratchPolicy();
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true });
async function sh(ex: LocalExecutor, command: string, approvalId: string | null = null, cwd = home): Promise<string> {
  const c: string[] = [];
  await ex.run({ execId: `e${Math.random()}`, botId: "b", approvalId, op: "run-command", command, cwd }, { output: (_s, x) => c.push(x) });
  return c.join("");
}
const store = () => {
  const p = new LocalPolicyStore(userData, Date.now, key, { home: () => home, userData: () => userData });
  p.update({ localRoot: home, executionPolicy: "always" });
  p.grant("b1", "run-command");
  p.grant("b1", "write-file");
  p.setBotMode("b1", "full-auto");
  return p;
};
const check = (p: LocalPolicyStore, command: string) => p.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command, cwd: home });

describe("1. the Bots' claude on the Mac", () => {
  it("the data folder (where the Mac's copy of the API key lives) is read-denied in the sandbox", () => {
    expect(ownDataSandboxProfile(userData, home)).toContain(`(deny file-read* file-write* (subpath "${userData}")`);
  });
});

describe("2 + 3. Mac-side git network commands and gh stay in the sandbox (ruling: Bots never use the user's Mac credentials)", () => {
  const QUIET = ["git push", "git push origin main", "git fetch --all", "git pull --rebase", "git clone https://x/y.git", "git ls-remote origin", "gh pr list", "gh repo view --json name"];
  it.each(QUIET)("no hand-off, no card of its own (bug 151's quiet push restored): %s", (cmd) => {
    expect(macUnsandboxedHandoff(cmd, { home })).toBeNull();
    const v = check(store(), cmd);
    expect((v as { reason?: string }).reason ?? "", cmd).not.toMatch(/keychain credentials|outside the command sandbox/);
  });
  it("git push in Full auto runs with no card at all (bug 151)", () => {
    expect(check(store(), "git push origin main")).toEqual({ ok: true });
  });

  describe.runIf(process.platform === "darwin")("live: they run wrapped", () => {
    it("an approval id doesn't unwrap gh (it stays in the sandbox, which can't read the app data)", async () => {
      fs.writeFileSync(path.join(userData, "probe.txt"), "SECRET-PROBE");
      fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ncat ${home}/Library/App*/Bo*/probe.txt 2>&1\necho GH-RAN\n`, { mode: 0o755 });
      // An absolute path: the login shell's path_helper would otherwise put a real gh ahead of the temp bin.
    const out = await sh(exec(), `${bin}/gh pr list`, "approved");
      expect(out).toContain("GH-RAN");
      expect(out).not.toContain("SECRET-PROBE");
    });
    it("a Mac-side git that wanted credentials says to use the Bot's own computer", async () => {
      fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho \"fatal: could not read Username for 'https://github.com': terminal prompts disabled\" >&2\nexit 128\n", { mode: 0o755 });
      const out = await sh(exec(), `${bin}/git push origin main`);
      expect(out).toContain(STR5.macGithubFromBotComputer);
    });
    it("a Mac-side gh that isn't signed in says the same", async () => {
      fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n", { mode: 0o755 });
      const out = await sh(exec(), `${bin}/gh pr list`);
      expect(out).toContain(STR5.macGithubFromBotComputer);
    });
    it("anonymous git over HTTPS still works wrapped (a local server, no credentials)", async () => {
      const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const port = (server.address() as { port: number }).port;
      try {
        const out = await sh(exec(), `/usr/bin/git ls-remote http://127.0.0.1:${port}/r.git 2>&1; echo DONE`);
        expect(out).toContain("DONE");
        expect(out).not.toMatch(/sandbox_apply|Operation not permitted/);
      } finally { server.close(); }
    });
  });

  it("~/.config/gh and ~/.local/share/gh are protected tool config (for the user's own Terminal)", () => {
    const prof = ownDataSandboxProfile(userData, home);
    for (const d of [".config/gh", ".local/share/gh"]) {
      expect(prof).toContain(`(subpath "${home}/${d}")`);
      expect(macUnsandboxedHandoff(`echo x > ~/${d}/f.yml`, { home })).not.toBeNull();
      const v = store().check({ execId: "x", botId: "b1", approvalId: null, op: "write-file", path: path.join(home, d, "f.yml"), content: "x" });
      expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL), d).toBe(true);
    }
  });
  it.runIf(process.platform === "darwin")("live: under the wrapper, python can't write ~/.config/gh or ~/.local/share/gh", async () => {
    for (const d of [".config/gh", ".local/share/gh"]) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
      const f = path.join(home, d, "x.yml");
      await sh(exec(), `python3 -c "open('${f}','w').write('evil')" 2>&1`);
      expect(fs.existsSync(f), d).toBe(false);
    }
  });
});

describe.runIf(process.platform === "darwin")("4. anything else that needs the keychain gets a refusal naming it", () => {
  it("a wrapped tool that hits the keychain", async () => {
    fs.writeFileSync(path.join(bin, "needs-keychain"), "#!/bin/sh\necho 'security: SecKeychainSearchCopyNext: errSecInteractionNotAllowed' >&2\nexit 1\n", { mode: 0o755 });
    const out = await sh(exec(), "needs-keychain");
    expect(out).toContain(STR5.macKeychainBlocked);
  });
});
