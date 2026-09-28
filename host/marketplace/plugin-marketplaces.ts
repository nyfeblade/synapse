import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CATALOG_CATEGORIES, type CatalogCategory, type CatalogDetail, type PluginMarketplaceView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { McpRegistry } from "../mcp/registry";
import { isReservedMcpId } from "../mcp/reserved";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { slugify, withSourceMetadata } from "../util/text";
import type { PluginCatalogItem, PluginSource } from "./catalog";

export type GitRunner = (args: string[], cwd?: string) => Promise<void>;
export const realGit: GitRunner = async (args, cwd) => {
  await promisify(execFile)("git", args, { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
};

interface McpDecl { command?: string; args?: string[]; env?: Record<string, string>; type?: string; url?: string; headers?: Record<string, string> }
interface PluginDecl { name: string; source: string | { source: "github"; repo: string } | { source: "url"; url: string }; description?: string; category?: string }
interface Stored {
  marketplaces: { name: string; source: string; url: string; path: string; updatedAt: number; error: string | null }[];
  installed: Record<string, { skills: string[]; serverIds: string[]; pluginDir: string | null; skillsPlugin?: string | null }>;
}

export function normalizeSource(source: string, allowFile: boolean): string {
  const s = source.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return `https://github.com/${s}.git`;
  if (/^https:\/\/[^\s]+$/.test(s)) return s;
  if (allowFile && /^file:\/\/\//.test(s)) return s;
  throw new GatewayError("BAD_ARGS", "Use a GitHub owner/repo or an https git URL.");
}

export { withSourceMetadata } from "../util/text";

function toCategory(raw: string | undefined): CatalogCategory | null {
  if (!raw) return null;
  const r = raw.toLowerCase();
  return CATALOG_CATEGORIES.find((c) => c.toLowerCase() === r) ?? (/(dev|code|engineering)/.test(r) ? "Code" : /(data|analytics|database)/.test(r) ? "Data" : null);
}

/** P5 review C1: plugin names are plain slugs, never a path. */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export function validPluginName(n: unknown): n is string {
  return typeof n === "string" && n.length <= 100 && PLUGIN_NAME_RE.test(n) && !n.includes("..");
}

/** Walks with lstat and throws on ANY symbolic link (or other non-file/dir entry). */
export function assertNoLinks(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw new GatewayError("BAD_MARKETPLACE", `Plugin content contains a symbolic link (${path.basename(p)}); refused.`);
  if (st.isDirectory()) { for (const c of fs.readdirSync(p)) assertNoLinks(path.join(p, c)); return; }
  if (!st.isFile()) throw new GatewayError("BAD_MARKETPLACE", `Plugin content contains a special file (${path.basename(p)}); refused.`);
}

/** Final secfix round 2 (ruling B): the managed tree is bothost:bots — dirs 2750, files 0640 (0750 if executable):
 *  the box (group bots) can read it and run a server script, never write it. */
function chmodTree(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  fs.chmodSync(p, st.isDirectory() ? 0o2750 : st.mode & 0o111 ? 0o750 : 0o640);
  if (st.isDirectory()) for (const c of fs.readdirSync(p)) chmodTree(path.join(p, c));
}

const MANAGED_DIR_MODE = 0o2750;

function inside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Removes p only when it is strictly inside one of the allowed roots. */
function rmInside(roots: string[], p: string): void {
  if (roots.some((r) => inside(r, p))) fs.rmSync(p, { recursive: true, force: true });
}

function writeNoFollow(file: string, text: string): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o664);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

export class PluginMarketplaces implements PluginSource {
  private file: string;
  private s: Stored;
  private git: GitRunner;

  constructor(private d: {
    dir: string; registry: McpRegistry; now(): number; git?: GitRunner; allowFileUrls?: boolean; onChange?(): void;
    /**
     * Final secfix round 2 (ruling B): the host-owned tree (e.g. /var/lib/bots/cc-managed, bothost:bots 2750) where
     * installs and uninstalls happen. The box can read it but never write it, so there is no verify-then-use race.
     * <managedDir>/plugins/<name> is the plugin copy (${CLAUDE_PLUGIN_ROOT} for its command servers);
     * <managedDir>/skills/<name> is a skills-only plugin (host-written manifest) the Bot CLI loads via --plugin-dir.
     */
    managedDir: string;
  }) {
    fs.mkdirSync(d.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(d.dir, "marketplaces.json");
    this.s = readJson<Stored>(this.file, { marketplaces: [], installed: {} });
    this.git = d.git ?? realGit;
  }

  marketplaces(): PluginMarketplaceView[] {
    return this.s.marketplaces.map((m) => ({ name: m.name, source: m.source, pluginCount: this.plugins(m.name).length, updatedAt: m.updatedAt, error: m.error }));
  }

  async add(source: string): Promise<PluginMarketplaceView> {
    const url = normalizeSource(source, !!this.d.allowFileUrls);
    const tmp = path.join(this.d.dir, `.clone-${this.d.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await this.git(["clone", "--depth", "1", url, tmp]);
    try { assertNoLinks(tmp); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    const manifest = readJson<{ name?: string } | null>(path.join(tmp, ".claude-plugin", "marketplace.json"), null);
    if (!manifest?.name) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new GatewayError("BAD_MARKETPLACE", "That repository has no .claude-plugin/marketplace.json.");
    }
    const name = slugify(manifest.name);
    const dest = path.join(this.d.dir, name);
    if (!name || !inside(this.d.dir, dest)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new GatewayError("BAD_MARKETPLACE", "Bad marketplace name."); }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    this.s.marketplaces = [...this.s.marketplaces.filter((m) => m.name !== name), { name, source, url, path: dest, updatedAt: this.d.now(), error: null }];
    this.save();
    return this.marketplaces().find((m) => m.name === name)!;
  }

  remove(name: string): void {
    for (const id of Object.keys(this.s.installed).filter((i) => i.startsWith(`mkt:${name}/`))) void this.uninstall(id).catch(() => undefined);
    const m = this.s.marketplaces.find((x) => x.name === name);
    if (m) rmInside([this.d.dir], m.path);
    this.s.marketplaces = this.s.marketplaces.filter((x) => x.name !== name);
    this.save();
  }

  list(): PluginCatalogItem[] {
    return this.s.marketplaces.flatMap((m) =>
      this.plugins(m.name).map((p) => ({ id: `mkt:${m.name}/${p.name}`, name: p.name, description: p.description ?? "", category: toCategory(p.category), toolCount: undefined, marketplace: m.name })),
    );
  }

  isInstalled(id: string): boolean { return !!this.s.installed[id]; }

  hasCommandServer(id: string): boolean {
    const root = this.pluginRoot(id);
    return !!root && Object.values(this.mcpDecls(root)).some((x) => !!x.command);
  }

  detail(id: string): CatalogDetail | null {
    const item = this.list().find((p) => p.id === id);
    const root = this.pluginRoot(id);
    if (!item || !root) return null;
    const skills = fs.existsSync(path.join(root, "skills")) ? fs.readdirSync(path.join(root, "skills")) : [];
    return { longDescription: item.description, tools: [...Object.keys(this.mcpDecls(root)).map((s) => `${s} (MCP server)`), ...skills.map((s) => `${s} (skill)`)], homepage: null, sourceLabel: `Plugin from ${item.marketplace}` };
  }

  async install(id: string): Promise<{ serverIds: string[] }> {
    const root = this.pluginRoot(id);
    if (!root) throw new GatewayError("NOT_FOUND", `No plugin ${id}`, 404);
    const pluginName = id.split("/").pop()!;
    if (!validPluginName(pluginName)) throw new GatewayError("NOT_FOUND", `No plugin ${id}`, 404);
    assertNoLinks(root);
    const skills: string[] = [];
    const skillsSrc = path.join(root, "skills");
    const decls = this.mcpDecls(root);
    // Final secfix item 4: a plugin can't take a server id the app owns; refused before anything is copied.
    const reserved = Object.keys(decls).find((n) => isReservedMcpId(n));
    if (reserved) throw new GatewayError("BAD_MARKETPLACE", `This plugin declares the reserved server name “${reserved.slice(0, 60)}”; refused.`);
    const needsPluginDir = Object.values(decls).some((x) => x.command);
    const skillsBase = this.managed("skills");
    const pluginsBase = this.managed("plugins");
    // Stage everything in a fresh dir inside the managed tree, then swap it in (a reader never sees half a plugin).
    let skillsPlugin: string | null = null;
    if (fs.existsSync(skillsSrc)) {
      const stage = this.stageDir(skillsBase, pluginName);
      const names = fs.readdirSync(skillsSrc).filter((sk) => validPluginName(sk) && fs.existsSync(path.join(skillsSrc, sk, "SKILL.md")));
      this.staging(stage, () => {
        for (const sk of names) {
          const dest = path.join(stage, "skills", sk);
          fs.cpSync(path.join(skillsSrc, sk), dest, { recursive: true, verbatimSymlinks: true });
          assertNoLinks(dest);
          const md = path.join(dest, "SKILL.md");
          writeNoFollow(md, withSourceMetadata(fs.readFileSync(md, "utf8"), `plugin:${pluginName}`));
        }
      });
      if (names.length) {
        fs.mkdirSync(path.join(stage, ".claude-plugin"));
        writeNoFollow(path.join(stage, ".claude-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "0.0.0", description: `Skills from the ${pluginName} plugin` }, null, 2));
        skillsPlugin = this.swapIn(skillsBase, pluginName, stage);
        for (const sk of names) skills.push(path.join(skillsPlugin, "skills", sk));
      } else fs.rmSync(stage, { recursive: true, force: true });
    }
    let pluginDir: string | null = null;
    if (needsPluginDir) {
      const stage = this.stageDir(pluginsBase, pluginName);
      this.staging(stage, () => {
        fs.cpSync(root, stage, { recursive: true, verbatimSymlinks: true });
        assertNoLinks(stage);
      });
      pluginDir = this.swapIn(pluginsBase, pluginName, stage);
    }
    const sub = (v: string) => (pluginDir ? v.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir) : v);
    const serverIds: string[] = [];
    for (const [name, x] of Object.entries(decls)) {
      const s = x.command
        ? this.d.registry.add({ name, command: sub(x.command), args: (x.args ?? []).map(sub), env: Object.fromEntries(Object.entries(x.env ?? {}).map(([k, v]) => [k, sub(v)])) }, "marketplace", id)
        : this.d.registry.add({ name, url: x.url!, headers: x.headers }, "marketplace", id);
      serverIds.push(s.id);
    }
    this.s.installed[id] = { skills, serverIds, pluginDir, skillsPlugin };
    this.save();
    return { serverIds };
  }

  async uninstall(id: string): Promise<void> {
    const rec = this.s.installed[id];
    if (!rec) return;
    for (const sid of rec.serverIds) if (this.d.registry.get(sid)) this.d.registry.remove(sid);
    // Ruling B: only paths directly inside the managed tree are removed. A legacy record that points into the
    // box-writable ~/.claude is left alone (the host never rm's there).
    if (rec.skillsPlugin) this.rmManaged("skills", rec.skillsPlugin);
    if (rec.pluginDir) this.rmManaged("plugins", rec.pluginDir);
    delete this.s.installed[id];
    this.save();
  }

  /** Ruling B: the skills plugins the Bot CLI loads (SDK `plugins`, i.e. --plugin-dir), one per installed plugin. */
  cliPlugins(): string[] {
    const base = path.join(this.d.managedDir, "skills");
    return Object.values(this.s.installed).map((r) => r.skillsPlugin ?? null)
      .filter((p): p is string => !!p && path.dirname(p) === base && fs.existsSync(path.join(p, ".claude-plugin", "plugin.json"))).sort();
  }

  /** <managedDir>/<kind>, created 2750 (bothost:bots via the setgid root that provision.sh makes). */
  private managed(kind: "skills" | "plugins"): string {
    const p = path.join(this.d.managedDir, kind);
    fs.mkdirSync(p, { recursive: true, mode: MANAGED_DIR_MODE });
    fs.chmodSync(this.d.managedDir, MANAGED_DIR_MODE);
    fs.chmodSync(p, MANAGED_DIR_MODE);
    return p;
  }

  private stageDir(base: string, name: string): string {
    const stage = path.join(base, `.stage-${name}-${this.d.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(stage, { mode: MANAGED_DIR_MODE });
    return stage;
  }

  /** Runs fill(); a failure removes the half-built stage and rethrows. */
  private staging(stage: string, fill: () => void): void {
    try { fill(); } catch (e) { fs.rmSync(stage, { recursive: true, force: true }); throw e; }
  }

  /** Replaces <base>/<name> with the staged dir. */
  private swapIn(base: string, name: string, stage: string): string {
    chmodTree(stage);
    const dest = path.join(base, name);
    if (!inside(base, dest) || path.dirname(dest) !== base) throw new GatewayError("NOT_FOUND", `No plugin ${name}`, 404);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    return dest;
  }

  private rmManaged(kind: "skills" | "plugins", p: string): void {
    const base = path.join(this.d.managedDir, kind);
    if (path.dirname(path.resolve(p)) === base && inside(base, p)) fs.rmSync(p, { recursive: true, force: true });
  }

  private plugins(marketplace: string): PluginDecl[] {
    const m = this.s.marketplaces.find((x) => x.name === marketplace);
    if (!m) return [];
    const list = readJson<{ plugins?: PluginDecl[] }>(path.join(m.path, ".claude-plugin", "marketplace.json"), {}).plugins ?? [];
    return list.filter((p) => validPluginName(p.name) && this.resolveLocal(m.path, p) !== null);
  }

  /** v1 installs plugins whose source is a path inside the marketplace repo; other source kinds are listed by name only after a clone step. */
  private resolveLocal(repo: string, p: PluginDecl): string | null {
    if (typeof p.source !== "string") return null;
    const abs = path.resolve(repo, p.source);
    if (!abs.startsWith(repo + path.sep) || !fs.existsSync(abs)) return null;
    try {
      const realRepo = fs.realpathSync(repo);
      const real = fs.realpathSync(abs);
      return real.startsWith(realRepo + path.sep) && real === path.join(realRepo, path.relative(repo, abs)) ? abs : null;
    } catch { return null; }
  }

  private pluginRoot(id: string): string | null {
    const m = /^mkt:([^/]+)\/(.+)$/.exec(id);
    if (!m) return null;
    const mk = this.s.marketplaces.find((x) => x.name === m[1]);
    const p = mk && this.plugins(mk.name).find((x) => x.name === m[2]);
    return mk && p ? this.resolveLocal(mk.path, p) : null;
  }

  private mcpDecls(root: string): Record<string, McpDecl> {
    const fromFile = readJson<{ mcpServers?: Record<string, McpDecl> }>(path.join(root, ".mcp.json"), {}).mcpServers ?? {};
    const manifest = readJson<{ mcpServers?: Record<string, McpDecl> | string }>(path.join(root, ".claude-plugin", "plugin.json"), {});
    const inline = typeof manifest.mcpServers === "object" ? manifest.mcpServers : {};
    return Object.fromEntries(Object.entries({ ...fromFile, ...inline }).filter(([, x]) => !!x.command || (!!x.url && /^https:\/\//.test(x.url))));
  }

  private save(): void {
    writeJsonAtomic(this.file, this.s, 0o600);
    this.d.onChange?.();
  }
}
