import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, CATALOG_CATEGORIES, LIMITS5, STR5, STRG, type GoogleStatusView, type CatalogAuthor, type CatalogCategory, type CatalogDetail, type CatalogEntry, type CatalogSearchResult, type CatalogState, type MarketplaceView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { McpServices } from "../mcp/module";
import type { CatalogIndex } from "./catalog-index";

const TEAM: CatalogAuthor = { name: `${APP_NAME} Team` };

export interface CuratedEntry { id: string; name: string; description: string; category: CatalogCategory; via: "remote" | "google"; url?: string; homepage?: string; featured?: boolean; action?: "add" | "connect"; tools?: string[]; logo?: string | null }
import type { PluginSource, TemplateSource } from "../phase5/types";
export type { PluginCatalogItem, PluginSource, TemplateCatalogItem, TemplateSource } from "../phase5/types";

export function loadCurated(file = path.join(path.dirname(fileURLToPath(import.meta.url)), "curated.json")): CuratedEntry[] {
  const all = JSON.parse(fs.readFileSync(file, "utf8")) as CuratedEntry[];
  const verified = path.join(path.dirname(file), "curated.verified.json");
  if (!fs.existsSync(verified)) return all;
  const bad = new Set((JSON.parse(fs.readFileSync(verified, "utf8")) as { id: string; ok: boolean }[]).filter((r) => !r.ok).map((r) => r.id));
  return all.filter((e) => !bad.has(e.id));
}

const byName = (a: CatalogEntry, b: CatalogEntry) => a.name.localeCompare(b.name);

export class Catalog {
  constructor(private d: { curated: CuratedEntry[]; mcp: McpServices; plugins(): PluginSource | null; templates(): TemplateSource | null; index: CatalogIndex; onChange?(): void; google?(): GoogleStatusView }) {}

  /** ORIG-GOOGLE: Gmail, Calendar and Drive are the app's own built-in connector (Connect Google sheet). */
  private googleState(): CatalogState {
    const st = this.d.google?.().state;
    return st === "connected" ? "connected" : st === "needs-reconnect" ? "needs-auth" : st === "waiting" ? "waiting-auth" : "available";
  }

  entries(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const c of this.d.curated) {
      if (c.via === "google") {
        out.push({ id: c.id, kind: "plugin", source: "google", name: c.name, description: c.description, category: c.category, logo: c.logo ?? null, action: "connect", state: this.googleState(), featured: c.featured, toolCount: c.tools?.length });
        continue;
      }
      out.push({ id: c.id, kind: "plugin", source: "curated", name: c.name, description: c.description, category: c.category, logo: c.logo ?? null, action: c.action ?? "add", state: this.remoteState(c.id, c.action ?? "add"), featured: c.featured, toolCount: c.tools?.length });
    }
    for (const p of this.d.plugins()?.list() ?? []) {
      const src = this.d.plugins()!;
      out.push({ id: p.id, kind: "plugin", source: "marketplace", name: p.name, description: p.description, category: p.category, logo: null, action: "add", state: src.isInstalled(p.id) ? this.pluginState(p.id) : "available", toolCount: p.toolCount });
    }
    for (const t of this.d.templates()?.list() ?? []) {
      out.push({ id: t.id, kind: "bot-template", source: t.source, name: t.name, description: t.description, category: t.category, logo: null, action: "add", author: t.author ?? TEAM, state: t.added ? "added" : "available", featured: t.featured });
    }
    return out;
  }

  get(id: string): CatalogEntry | undefined { return this.entries().find((e) => e.id === id); }

  view(): MarketplaceView {
    const all = this.entries();
    const plugins = all.filter((e) => e.kind === "plugin");
    const installed = plugins.filter((e) => e.state !== "available" && e.state !== "unavailable");
    const custom = this.d.mcp.registry.list().filter((s) => s.source === "custom");
    const templates = all.filter((e) => e.kind === "bot-template");
    let forYou: MarketplaceView["forYou"] = null;
    for (const inst of [...installed].sort(byName)) {
      const recs = plugins.filter((e) => e.state === "available" && e.category && e.category === inst.category).sort(byName).slice(0, LIMITS5.forYouMax);
      if (recs.length) { forYou = { because: inst.name, entries: recs }; break; }
    }
    return {
      installed: { count: installed.length + custom.length, logos: [...installed.map((e) => ({ name: e.name, logo: e.logo })), ...custom.map((s) => ({ name: s.name, logo: null }))].slice(0, 4) },
      featuredBots: templates.filter((e) => e.featured && e.source === "local-template").slice(0, 4),
      forYou,
      fromTeam: templates.filter((e) => e.source === "starter"),
      featuredPlugins: plugins.filter((e) => e.featured).slice(0, 4),
      categories: CATALOG_CATEGORIES.map((name) => {
        const entries = plugins.filter((e) => e.category === name).sort(byName);
        return { name, entries: entries.slice(0, LIMITS5.categoryPreview), total: entries.length };
      }).filter((c) => c.total > 0),
    };
  }

  search(q: string, limit = 20): CatalogSearchResult {
    const all = new Map(this.entries().map((e) => [e.id, e]));
    const hits = this.d.index.search(q, limit).map((id) => all.get(id)).filter((e): e is CatalogEntry => !!e);
    return { plugins: hits.filter((e) => e.kind === "plugin"), bots: hits.filter((e) => e.kind === "bot-template") };
  }

  detail(id: string): CatalogDetail {
    const c = this.d.curated.find((x) => x.id === id);
    if (c) {
      // The built-in Google connector is the one connector that is not account-wide: connecting the account is
      // only half of it, and each Bot has its own Google switch.
      const longDescription = c.via === "google" ? `${c.description}. ${STRG.perBotNote}` : c.description;
      return { longDescription, tools: c.tools ?? this.toolNames(id), homepage: c.homepage ?? null, sourceLabel: c.via === "google" ? "Built-in Google connector" : "Remote MCP server" };
    }
    const p = this.d.plugins()?.detail(id);
    if (p) return p;
    const e = this.get(id);
    if (!e) throw new GatewayError("NOT_FOUND", `No catalog entry ${id}`, 404);
    return { longDescription: e.description, tools: [], homepage: null, sourceLabel: e.kind === "bot-template" ? "Bot template" : "Plugin" };
  }

  async install(id: string): Promise<{ entry: CatalogEntry; serverIds: string[]; needsAuth: boolean; openUrl: string | null }> {
    const e = this.get(id);
    if (!e) throw new GatewayError("NOT_FOUND", `No catalog entry ${id}`, 404);
    if (e.kind === "bot-template") throw new GatewayError("BAD_ARGS", "Use Add Bot to import a template.");
    if (e.state === "unavailable") throw new GatewayError("UNAVAILABLE", `${STR5.notAvailable}.`, 409);
    // The built-in Google connector connects from its own sheet (Connect Google); nothing to install.
    if (e.source === "google") return { entry: e, serverIds: [], needsAuth: false, openUrl: null };
    let serverIds: string[];
    if (e.source === "curated") {
      const c = this.d.curated.find((x) => x.id === id)!;
      const existing = this.d.mcp.registry.byCatalogId(id);
      serverIds = existing.length ? existing.map((s) => s.id) : [this.d.mcp.registry.add({ name: c.name, url: c.url! }, "curated", id).id];
    } else {
      serverIds = (await this.d.plugins()!.install(id)).serverIds;
    }
    const statuses = await Promise.all(serverIds.filter((s) => this.d.mcp.registry.get(s)?.kind === "remote").map((s) => this.d.mcp.pool.ensure(s)));
    this.refresh();
    return { entry: this.get(id)!, serverIds, needsAuth: statuses.some((s) => s === "needs-auth"), openUrl: null };
  }

  async uninstall(id: string): Promise<void> {
    const e = this.get(id);
    if (!e || e.source === "google") return; // disconnecting Google is in its sheet
    if (e.source === "marketplace") await this.d.plugins()?.uninstall(id);
    for (const s of this.d.mcp.registry.byCatalogId(id)) {
      await this.d.mcp.pool.restart(s.id);
      this.d.mcp.oauth.forget(s.id);
      this.d.mcp.registry.remove(s.id);
    }
    this.refresh();
  }

  refresh(): void {
    this.d.index.rebuild(this.entries());
    this.d.onChange?.();
  }

  private remoteState(catalogId: string, action: "add" | "connect"): CatalogState {
    const servers = this.d.mcp.registry.byCatalogId(catalogId);
    if (!servers.length) return "available";
    const st = this.d.mcp.oauth.pendingFor(servers[0]!.id) ? "waiting-auth" : this.d.mcp.pool.status(servers[0]!.id);
    if (st === "needs-auth" || st === "waiting-auth") return st;
    // Failed DCR / connect is a sign-in problem, not a finished install. Mapping it to
    // "installed" made GitHub show as Added/Connected with no Authorize and 0 tools.
    if (st === "failed") return "needs-auth";
    return st === "connected" && action === "connect" ? "connected" : "installed";
  }

  private pluginState(id: string): CatalogState {
    const remote = this.d.mcp.registry.byCatalogId(id).filter((s) => s.kind === "remote");
    return remote.some((s) => this.d.mcp.pool.status(s.id) === "needs-auth") ? "needs-auth" : "installed";
  }

  private toolNames(id: string): string[] {
    return this.d.mcp.registry.byCatalogId(id).flatMap((s) => [...this.d.mcp.pool.toolDescriptions(s.id).keys()]);
  }
}
