/**
 * Bug 240 (ruling): a wrapped claude gets its own Synapse-owned config dir (CLAUDE_CONFIG_DIR = ~/.synapse/claude-mac,
 * 0700), writable inside the sandbox and never read by the user's own Terminal claude; the user's ~/.claude and
 * ~/.claude.json stay protected. That dir starts signed out (checked read-only: `claude auth status` with a fresh
 * CLAUDE_CONFIG_DIR reports loggedIn false), so an unsigned wrapped run stops with a clear sign-in message.
 * HOME is a temp dir; PATH is narrowed to a temp bin (with a fake claude) + the fixed dirs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAC_CLAUDE_API_KEY_MSG, macUnsandboxedHandoff } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let bin: string;
let saved: { HOME?: string; PATH?: string };
let keySaved = false; // the Bots' claude signs in with the API key (a per-run proxy token), never a Claude login
const fakeClaude = (loggedIn: boolean) => (keySaved = loggedIn, fs.writeFileSync(path.join(bin, "claude"), [
  "#!/bin/sh",
  `if [ "$1" = auth ]; then echo '{ "loggedIn": ${loggedIn} }'; exit 0; fi`,
  `echo "CONFIG_DIR=$CLAUDE_CONFIG_DIR"`,
  `echo '{"numStartups":3}' > "$CLAUDE_CONFIG_DIR/.claude.json" && echo OWN-WRITE-OK`,
  `echo '{"hacked":1}' > "$HOME/.claude.json" 2>/dev/null || echo USER-WRITE-DENIED`,
  `echo '{"hooks":{}}' > "$CLAUDE_CONFIG_DIR/settings.json" 2>/dev/null || echo OWN-SETTINGS-DENIED`,
  "",
].join("\n"), { mode: 0o755 }));

beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ccd-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), "{}\n");
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${FIXED_PATH}`;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The API key is the only sign-in: the host says a key is saved (or not), and the key proxy hands out a stand-in token. */
const keyAuth = (keySaved: () => boolean) => ({
  claudeAuth: async () => ({ keySaved: keySaved(), spend: { ok: true, message: null } }),
  keyProxy: { grant: async () => ({ baseUrl: "http://127.0.0.1:9", token: "sk-ant-api03-synproxy-test", release: () => {} }) },
});
const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, ...keyAuth(() => keySaved) });
async function sh(command: string): Promise<string> {
  const chunks: string[] = [];
  await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return chunks.join("");
}
const own = () => path.join(home, ".synapse", "claude-mac");

describe("the Synapse claude dir is protected where it matters", () => {
  it("its settings, hooks and plugins are tool config (write-denied, hand-off); its .claude.json is not", () => {
    const p = ownDataSandboxProfile(userData, home);
    expect(p).toContain(`(literal "${own()}/settings.json")`);
    expect(p).toContain(`(subpath "${own()}/hooks")`);
    expect(p).toContain(`(subpath "${own()}/plugins")`);
    expect(p).not.toContain(`(literal "${own()}/.claude.json")`);
    expect(p).toContain(`(literal "${home}/.claude.json")`);
    expect(macUnsandboxedHandoff("echo x > ~/.synapse/claude-mac/settings.json", { home })).not.toBeNull();
  });
});

describe.runIf(process.platform === "darwin")("live (temp HOME)", () => {
  it("wrapped claude gets CLAUDE_CONFIG_DIR (created 0700), writes its own .claude.json there, and can't touch the user's", async () => {
    fakeClaude(true);
    const out = await sh("claude -p hi");
    expect(out).toContain(`CONFIG_DIR=${own()}\n`);
    expect(out).toContain("OWN-WRITE-OK");
    expect(out).toContain("USER-WRITE-DENIED");
    expect(out).toContain("OWN-SETTINGS-DENIED");
    expect(fs.readFileSync(path.join(own(), ".claude.json"), "utf8")).toContain("numStartups");
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe("{}\n");
    expect(fs.statSync(own()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(own())).mode & 0o777).toBe(0o700);
  });

  it("the env is set only for a run that uses claude", async () => {
    fakeClaude(true);
    const out = await sh("echo \"DIR=[$CLAUDE_CONFIG_DIR]\"");
    expect(out).toContain("DIR=[]");
    expect(fs.existsSync(own())).toBe(false);
  });

  it("no API key saved yet: the run stops with the API-key message, and claude never starts", async () => {
    fakeClaude(false);
    const out = await sh("claude -p hi");
    expect(out).toContain(MAC_CLAUDE_API_KEY_MSG);
    expect(out).toContain("Settings → Account");
    expect(out).not.toMatch(/^CONFIG_DIR=/m); // the fake claude never ran
    expect(out).not.toContain("OWN-WRITE-OK");
  });

  it("`claude --version` and `claude auth …` skip the sign-in check", async () => {
    fakeClaude(false);
    const out = await sh("claude --version");
    expect(out).not.toContain(MAC_CLAUDE_API_KEY_MSG);
  });
});
