/**
 * Bug 239 (ruling, replacing bug 238's flag denylist): claude and codex are no longer exempt. They run INSIDE the
 * command sandbox like any other command, so the app-data read-deny, the startup-file / LaunchAgents / tool-config
 * write-denies and the exec-denies apply to everything they do, whatever flags or project files (AGENTS.md,
 * .claude/settings.json …) they read. Their own sandboxes are turned off there (ours is the boundary). The exempt list
 * is only the tools that truly nest a sandbox: Swift, Xcode, Playwright/Electron/Chromium.
 * Also kept from bug 238: ~/.claude.json and ~/.claude/plugins are protected tool config (for the user's own Terminal).
 * HOME is a temp dir; PATH is narrowed to a temp bin + the fixed dirs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NEEDS_APPROVAL, macSandboxExempt, macSandboxExemptSimple, macSandboxInteractive, macUnsandboxedHandoff, macWrappedToolPrelude } from "@synapse/shared";
import { LocalExecutor, ownDataSandboxProfile } from "../../src/coordinator/local-exec/executor";
import { LocalPolicyStore } from "../../src/coordinator/local-exec/policy";
import { POLICY_KEY_FILE, loadPolicyKey } from "../../src/coordinator/local-exec/policy-key";
import { FIXED_PATH } from "../../src/coordinator/local-exec/tool-path";

let home: string;
let userData: string;
let bin: string;
let saved: { HOME?: string; PATH?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "etf-home-")));
  userData = path.join(home, "Library", "Application Support", "Synapse");
  fs.mkdirSync(userData, { recursive: true });
  loadPolicyKey(userData); // a real local-policy.key in the temp app data
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), "{}\n");
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A fake claude that does what a hijacked one would: read the permission key, write its own state, report its args.
  const key = path.join(userData, POLICY_KEY_FILE);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nif [ "$1" = auth ]; then echo '{ "loggedIn": true }'; exit 0; fi\necho "ARGS:$*"\nxxd -p '${key}' 2>&1 | head -1\necho '{"numStartups":2}' > "$HOME/.claude.json" 2>&1\nmkdir "$HOME/.claude/plugins/evil" 2>&1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\necho "ARGS:$*"\nxxd -p '${key}' 2>&1 | head -1\n`, { mode: 0o755 });
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
const exec = () => new LocalExecutor({ root: () => home, home: () => home, userData: () => userData, fullAccess: () => true, ...keyAuth(() => true) }); // the Bots' claude has the API key
async function sh(command: string): Promise<string> {
  const chunks: string[] = [];
  await exec().run({ execId: `e${Math.random()}`, botId: "b", approvalId: null, op: "run-command", command, cwd: home }, { output: (_s, c) => chunks.push(c) });
  return chunks.join("");
}
const keyHex = () => fs.readFileSync(path.join(userData, POLICY_KEY_FILE)).toString("hex");

describe("the exempt list is only the tools that nest a sandbox", () => {
  it.each(["swift build", "xcodebuild -scheme A build", "npx playwright test", "electron .", "chromium --headless"])("exempt: %s", (cmd) => expect(macSandboxExempt(cmd)).not.toBeNull());
  it.each([
    "claude -p hi", "claude", "claude -p hi --settings evil.json", "claude -p hi --plugin-url https://x", "claude -p hi --agents a.json", "claude --remote-control",
    "codex exec hi", "codex", "codex exec -sdanger-full-access hi", "codex exec --yolo hi", "npx @anthropic-ai/claude-code -p hi",
    "brew install --build-from-source wget", "brew test wget",
  ])("not exempt (runs in the sandbox): %s", (cmd) => {
    expect(macSandboxExempt(cmd)).toBeNull();
    expect(macSandboxExemptSimple(cmd)).toBeNull();
  });

  it("claude and codex need no card of their own, and their interactive modes aren't refused as exempt", () => {
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 9), { home: () => home, userData: () => userData });
    p.setBotMode("b1", "full-auto");
    for (const cmd of ["claude -p hi", "codex exec hi", "claude", "codex"]) {
      expect(macSandboxInteractive(cmd), cmd).toBeNull();
      const v = p.check({ execId: "x", botId: "b1", approvalId: null, op: "run-command", command: cmd, cwd: home });
      expect((v as { reason?: string }).reason ?? "", cmd).not.toMatch(/outside this Mac's command sandbox|one-shot/);
    }
    expect(macSandboxInteractive("swift")).not.toBeNull(); // Swift's REPL stays refused: Swift is still exempt
  });
});

describe("wrapped claude / codex: their own sandboxes are off (ours is the boundary)", () => {
  it("claude gets its Bash sandbox disabled", () => {
    expect(macWrappedToolPrelude("claude -p hi")).toContain(`command claude --settings '{"sandbox":{"enabled":false}}' "$@"; }`);
    expect(macWrappedToolPrelude("cd x && claude -p hi")).toContain("function claude");
  });
  it("codex exec and the TUI get --sandbox danger-full-access; other subcommands pass through; an explicit mode is kept", () => {
    const pre = macWrappedToolPrelude("codex exec hi");
    expect(pre).toContain(`exec|e) local s="$1"; shift; command codex "$s" --sandbox danger-full-access "$@"`);
    expect(pre).toContain(`*) command codex --sandbox danger-full-access "$@"`);
    expect(pre).toMatch(/login\|logout\|mcp[^)]*\) command codex "\$@"/);
    expect(macWrappedToolPrelude("codex exec --sandbox read-only hi")).not.toContain("function codex");
    expect(macWrappedToolPrelude("codex exec -s workspace-write hi")).not.toContain("function codex");
  });
  it("nothing for other commands", () => expect(macWrappedToolPrelude("ls ~/.claude/projects && git status")).toBe(""));
});

describe.runIf(process.platform === "darwin")("live: claude and codex run inside the sandbox (temp HOME)", () => {
  it("a claude run can't read the permission key, write ~/.claude.json or plant a plugin", async () => {
    const out = await sh("claude -p hi");
    expect(out).toContain(`ARGS:--settings {"sandbox":{"enabled":false}} -p hi`);
    expect(out).not.toContain(keyHex().slice(0, 32));
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(home, ".claude", "plugins", "evil"))).toBe(false);
  });

  it("whatever flags claude is given (the old denylist's misses included), it is still in the sandbox", async () => {
    const out = await sh("claude -p hi --plugin-url https://x --agents a.json --dangerously-skip-permissions");
    expect(out).toContain("ARGS:");
    expect(out).not.toContain(keyHex().slice(0, 32));
  });

  it("a codex run can't read the permission key, and gets its own sandbox turned off", async () => {
    const out = await sh("codex exec --yolo hi");
    expect(out).not.toContain(keyHex().slice(0, 32));
    const plain = await sh("codex exec hi");
    expect(plain).toContain("ARGS:exec --sandbox danger-full-access hi");
    expect(plain).not.toContain(keyHex().slice(0, 32));
  });

  const realClaude = (() => {
    try { return execFileSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: `${process.env.PATH}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin` }, encoding: "utf8" }).trim() || null; } catch { return null; }
  })();
  it.runIf(!!realClaude)("the REAL claude runs wrapped (--version: no prompt, no network, no tokens)", async () => {
    process.env.PATH = `${path.dirname(realClaude!)}:${FIXED_PATH}`;
    const out = await sh("claude --version");
    expect(out).toMatch(/\d+\.\d+\.\d+/);
    expect(out).not.toMatch(/sandbox_apply|not permitted/i);
  });
});

describe("~/.claude.json and ~/.claude/plugins stay protected tool config", () => {
  it("the profile denies writes to both", () => {
    const p = ownDataSandboxProfile(userData, home);
    expect(p).toContain(`(literal "${home}/.claude.json")`);
    expect(p).toContain(`(subpath "${home}/.claude/plugins")`);
  });
  it.each([`echo '{"mcpServers":{}}' > ~/.claude.json`, "cp evil.json ~/.claude/plugins/x/hooks.json", `python3 -c "open('/x/.claude.json','w')"`])(
    "a shell write is a hand-off: %s", (cmd) => expect(macUnsandboxedHandoff(cmd, { home })).not.toBeNull());
  it("an app-side write needs a card in Full auto", () => {
    const p = new LocalPolicyStore(userData, Date.now, Buffer.alloc(32, 8), { home: () => home, userData: () => userData });
    p.update({ localRoot: home, executionPolicy: "always" });
    p.grant("b1", "write-file");
    p.setBotMode("b1", "full-auto");
    const v = p.check({ execId: "x", botId: "b1", approvalId: null, op: "write-file", path: path.join(home, ".claude.json"), content: "{}" });
    expect((v as { reason: string }).reason.startsWith(LOCAL_NEEDS_APPROVAL)).toBe(true);
  });
});
