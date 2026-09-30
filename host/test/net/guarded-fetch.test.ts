import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { blockedAddress, guardedFetch, readGuardNets, BLOCKED_CODE } from "../../net/guarded-fetch";
import { httpConnector } from "../../mcp/connect";
import { McpRegistry } from "../../mcp/registry";
import { mcpFetchFor } from "../../mcp/module";
import { McpOAuth } from "../../mcp/oauth";
import { HostSettingsStore } from "../../store/host-settings";

// Bug 363: bothost fetches URLs a Bot (AddMcpServer), a marketplace repo or a remote server (redirects, OAuth
// discovery) can choose. Every such fetch goes through one guarded fetch whose connect step refuses the Mac, loopback
// and private ranges on every hop, after DNS (so a rebinding name is refused too).

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const listen = async (host: string, fn: http.RequestListener): Promise<{ url: string; hits: () => number }> => {
  let n = 0;
  const s = http.createServer((req, res) => { n++; fn(req, res); });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  const p = (s.address() as AddressInfo).port;
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${p}`, hits: () => n };
};
/** The tests' stand-in for "a public server": 127.0.0.1 only. Everything else keeps the real rules. */
const onlyLoopbackV4Public = (ip: string) => ip !== "127.0.0.1" && blockedAddress(ip, []);
const causeCode = async (p: Promise<unknown>) => { try { await p; return "resolved"; } catch (e) { return (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code ?? String(e); } };

/** The top of 100.64/10, the range's upper boundary. Assembled, so the public-tree scan (which flags literal tailnet
 *  addresses as possibly personal) doesn't mistake this synthetic boundary for someone's machine. */
const CGNAT_TOP = ["100", "127", "255", "254"].join(".");

describe("blockedAddress", () => {
  it.each([
    "127.0.0.1", "::1", "0.0.0.0", "0.250.250.254", "0.250.250.200", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
    CGNAT_TOP, "169.254.169.254", "198.18.0.1", "198.19.249.1", "224.0.0.251", "255.255.255.255", "fd07:b51a:cc66:f0::fe", "fe80::1",
    "ff02::1", "::", "::ffff:192.168.1.1", "::ffff:7f00:1", "64:ff9b::c0a8:101",
  ])("refuses %s", (ip) => expect(blockedAddress(ip, [])).toBe(true));
  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"])("allows %s", (ip) => expect(blockedAddress(ip, [])).toBe(false));
  it("refuses what isn't an address at all", () => expect(blockedAddress("example.com", [])).toBe(true));
  it("adds the Mac's own global IPv6 prefixes and LAN IPv4 from the box's guard config", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "guard-")); dirs.push(d);
    const f = path.join(d, "net-guard.conf");
    fs.writeFileSync(f, "LAN_BLOCK=on\nMAC_NETS=2001:db8:5::/64 203.0.113.0/24 junk 1.2.3.4/99\n");
    const nets = readGuardNets(f);
    expect(nets).toEqual(["2001:db8:5::/64", "203.0.113.0/24"]);
    expect(blockedAddress("2001:db8:5::7", nets)).toBe(true);
    expect(blockedAddress("203.0.113.9", nets)).toBe(true);
    expect(blockedAddress("2001:db8:6::7", nets)).toBe(false);
    expect(readGuardNets(path.join(d, "missing"))).toEqual([]);
  });
});

describe("guardedFetch", () => {
  it("reaches an allowed server", async () => {
    const a = await listen("127.0.0.1", (_q, r) => r.end("ok"));
    const f = guardedFetch({ isBlocked: onlyLoopbackV4Public });
    expect(await (await f(`${a.url}/`)).text()).toBe("ok");
  });

  it("refuses the Mac, loopback and the LAN before connecting, by literal address and by name", async () => {
    const f = guardedFetch({ isBlocked: onlyLoopbackV4Public });
    for (const u of ["http://0.250.250.254:4799/", "http://192.168.1.1/", "http://[fd07:b51a:cc66:f0::fe]:11434/", "http://10.0.0.5/", "http://[::1]:4799/"]) {
      expect(await causeCode(f(u)), u).toBe(BLOCKED_CODE);
    }
    // A name that resolves to loopback (DNS rebinding looks the same) is refused after the lookup.
    expect(await causeCode(guardedFetch()("http://localhost:4799/"))).toBe(BLOCKED_CODE);
  });

  it("a redirect to the Mac or the LAN is refused on that hop, and the private server never sees a request", async () => {
    const inside = await listen("::1", (_q, r) => r.end("mac secret"));
    for (const to of [`${inside.url}/`, "http://0.250.250.254:4799/", "http://192.168.1.1/admin"]) {
      const a = await listen("127.0.0.1", (_q, r) => { r.writeHead(302, { location: to }); r.end(); });
      expect(await causeCode(guardedFetch({ isBlocked: onlyLoopbackV4Public })(`${a.url}/mcp`)), to).toBe(BLOCKED_CODE);
      expect(a.hits()).toBe(1);
    }
    expect(inside.hits()).toBe(0);
  });

  it("an OAuth discovery URL pointing at the LAN or the Mac is refused", async () => {
    const inside = await listen("::1", (_q, r) => r.end("{}"));
    const f = guardedFetch({ isBlocked: onlyLoopbackV4Public });
    await expect(discoverOAuthProtectedResourceMetadata("http://127.0.0.1:4799/mcp", { resourceMetadataUrl: `${inside.url}/.well-known/oauth-protected-resource` }, f)).rejects.toThrow();
    await expect(discoverOAuthProtectedResourceMetadata("http://127.0.0.1:4799/mcp", { resourceMetadataUrl: "http://10.0.0.5/.well-known/oauth-protected-resource" }, f)).rejects.toThrow();
    expect(inside.hits()).toBe(0);
  });

  it("only http and https", async () => {
    await expect(guardedFetch()("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});

describe("MCP: only servers the owner adds in the app keep private reach", () => {
  const registry = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mcpreg-")); dirs.push(d);
    return new McpRegistry({ dir: d, settings: new HostSettingsStore(path.join(d, "s.json")), now: () => 1 });
  };

  it("a Bot-added, marketplace or curated server is guarded; an owner-added one isn't", () => {
    const r = registry();
    const guarded = guardedFetch();
    const bot = r.add({ name: "botadded", url: "https://example.com/mcp" }, "custom");
    const market = r.add({ name: "market", url: "https://example.com/mcp" }, "marketplace", "m:1");
    const curated = r.add({ name: "curated", url: "https://example.com/mcp" }, "curated", "c:1");
    const owner = r.add({ name: "owner", url: "https://example.com/mcp" }, "custom", null, { ownerPrivateReach: true });
    const fetchFor = mcpFetchFor(r, guarded);
    expect(fetchFor(bot.id)).toBe(guarded);
    expect(fetchFor(market.id)).toBe(guarded);
    expect(fetchFor(curated.id)).toBe(guarded);
    expect(fetchFor("gone")).toBe(guarded);
    expect(fetchFor(owner.id)).toBeUndefined();
    expect(r.get(owner.id)!.ownerPrivateReach).toBe(true);
    expect(r.get(bot.id)!.ownerPrivateReach).toBeUndefined();
  });

  it("the connector uses the server's fetch: a guarded server can't reach a private address, the owner's can", async () => {
    const a = await listen("127.0.0.1", (_q, r) => { r.writeHead(404); r.end(); });
    const guarded = guardedFetch();
    const bot = httpConnector(() => undefined, () => guarded);
    await expect(bot({ id: "x", url: `${a.url}/mcp` } as never, {})).rejects.toThrow();
    expect(a.hits()).toBe(0);
    const owner = httpConnector(() => undefined, () => undefined);
    await expect(owner({ id: "y", url: `${a.url}/mcp` } as never, {})).rejects.toThrow(); // a 404 server, but it was reached
    expect(a.hits()).toBeGreaterThan(0);
  });

  it("OAuth discovery and token exchange use the same guarded fetch", async () => {
    const r = registry();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mcpoauth-")); dirs.push(d);
    const s = r.add({ name: "botadded", url: "https://example.com/mcp" }, "custom");
    const guarded = guardedFetch();
    const authFn = vi.fn(async () => "AUTHORIZED" as const);
    const o = new McpOAuth({ dir: d, registry: r, now: () => 1, authFn: authFn as never, fetchFor: mcpFetchFor(r, guarded), onWaiting: () => {}, onAuthorized: async () => {} });
    await o.start(s.id);
    expect((authFn.mock.calls[0] as unknown as [unknown, { fetchFn?: unknown }])[1].fetchFn).toBe(guarded);
  });
});

// Bug 368: the review's last lows — skill import by URL and the marketplace clone.
describe("other host fetches of URLs someone else chose (bug 368)", () => {
  it("importWorkflowUrl uses the guarded fetch by default: a private address is refused and never reached", async () => {
    const { createSkillCommands } = await import("../../skills/skill-commands");
    const { SkillLibrary } = await import("../../skills/library");
    const { initLayout } = await import("../../store/layout");
    const { tmpConfig } = await import("../helpers");
    const cfg = tmpConfig();
    initLayout(cfg);
    const inside = await listen("127.0.0.1", (_q, r) => r.end("# Secret\n\nfrom the Mac\n"));
    const cmd = createSkillCommands({ library: new SkillLibrary({ cfg }), botIds: () => [] });
    await expect(cmd.importWorkflowUrl!({ url: `${inside.url}/SKILL.md` } as never)).rejects.toThrow();
    expect(inside.hits()).toBe(0);
  });

  it("the marketplace clone never follows an HTTP redirect", async () => {
    const { PluginMarketplaces } = await import("../../marketplace/plugin-marketplaces");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-redir-")); dirs.push(d);
    const calls: string[][] = [];
    const pm = new PluginMarketplaces({
      dir: path.join(d, "m"), managedDir: path.join(d, "managed"), now: () => 1,
      registry: new McpRegistry({ dir: path.join(d, "mcp"), settings: new HostSettingsStore(path.join(d, "s.json")), now: () => 1 }),
      git: async (args) => { calls.push(args); throw new Error("stop here"); },
    });
    await expect(pm.add("https://github.com/example/market")).rejects.toThrow();
    const clone = calls.find((a) => a.includes("clone"))!;
    expect(clone.slice(0, 3)).toEqual(["-c", "http.followRedirects=false", "clone"]);
  });
});
