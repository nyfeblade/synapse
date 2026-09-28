/**
 * synapse-public, review round 3 on the Mac (S2, S6, D3, the cache-TTL open item). The defence is where the credential
 * lives, not the login-command regex: the sandbox read-denies every Claude login file and the keychain in every mode, an
 * exempt (unsandboxed) tool runs with the dead sentinel and an empty app-owned claude config dir, every run's env is
 * built by one function over the shared claudeEnv (checked at runtime), and the migration renames before it removes.
 * HOME is a temp dir; claude and swift are stubs; no keychain call and no network.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_LOGIN_VARS, MAC_CLAUDE_CONFIG_DIR, SENTINEL_API_KEY, SENTINEL_BASE_URL, evaluateFixedRules } from "@synapse/shared";
import { CLAUDE_EMPTY_CONFIG_DIR, LEGACY_MAC_CLAUDE_TOKEN_FILE, macRunEnv, retireMacClaudeLogin } from "../../src/coordinator/local-exec/login-scrub";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { saveMacApiKey, loadMacApiKey } from "../../src/coordinator/local-exec/mac-api-key";
import { MAC_PROXY_TOKEN_PREFIX, MacKeyProxy } from "../../src/coordinator/local-exec/mac-key-proxy";
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
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mr3-home-")));
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

const everyLogin = Object.fromEntries(CLAUDE_LOGIN_VARS.map((k) => [k, `stray-${k}`]));

describe("S6: every Mac run's env is built by macRunEnv over the shared claudeEnv", () => {
  it("no grant: the dead sentinel, every login var gone", () => {
    const env = macRunEnv({ PATH: "/usr/bin", ...everyLogin }, {});
    for (const k of CLAUDE_LOGIN_VARS) if (k !== "ANTHROPIC_API_KEY") expect(env[k], k).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe(SENTINEL_API_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe(SENTINEL_BASE_URL);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("a grant: its token and base URL, the config dir and the cache TTL given", () => {
    const env = macRunEnv({ ...everyLogin }, { grant: { token: "sk-ant-api03-macproxy-t", baseUrl: "http://127.0.0.1:5555" }, claudeConfigDir: "/x/claude-mac", cacheTtl: "5m" });
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api03-macproxy-t", ANTHROPIC_BASE_URL: "http://127.0.0.1:5555", CLAUDE_CONFIG_DIR: "/x/claude-mac", CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" });
    for (const k of CLAUDE_LOGIN_VARS) if (k !== "ANTHROPIC_API_KEY") expect(env[k], k).toBeUndefined();
  });
});

describe("S2 (a, b): the sandbox read-denies every Claude login file and the keychain, in every mode", () => {
  const modes = [{}, { handoffLite: true }, { noLimits: true }, { noLimits: true, handoffLite: true }];
  for (const m of modes) {
    it(`mode ${JSON.stringify(m)}`, () => {
      const p = ownDataSandboxProfile(userData, home, m);
      const line = p.split("\n").find((l) => l.includes(".credentials.json")) ?? "";
      expect(line).toMatch(/^\(deny file-read\* file-write\* /);
      for (const f of [`${home}/.claude/.credentials.json`, `${home}/${MAC_CLAUDE_CONFIG_DIR}/.credentials.json`, `${home}/.claude.json`]) expect(line, f).toContain(`(literal "${f}")`);
      expect(p).toMatch(/\(deny process-exec [^\n]*\(literal "\/usr\/bin\/security"\)/);
      expect(p).toContain('(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.security.agent") (global-name "com.apple.securityd"))');
    });
  }

  it("a keychain read of a stand-in Claude item is refused by the fixed rules (no keychain call is made)", () => {
    const ctx = { home, projectDirs: [], userData, realpath: (p: string) => p };
    for (const cmd of [
      "security find-generic-password -s Synapse-Test-Claude-Code-credentials -w",
      "/usr/bin/security find-generic-password -s 'Synapse-Test-Claude-Code-credentials' -w",
      "cd /tmp && security find-generic-password -a me -s Synapse-Test-Claude-Code-credentials",
    ]) {
      expect(evaluateFixedRules({ side: "mac", kind: "command", command: cmd, cwd: home }, ctx).verdict, cmd).toBe("never");
      expect(evaluateFixedRules({ side: "mac", kind: "command", command: cmd, cwd: home }, { ...ctx, noLimits: true }).verdict, `${cmd} (No limits)`).toBe("never");
    }
  });
});

describe("D3: the migration renames each entry first, then removes only the link or the plain file", () => {
  it("a symlinked login file in the app-owned config dir: the link goes, the target (a ~/.claude stand-in) stays", () => {
    const users = path.join(home, ".claude");
    fs.mkdirSync(users, { recursive: true });
    const target = path.join(users, ".credentials.json");
    fs.writeFileSync(target, "user's own login");
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, ".credentials.json"));
    fs.symlinkSync(target, path.join(userData, LEGACY_MAC_CLAUDE_TOKEN_FILE));
    fs.symlinkSync(target, path.join(userData, `${LEGACY_MAC_CLAUDE_TOKEN_FILE}.7.tmp`));
    fs.writeFileSync(path.join(userData, `${LEGACY_MAC_CLAUDE_TOKEN_FILE}.8.tmp`), "old");
    expect(retireMacClaudeLogin(userData, home)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("user's own login");
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.readdirSync(userData).filter((n) => n.includes("claude-token") || n.includes(".trash"))).toEqual([]);
  });

  it("a directory planted under a login file's name is left alone (never recursed into)", () => {
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR, ".credentials.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep"), "x");
    retireMacClaudeLogin(userData, home);
    expect(fs.existsSync(dir) || fs.readdirSync(path.dirname(dir)).some((n) => fs.existsSync(path.join(path.dirname(dir), n, "keep")))).toBe(true);
  });
});

describe("D3 (round 3 re-review): the app-owned config dir is renamed before anything looks at it", () => {
  const setup = () => {
    const users = path.join(home, ".claude");
    fs.mkdirSync(users, { recursive: true });
    fs.writeFileSync(path.join(users, ".credentials.json"), "user's own login");
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".credentials.json"), "old app login");
    fs.writeFileSync(path.join(dir, "settings.json"), "{}");
    return { users, dir };
  };
  afterEach(() => vi.restoreAllMocks());

  it("a swap of the config dir for a link to ~/.claude just before the first move never reaches ~/.claude", () => {
    const { users, dir } = setup();
    const realRename = fs.renameSync;
    let swapped = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!swapped && String(from).startsWith(path.dirname(dir))) {
        swapped = true; // the attacker wins the race: the app's dir is now a link to the user's ~/.claude
        realRename(dir, path.join(home, "moved-away"));
        fs.symlinkSync(users, dir);
      }
      return realRename(from, to);
    });
    retireMacClaudeLogin(userData, home);
    expect(swapped).toBe(true);
    expect(fs.readFileSync(path.join(users, ".credentials.json"), "utf8")).toBe("user's own login");
    expect(fs.readdirSync(users)).toEqual([".credentials.json"]);
    expect(fs.readdirSync(path.dirname(dir)).filter((n) => n.includes("trash") || n.includes("retire"))).toEqual([]);
  });

  it("a real config dir: only the login file goes, the rest stays, at the same name", () => {
    const { dir } = setup();
    expect(retireMacClaudeLogin(userData, home)).toBe(true);
    expect(fs.lstatSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    expect(fs.readdirSync(path.dirname(dir))).toEqual(["claude-mac"]);
  });

  it("a config dir planted as a link to ~/.claude: the link goes, ~/.claude is untouched", () => {
    const users = path.join(home, ".claude");
    fs.mkdirSync(users, { recursive: true });
    fs.writeFileSync(path.join(users, ".credentials.json"), "user's own login");
    const dir = path.join(home, MAC_CLAUDE_CONFIG_DIR);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(users, dir);
    retireMacClaudeLogin(userData, home);
    expect(fs.readFileSync(path.join(users, ".credentials.json"), "utf8")).toBe("user's own login");
    expect(fs.existsSync(dir)).toBe(false);
  });
});

type Auth = { keySaved: boolean; spend: { ok: boolean; message: string | null }; promptCacheTtl?: "5m" | "1h" };
const proxies: MacKeyProxy[] = [];
afterEach(async () => { for (const p of proxies.splice(0)) await p.stop(); });
const exec = (auth: Auth | null) => {
  const p = new MacKeyProxy({ key: () => loadMacApiKey(userData, key), upstream: "http://127.0.0.1:9" });
  proxies.push(p);
  return new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, keyProxy: p, claudeAuth: async () => auth });
};
const sh = async (e: LocalExecutor, command: string): Promise<string> => {
  let out = "";
  await e.run({ execId: `x${Math.random()}`, botId: "b1", approvalId: null, op: "run-command", command, cwd: home } as never, { output: (_s: string, t: string) => { out += t; } } as never).catch((err: Error) => { out += `ERR ${err.message}`; });
  return out;
};

describe.runIf(process.platform === "darwin")("live: exempt tools and the cache TTL", () => {
  const PRINT = `#!/bin/sh\necho "KEY=[$ANTHROPIC_API_KEY] BASE=[$ANTHROPIC_BASE_URL] CFG=[$CLAUDE_CONFIG_DIR] TTL=[$CLAUDE_CODE_PROMPT_CACHE_TTL]"\n`;

  it("an exempt tool (swift, unsandboxed) gets the dead sentinel and an empty app-owned claude config dir", async () => {
    fs.writeFileSync(path.join(bin, "swift"), PRINT, { mode: 0o755 });
    const out = await sh(exec(null), "swift build");
    const cfg = path.join(userData, CLAUDE_EMPTY_CONFIG_DIR);
    expect(out).toContain(`KEY=[${SENTINEL_API_KEY}] BASE=[${SENTINEL_BASE_URL}] CFG=[${cfg}]`);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(cfg)).toEqual([]);
  });

  it("a granted claude run gets the Savings cache TTL from the host's answer (5m), 1h when the host doesn't say", async () => {
    fs.writeFileSync(path.join(bin, "claude"), PRINT, { mode: 0o755 });
    saveMacApiKey(userData, key, "sk-ant-api03-AbCdEf_123-xyz_0123456789abcdefghijKLMNOP");
    const five = await sh(exec({ keySaved: true, spend: { ok: true, message: null }, promptCacheTtl: "5m" }), "claude -p hi");
    expect(five).toContain(`KEY=[${MAC_PROXY_TOKEN_PREFIX}`);
    expect(five).toContain("TTL=[5m]");
    const dflt = await sh(exec({ keySaved: true, spend: { ok: true, message: null } }), "claude -p hi");
    expect(dflt).toContain("TTL=[1h]");
  });
});

/**
 * Review round 3, finding 1: a literal read-deny matches the path at access time, so renaming a parent carried the
 * login out from under it (`mv ~/.claude ~/.cx && cat ~/.cx/.credentials.json`, then `CLAUDE_CONFIG_DIR=~/.cx claude`).
 * The sandbox now write-locks the login dirs themselves and read-denies a `.credentials.json` anywhere under home.
 * A stand-in login in a temp HOME, run through sandbox-exec with the generated profile; never the real ~/.claude.
 */
describe.runIf(process.platform === "darwin")("live: a login file can't be moved out from under the read-deny", () => {
  const LOGIN = "STANDIN-CLAUDE-LOGIN";
  const run = (command: string, opts = {}) => {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", ownDataSandboxProfile(userData, home, opts), "/bin/sh", "-c", command], { timeout: 10_000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home } });
    return `${r.stdout}${r.stderr}`;
  };
  beforeEach(() => {
    for (const d of [".claude", MAC_CLAUDE_CONFIG_DIR]) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
      fs.writeFileSync(path.join(home, d, ".credentials.json"), LOGIN);
    }
    fs.mkdirSync(path.join(home, "elsewhere", "deep"), { recursive: true });
    fs.writeFileSync(path.join(home, "elsewhere", "deep", ".credentials.json"), LOGIN);
  });
  const modes = [{}, { noLimits: true }, { handoffLite: true }];
  for (const m of modes) {
    it.each([
      ["rename ~/.claude", `mv "$HOME/.claude" "$HOME/.cx"; cat "$HOME/.cx/.credentials.json"`],
      ["rename ~/.synapse", `mv "$HOME/.synapse" "$HOME/.sx"; cat "$HOME/.sx/claude-mac/.credentials.json"`],
      ["rename ~/.synapse/claude-mac", `mv "$HOME/${MAC_CLAUDE_CONFIG_DIR}" "$HOME/.synapse/cm2"; cat "$HOME/.synapse/cm2/.credentials.json"`],
      ["a copy left elsewhere", `cat "$HOME/elsewhere/deep/.credentials.json"`],
      ["another case", `cat "$HOME/.CLAUDE/.CREDENTIALS.JSON"`],
      ["rename in another case", `mv "$HOME/.CLAUDE" "$HOME/.cy"; cat "$HOME/.cy/.credentials.json"`],
      ["a renamed login file", `mv "$HOME/.claude/.credentials.json" "$HOME/.claude/c.json"; cat "$HOME/.claude/c.json"`],
      ["a hard link", `ln "$HOME/.claude/.credentials.json" "$HOME/hl"; cat "$HOME/hl"`],
      ["a symlinked dir", `ln -s "$HOME/.claude" "$HOME/lnk"; cat "$HOME/lnk/.credentials.json"`],
    ])(`mode ${JSON.stringify(m)}: %s is denied`, (_n, cmd) => {
      const out = run(cmd, m);
      expect(out).not.toContain(LOGIN);
      expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8")).toBe(LOGIN);
      expect(fs.existsSync(path.join(home, MAC_CLAUDE_CONFIG_DIR, ".credentials.json"))).toBe(true);
    });
  }
  it("D3: an entry directly in ~/.synapse (the migration's trash name) can't be made, moved or swapped from inside", () => {
    const trash = path.join(home, ".synapse", ".synapse-retire-1-2-x.trash");
    fs.mkdirSync(trash);
    const out = run(`mv "${trash}" "$HOME/t2" && echo MOVED; ln -s "$HOME/.claude" "$HOME/.synapse/planted" && echo PLANTED; rmdir "${trash}" && echo GONE`);
    expect(out).not.toMatch(/MOVED|PLANTED|GONE/);
    expect(fs.lstatSync(trash).isDirectory()).toBe(true);
    expect(run(`echo x > "$HOME/${MAC_CLAUDE_CONFIG_DIR}/notes.txt" && echo WROTE`)).toContain("WROTE");
  });
  it("other files under ~/.claude stay readable and writable", () => {
    fs.writeFileSync(path.join(home, ".claude", "notes.txt"), "OK-NOTES");
    expect(run(`cat "$HOME/.claude/notes.txt"; echo x > "$HOME/.claude/new.txt" && echo WROTE`)).toMatch(/OK-NOTES[\s\S]*WROTE/);
  });
});
