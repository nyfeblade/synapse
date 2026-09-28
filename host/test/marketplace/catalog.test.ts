import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Catalog, type CuratedEntry, type TemplateSource } from "../../marketplace/catalog";
import { CatalogIndex } from "../../marketplace/catalog-index";
import { createMcpServices, mcpServerViews } from "../../mcp/module";
import { HostSettingsStore } from "../../store/host-settings";

const curated: CuratedEntry[] = [
  { id: "curated:gmail", name: "Gmail", description: "Read, search and draft email", category: "Productivity", via: "google", featured: true },
  { id: "curated:linear", name: "Linear", description: "Issues and projects", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" },
  { id: "curated:sentry", name: "Sentry", description: "Errors and performance", category: "Code", via: "remote", url: "https://mcp.sentry.dev/mcp" },
  { id: "curated:vercel", name: "Vercel", description: "Deployments", category: "Code", via: "remote", url: "https://mcp.vercel.com" },
  { id: "curated:stripe", name: "Stripe", description: "Payments", category: "Finance", via: "remote", url: "https://mcp.stripe.com" },
  { id: "curated:vault", name: "Test Vault", description: "Share a dedicated vault", category: "Login and Credential Management", via: "remote", url: "https://vault.example/mcp", action: "connect" },
];
const templates: TemplateSource = {
  list: () => [
    { id: "starter:chief-of-staff", source: "starter", name: "Chief of Staff", description: "Runs your week", category: null, featured: false, added: true },
    { id: "tpl:t1", source: "local-template", name: "Trip Desk", description: "Plans trips", author: { name: "Ana" }, category: null, featured: true, added: false },
  ],
};

let catalog: Catalog;
let mcp: ReturnType<typeof createMcpServices>;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-"));
  const ctx = { cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: () => {} }, settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({}) } as never;
  mcp = createMcpServices(ctx, { connect: async () => { throw new Error("401 Unauthorized"); } });
  catalog = new Catalog({ curated, mcp, plugins: () => null, templates: () => templates, index: new CatalogIndex(path.join(dir, "catalog-index.db")) });
});

describe("Catalog (D8-A sources)", () => {
  it("merges curated, built-in Google and template entries with states and actions", () => {
    const byId = Object.fromEntries(catalog.entries().map((e) => [e.id, e]));
    expect(byId["curated:gmail"]).toMatchObject({ source: "google", state: "available", action: "connect" });
    expect(byId["curated:linear"]).toMatchObject({ source: "curated", state: "available", action: "add", kind: "plugin" });
    expect(byId["curated:vault"]).toMatchObject({ action: "connect" });
    expect(byId["starter:chief-of-staff"]).toMatchObject({ kind: "bot-template", state: "added", author: { name: "Synapse Team" } });
    expect(byId["tpl:t1"]).toMatchObject({ kind: "bot-template", state: "available", author: { name: "Ana" } });
  });

  it("installing a remote entry registers it and reports needsAuth", async () => {
    const r = await catalog.install("curated:linear");
    expect(r).toMatchObject({ needsAuth: true, openUrl: null, serverIds: ["linear"] });
    expect(catalog.get("curated:linear")!.state).toBe("needs-auth");
    await catalog.uninstall("curated:linear");
    expect(catalog.get("curated:linear")!.state).toBe("available");
  });

  it("builds the Marketplace view: installed logos, For you by shared category (PLG-11), team templates, categories of 4", async () => {
    await catalog.install("curated:linear");
    const v = catalog.view();
    expect(v.installed.count).toBe(1);
    expect(v.forYou).toEqual({ because: "Linear", entries: [expect.objectContaining({ name: "Sentry" }), expect.objectContaining({ name: "Vercel" })] });
    expect(v.fromTeam.map((e) => e.name)).toEqual(["Chief of Staff"]);
    expect(v.featuredBots.map((e) => e.name)).toEqual(["Trip Desk"]);
    expect(v.featuredPlugins.map((e) => e.name)).toEqual(["Gmail"]);
    expect(v.categories.find((c) => c.name === "Code")).toMatchObject({ total: 3 });
    expect(v.categories.find((c) => c.name === "Sales")).toBeUndefined();
    expect(v).not.toHaveProperty("claudeAi");
  });

  it("searches with FTS prefixes, grouped into plugins and Bots (ORIG-18 §18.8)", () => {
    catalog.refresh();
    expect(catalog.search("lin").plugins.map((e) => e.name)).toEqual(["Linear"]);
    expect(catalog.search("trip").bots.map((e) => e.name)).toEqual(["Trip Desk"]);
    expect(catalog.search("errors perf").plugins.map((e) => e.name)).toEqual(["Sentry"]);
    expect(catalog.search("   ")).toEqual({ plugins: [], bots: [] });
  });
});

describe("Added 11:20: the curated catalog", () => {
  it("monday.com uses its /mcp endpoint (the /sse URL answers 401 with no Bearer challenge)", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const monday = loadCurated().find((c) => c.id === "curated:monday")!;
    expect(monday.url).toBe("https://mcp.monday.com/mcp");
  });
  it("GitHub is a curated remote MCP, the official Connect URL, not a custom-server paste", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const github = loadCurated().find((c) => c.id === "curated:github");
    expect(github).toMatchObject({
      name: "GitHub",
      category: "Code",
      via: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      homepage: "https://github.com",
    });
  });
  it("Slack is a curated remote MCP, the official Connect URL, not a custom-server paste", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const slack = loadCurated().find((c) => c.id === "curated:slack");
    expect(slack).toMatchObject({
      name: "Slack",
      category: "Support",
      via: "remote",
      url: "https://mcp.slack.com/mcp",
      homepage: "https://slack.com",
    });
  });
  it("ships official remote MCP URLs for the next catalog wave", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const byId = Object.fromEntries(loadCurated().map((c) => [c.id, c]));
    expect(byId["curated:gitlab"]).toMatchObject({ name: "GitLab", category: "Code", via: "remote", url: "https://gitlab.com/api/v4/mcp", homepage: "https://gitlab.com" });
    expect(byId["curated:figma"]).toMatchObject({ name: "Figma", category: "Research", via: "remote", url: "https://mcp.figma.com/mcp", homepage: "https://figma.com" });
    expect(byId["curated:canva"]).toMatchObject({ name: "Canva", category: "Research", via: "remote", url: "https://mcp.canva.com/mcp", homepage: "https://canva.com" });
    expect(byId["curated:mobbin"]).toMatchObject({ name: "Mobbin", category: "Research", via: "remote", url: "https://api.mobbin.com/mcp", homepage: "https://mobbin.com" });
    expect(byId["curated:hubspot"]).toMatchObject({ name: "HubSpot", category: "Sales", via: "remote", url: "https://mcp.hubspot.com", homepage: "https://hubspot.com" });
    expect(byId["curated:amplemarket"]).toMatchObject({ name: "Amplemarket", category: "Sales", via: "remote", url: "https://mcp.amplemarket.com/mcp", homepage: "https://amplemarket.com" });
    expect(byId["curated:clay"]).toMatchObject({ name: "Clay", category: "Sales", via: "remote", url: "https://api.clay.com/v3/mcp", homepage: "https://clay.com" });
    expect(byId["curated:pagerduty"]).toMatchObject({ name: "PagerDuty", category: "Support", via: "remote", url: "https://mcp.pagerduty.com/mcp", homepage: "https://pagerduty.com" });
    expect(byId["curated:clickup"]).toMatchObject({ name: "ClickUp", category: "Productivity", via: "remote", url: "https://mcp.clickup.com/mcp", homepage: "https://clickup.com" });
    expect(byId["curated:treg"]).toMatchObject({ name: "Treg", category: "Data", via: "remote", url: "https://treg.to/mcp/", homepage: "https://treg.to" });
    expect(byId["curated:aws-knowledge"]).toMatchObject({ name: "AWS Knowledge", category: "Code", via: "remote", url: "https://knowledge-mcp.global.api.aws", homepage: "https://aws.amazon.com" });
    expect(byId["curated:aws"]).toMatchObject({ name: "AWS", category: "Code", via: "remote", url: "https://aws-mcp.us-east-1.api.aws/mcp", homepage: "https://aws.amazon.com" });
    expect(byId["curated:1password"]).toMatchObject({
      name: "1Password",
      category: "Login and Credential Management",
      via: "remote",
      url: "https://mcp.1password.com/trelica/mcp",
      homepage: "https://1password.com",
      action: "connect",
    });
    expect(byId["curated:ibkr"]).toMatchObject({
      name: "Interactive Brokers",
      category: "Finance",
      via: "remote",
      url: "https://api.ibkr.com/v1/api/mcp-public",
      homepage: "https://www.interactivebrokers.com",
    });
    expect(byId["curated:granola"]).toMatchObject({
      name: "Granola",
      category: "Productivity",
      via: "remote",
      url: "https://mcp.granola.ai/mcp",
      homepage: "https://granola.ai",
    });
    expect(byId["curated:airtable"]).toMatchObject({
      name: "Airtable",
      category: "Productivity",
      via: "remote",
      url: "https://mcp.airtable.com/mcp",
      homepage: "https://airtable.com",
    });
  });
  it("merge ruling: the shipped Gmail/Calendar/Drive entries route to the built-in Google connector, never the claude.ai 'not available' label", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-g-"));
    const real = new Catalog({ curated: loadCurated(), mcp, plugins: () => null, templates: () => templates, index: new CatalogIndex(path.join(dir, "i.db")), google: () => ({ state: "disconnected" }) as never });
    for (const id of ["curated:gmail", "curated:google-calendar", "curated:google-drive"]) {
      expect(real.get(id)).toMatchObject({ source: "google", action: "connect", state: "available" });
      const d = real.detail(id);
      expect(d.sourceLabel).toBe("Built-in Google connector");
      expect(d.longDescription).not.toContain("not available with this login");
      await expect(real.install(id)).resolves.toMatchObject({ openUrl: null });
    }
  });
  it("every remote and google row ships a vendor logo URL (PLG-01 tiles, not initials)", async () => {
    const { loadCurated } = await import("../../marketplace/catalog");
    const missing = loadCurated().filter((c) => (c.via === "remote" || c.via === "google") && !c.logo);
    expect(missing.map((c) => c.id), "a curated row with no logo paints two-letter initials in Marketplace").toEqual([]);
    for (const c of loadCurated().filter((c) => c.logo)) {
      expect(c.logo, c.id).toMatch(/^https:\/\//);
    }
  });
});

describe("synapse-public: no claude.ai connectors (they come with a Claude login, which no Bot has)", () => {
  it("claude.ai tools a session reports are never listed, installable, or shown as servers; others are unaffected", async () => {
    mcp.registry.noteSessionTools(["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Asana__list"]);
    const entries = catalog.entries();
    expect(entries.filter((e) => (e.source as string) === "claudeai" || e.id.startsWith("claudeai:"))).toEqual([]);
    expect(catalog.get("curated:linear")).toMatchObject({ state: "available" });
    expect(catalog.view()).not.toHaveProperty("claudeAi");
    await expect(catalog.install("claudeai:claude_ai_Asana")).rejects.toThrow(/No catalog entry/);
    expect(mcpServerViews(mcp)).toEqual([]);
    expect(mcp.registry.sessionTools("claude_ai_Gmail")).toEqual([]);
  });
});
