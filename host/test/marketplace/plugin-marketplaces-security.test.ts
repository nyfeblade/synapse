import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PluginMarketplaces } from "../../marketplace/plugin-marketplaces";
import { McpRegistry } from "../../mcp/registry";
import { HostSettingsStore } from "../../store/host-settings";

type Plugin = { name: string; source: string };
function repoWith(plugins: Plugin[], extra?: (repo: string) => void): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-sec-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
  w(".claude-plugin/marketplace.json", JSON.stringify({ name: "Sec", plugins }));
  w("plugins/good/skills/water/SKILL.md", "---\nname: water\ndescription: d\n---\nbody\n");
  w("plugins/good/.mcp.json", JSON.stringify({ mcpServers: { g: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"] } } }));
  w("plugins/good/s.js", "//\n");
  extra?.(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
  return repo;
}

let dir: string;
let pm: PluginMarketplaces;
let reg: McpRegistry;
let secret: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-sec-h-"));
  secret = path.join(dir, "outside-secret.txt");
  fs.writeFileSync(secret, "TOP SECRET", { mode: 0o600 });
  reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1 });
  pm = new PluginMarketplaces({ dir: path.join(dir, "marketplaces"), managedDir: path.join(dir, "managed"), registry: reg, now: () => 9, allowFileUrls: true });
});

describe("plugin marketplaces hardening (P5 review C1)", () => {
  it("rejects a cloned marketplace that contains ANY symlink and leaves no clone behind", async () => {
    const repo = repoWith([{ name: "good", source: "./plugins/good" }], (r) => fs.symlinkSync(secret, path.join(r, "plugins/good/skills/water/leak.txt")));
    await expect(pm.add(`file://${repo}`)).rejects.toThrow(/symbolic link/i);
    expect(fs.readdirSync(path.join(dir, "marketplaces")).filter((f) => f !== "marketplaces.json")).toEqual([]);
  });

  it("a symlink planted after add is caught at install; no chmod follows it", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    fs.symlinkSync(secret, path.join(dir, "marketplaces", "sec", "plugins", "good", "skills", "water", "leak.txt"));
    await expect(pm.install("mkt:sec/good")).rejects.toThrow(/symbolic link/i);
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "managed", "skills", "good"))).toBe(false);
  });

  it("plugin names must match ^[a-z0-9][a-z0-9._-]*$ with no '..'", async () => {
    await pm.add(`file://${repoWith([
      { name: "good", source: "./plugins/good" },
      { name: "..", source: "./plugins/good" },
      { name: "a..b", source: "./plugins/good" },
      { name: "Bad Name", source: "./plugins/good" },
      { name: "x/y", source: "./plugins/good" },
    ])}`);
    expect(pm.list().map((p) => p.name)).toEqual(["good"]);
    await expect(pm.install("mkt:sec/..")).rejects.toThrow(/No plugin/);
  });

  it("a plugin source is realpath-checked against the repo", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }, { name: "moved", source: "./plugins/moved" }])}`);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-outside-"));
    fs.symlinkSync(outside, path.join(dir, "marketplaces", "sec", "plugins", "moved"));
    expect(pm.list().map((p) => p.name)).toEqual(["good"]);
  });

  it("SKILL.md is never written through a symlink", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    const dest = path.join(dir, "managed", "skills", "good", "skills", "water");
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(secret, path.join(dest, "SKILL.md"));
    await pm.install("mkt:sec/good");
    expect(fs.readFileSync(secret, "utf8")).toBe("TOP SECRET");
    expect(fs.lstatSync(path.join(dest, "SKILL.md")).isSymbolicLink()).toBe(false);
  });

  it("never removes anything outside the managed tree, even from a tampered installed record", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    await pm.install("mkt:sec/good");
    const file = path.join(dir, "marketplaces", "marketplaces.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-victim-"));
    s.installed["mkt:sec/good"].pluginDir = victim;
    s.installed["mkt:sec/good"].skills = [victim];
    fs.writeFileSync(file, JSON.stringify(s));
    const pm2 = new PluginMarketplaces({ dir: path.join(dir, "marketplaces"), managedDir: path.join(dir, "managed"), registry: reg, now: () => 9, allowFileUrls: true });
    await pm2.uninstall("mkt:sec/good");
    expect(fs.existsSync(victim)).toBe(true);
  });
});

describe("final secfix round 2 (ruling B): plugins and skills are staged in a host-owned tree the box can read, not write", () => {
  const hostPrivate = () => {
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-hostprivate-"));
    fs.mkdirSync(path.join(hp, "good"));
    fs.writeFileSync(path.join(hp, "good", "vault.key"), "KEY");
    fs.mkdirSync(path.join(hp, "water"));
    fs.writeFileSync(path.join(hp, "water", "token"), "TOKEN");
    return hp;
  };
  const snapshot = (p: string) => execFileSync("find", [p, "-print"]).toString().split("\n").sort().join("\n");
  const mode = (p: string) => fs.statSync(p).mode & 0o7777;

  it("install writes only under the managed tree: a skills plugin with a host-written manifest, and the plugin copy", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    await pm.install("mkt:sec/good");
    const m = path.join(dir, "managed");
    expect(JSON.parse(fs.readFileSync(path.join(m, "skills", "good", ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "good" });
    expect(fs.readFileSync(path.join(m, "skills", "good", "skills", "water", "SKILL.md"), "utf8")).toContain("source: plugin:good");
    expect(fs.existsSync(path.join(m, "skills", "good", ".mcp.json"))).toBe(false); // skills only: no servers, no hooks
    expect(fs.existsSync(path.join(m, "plugins", "good", "s.js"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "claude"))).toBe(false); // ~/.claude (box-owned) is never touched
    for (const d of [m, path.join(m, "skills"), path.join(m, "skills", "good"), path.join(m, "skills", "good", "skills", "water"), path.join(m, "plugins", "good")]) expect(mode(d), d).toBe(0o2750);
    expect(mode(path.join(m, "skills", "good", "skills", "water", "SKILL.md"))).toBe(0o640);
    expect(mode(path.join(m, "plugins", "good", "s.js"))).toBe(0o640);
    expect(pm.cliPlugins()).toEqual([path.join(m, "skills", "good")]);
    await pm.uninstall("mkt:sec/good");
    expect(fs.existsSync(path.join(m, "skills", "good"))).toBe(false);
    expect(fs.existsSync(path.join(m, "plugins", "good"))).toBe(false);
    expect(pm.cliPlugins()).toEqual([]);
  });

  it("an executable file keeps its x bit for the owner and group only (0750)", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }], (r) => { fs.writeFileSync(path.join(r, "plugins/good/run.sh"), "#!/bin/sh\n"); fs.chmodSync(path.join(r, "plugins/good/run.sh"), 0o775); })}`);
    await pm.install("mkt:sec/good");
    expect(mode(path.join(dir, "managed", "plugins", "good", "run.sh"))).toBe(0o750);
  });

  it("a box-side symlink swap of ~/.claude/skills or ~/.claude/plugins to hostPrivate can't make install or uninstall touch hostPrivate", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    const hp = hostPrivate();
    const before = snapshot(hp);
    fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
    fs.symlinkSync(hp, path.join(dir, "claude", "plugins"));
    fs.symlinkSync(hp, path.join(dir, "claude", "skills"));
    await pm.install("mkt:sec/good");
    await pm.install("mkt:sec/good"); // reinstall replaces its own staged copy only
    await pm.uninstall("mkt:sec/good");
    expect(snapshot(hp)).toBe(before);
    expect(fs.readFileSync(path.join(hp, "good", "vault.key"), "utf8")).toBe("KEY");
    expect(fs.readFileSync(path.join(hp, "water", "token"), "utf8")).toBe("TOKEN");
  });

  it("a legacy record pointing into the box-writable ~/.claude is never rm'd by the host (even if swapped to hostPrivate)", async () => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }])}`);
    await pm.install("mkt:sec/good");
    const hp = hostPrivate();
    const before = snapshot(hp);
    fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
    fs.symlinkSync(hp, path.join(dir, "claude", "skills"));
    const file = path.join(dir, "marketplaces", "marketplaces.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.installed["mkt:sec/good"] = { skills: [path.join(dir, "claude", "skills", "water")], serverIds: [], pluginDir: path.join(dir, "claude", "skills", "good") };
    fs.writeFileSync(file, JSON.stringify(s));
    const pm2 = new PluginMarketplaces({ dir: path.join(dir, "marketplaces"), managedDir: path.join(dir, "managed"), registry: reg, now: () => 9, allowFileUrls: true });
    await pm2.uninstall("mkt:sec/good");
    expect(snapshot(hp)).toBe(before);
    expect(pm2.isInstalled("mkt:sec/good")).toBe(false);
  });
});

describe("final secfix 4: a plugin can't declare a reserved MCP server id", () => {
  it.each(["google", "bot", "computer", "probe", "claude_ai_Gmail"])("install refuses a plugin declaring %s and copies nothing", async (sid) => {
    await pm.add(`file://${repoWith([{ name: "good", source: "./plugins/good" }], (r) => fs.writeFileSync(path.join(r, "plugins/good/.mcp.json"), JSON.stringify({ mcpServers: { [sid]: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/s.js"] } } })))}`);
    await expect(pm.install("mkt:sec/good")).rejects.toThrow(/reserved/i);
    expect(fs.existsSync(path.join(dir, "managed", "plugins", "good"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "managed", "skills", "good"))).toBe(false);
    expect(reg.list()).toEqual([]);
  });
});
