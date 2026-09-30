import { randomBytes } from "node:crypto";
import path from "node:path";
import type { McpSdkServerConfigWithInstance, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  COMPOSIO_APPS, COMPOSIO_SERVER_ID, LIMITS5, STRX, composioAppName, composioToolReadOnly, composioToolkitOf, isComposioToolkit,
  type ComposioStatusView,
} from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { markBuiltinServer } from "../mcp/reserved";
import { hostGuardedFetch } from "../net/guarded-fetch";
import type { HostModule, ModuleContext } from "../phase5/types";
import { subkey, vaultKeySync } from "../secrets/crypto";
import { ComposioApi, ComposioError, scrubKey, type ComposioTool } from "./api";
import { fakeComposio } from "./fake-composio";
import { ComposioStore, type ComposioData } from "./store";

/** Bug 421: the reads the host itself runs for Full auto's checks (see composio/recipients.ts). */
const HOST_LOOKUPS: ReadonlySet<string> = new Set(["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "SLACK_LIST_ALL_CHANNELS", "GMAIL_FETCH_EMAILS"]);

export const COMPOSIO_SERVER = COMPOSIO_SERVER_ID;

export interface ComposioServices {
  api: ComposioApi;
  status(): ComposioStatusView;
  setKey(key: string): Promise<ComposioStatusView>;
  clearKey(): Promise<ComposioStatusView>;
  acceptDisclosure(): ComposioStatusView;
  connect(toolkit: string): Promise<{ redirectUrl: string; status: ComposioStatusView }>;
  /** One status check of a waiting app (the poll loop calls this; tests call it directly). */
  poll(toolkit: string): Promise<ComposioStatusView>;
  disconnect(toolkit: string): Promise<ComposioStatusView>;
  setGrant(toolkit: string, botId: string, enabled: boolean): ComposioStatusView;
  /** Connected apps this Bot may use. */
  grantedApps(botId: string): string[];
  listTools(botId: string): Promise<Tool[]>;
  callTool(botId: string, slug: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Bug 421: a host-internal lookup (thread participants, channel sizes, the Sent folder). Never offered to a Bot. */
  hostLookup(botId: string, slug: string, args: Record<string, unknown>): Promise<CallToolResult>;
  server(botId: string): McpSdkServerConfigWithInstance | null;
  stop(): void;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], isError });
const TOOL_TTL_MS = 10 * 60_000;

export function createComposioServices(ctx: Pick<ModuleContext, "cfg" | "hub" | "bots" | "now">, o: {
  fake?: boolean; fuzz?: boolean; fetch?: FetchLike; base?: string; pollMs?: number; waitMs?: number; storeKey?: Uint8Array;
} = {}): ComposioServices {
  const fuzz = o.fuzz ?? process.env.FUZZ === "1";
  // FUZZ runs against the in-process stand-in; a fake host without FUZZ reaches no Composio at all.
  const fetch: FetchLike = o.fetch ?? (o.fake ? (fuzz ? fakeComposio({ activateAfter: 2 }).fetch : async () => { throw new TypeError("offline"); }) : hostGuardedFetch());
  const store = new ComposioStore(path.join(ctx.cfg.hostPrivate, "composio", "account.json"), o.storeKey ?? subkey(vaultKeySync(ctx.cfg.hostPrivate), "bots/composio/v1"));
  const read = (): ComposioData => store.read();
  const api = new ComposioApi({ fetch, key: () => read().apiKey ?? null, ...(o.base ? { base: o.base } : {}) });
  const pollMs = o.pollMs ?? 2_500;
  const waitMs = o.waitMs ?? 10 * 60_000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
  /** Bug 404: an unlisted slug refreshes an app's tool list at most once a minute. */
  const lastRefresh = new Map<string, number>();

  const status = (): ComposioStatusView => {
    const d = read();
    return {
      keySet: !!d.apiKey,
      disclosureAccepted: d.disclosureAccepted === true,
      apps: COMPOSIO_APPS.map((a) => {
        const rec = d.apps?.[a.toolkit];
        return {
          toolkit: a.toolkit, name: a.name,
          state: rec ? rec.state : "available",
          bots: (d.grants?.[a.toolkit] ?? []).filter((id) => ctx.bots.has(id)),
          error: rec?.state === "failed" ? rec.error ?? STRX.failed : null,
        };
      }),
    };
  };
  const publish = () => ctx.hub.publish({ channel: "composio", payload: status() });
  const secret = () => [read().apiKey];
  const calm = (e: unknown): string => {
    if (e instanceof ComposioError) return e.kind === "rejected" ? STRX.keyRejected : e.kind === "unreachable" ? STRX.unreachable : scrubKey(e.message, secret());
    return STRX.unreachable;
  };
  const stopPoll = (toolkit: string) => { const t = timers.get(toolkit); if (t) clearTimeout(t); timers.delete(toolkit); };
  const schedule = (toolkit: string) => {
    stopPoll(toolkit);
    const t = setTimeout(() => { timers.delete(toolkit); void poll(toolkit).catch(() => {}); }, pollMs);
    t.unref?.();
    timers.set(toolkit, t);
  };
  const setApp = (toolkit: string, patch: Partial<NonNullable<ComposioData["apps"]>[string]> | null) => {
    const d = read();
    const apps = { ...(d.apps ?? {}) };
    if (patch === null) delete apps[toolkit];
    else apps[toolkit] = { ...apps[toolkit]!, ...patch };
    store.write({ apps });
  };

  const poll = async (toolkit: string): Promise<ComposioStatusView> => {
    const rec = read().apps?.[toolkit];
    if (!rec || rec.state !== "waiting") return status();
    let phase: "pending" | "active" | "failed";
    try { phase = await api.accountStatus(rec.accountId); } catch { phase = "pending"; } // a blip: keep waiting
    if (phase === "active") { setApp(toolkit, { state: "connected", since: ctx.now() }); toolCache.delete(toolkit); publish(); return status(); }
    if (phase === "failed") { setApp(toolkit, { state: "failed", error: STRX.failed }); publish(); return status(); }
    if (ctx.now() - rec.since > waitMs) { setApp(toolkit, { state: "failed", error: STRX.timedOut }); publish(); return status(); }
    schedule(toolkit);
    return status();
  };

  const tools = async (toolkit: string): Promise<ComposioTool[]> => {
    const c = toolCache.get(toolkit);
    if (c && ctx.now() - c.at < TOOL_TTL_MS) return c.tools;
    const t = await api.tools(toolkit);
    toolCache.set(toolkit, { at: ctx.now(), tools: t });
    return t;
  };

  const grantedApps = (botId: string): string[] => {
    const d = read();
    return COMPOSIO_APPS.map((a) => a.toolkit).filter((tk) => d.apps?.[tk]?.state === "connected" && (d.grants?.[tk] ?? []).includes(botId));
  };

  const listTools = async (botId: string): Promise<Tool[]> => {
    const out: Tool[] = [];
    for (const tk of grantedApps(botId)) {
      try {
        for (const t of await tools(tk)) {
          out.push({ name: t.slug, description: `${composioAppName(tk)} (through Composio): ${t.description}`, inputSchema: t.inputSchema as Tool["inputSchema"], annotations: { readOnlyHint: composioToolReadOnly(t.slug) } });
        }
      } catch { /* an unreachable toolkit lists nothing this time; the call path says why */ }
    }
    return out;
  };

  const callTool = (botId: string, slug: string, args: Record<string, unknown>) => run(botId, slug, args, false);
  /** Bug 421: the host's own recipient and Sent-folder lookups (never the Bot's): a fixed read list, grant-checked,
   *  run even when Composio's featured tool list leaves them out. */
  const hostLookup = (botId: string, slug: string, args: Record<string, unknown>) =>
    HOST_LOOKUPS.has(slug) ? run(botId, slug, args, true) : Promise.resolve(text(`Not a host lookup: ${slug.slice(0, 120)}`, true));

  const run = async (botId: string, slug: string, args: Record<string, unknown>, host: boolean): Promise<CallToolResult> => {
    const tk = composioToolkitOf(slug);
    if (!tk) return text(`No such tool: ${slug.slice(0, 120)}`, true);
    const name = composioAppName(tk);
    const d = read();
    const rec = d.apps?.[tk];
    // Re-checked at call time: a grant or a connection can change while a session is warm.
    if (!rec || rec.state !== "connected" || !d.apiKey || !d.userId) return text(STRX.toolNotConnected(name), true);
    if (!(d.grants?.[tk] ?? []).includes(botId)) return text(STRX.toolNotGranted(name), true);
    // Bug 400: only a slug in this app's own tool list runs. A missing one gets one fresh look, then is refused.
    if (!host) try {
      let listed = (await tools(tk)).some((t) => t.slug === slug);
      if (!listed && ctx.now() - (lastRefresh.get(tk) ?? -Infinity) >= 60_000) {
        lastRefresh.set(tk, ctx.now());
        toolCache.delete(tk);
        listed = (await tools(tk)).some((t) => t.slug === slug);
      }
      if (!listed) return text(`No such tool: ${slug.slice(0, 120)}`, true);
    } catch (e) {
      return text(`${name} through Composio: ${calm(e)}`, true);
    }
    try {
      const r = await api.execute(slug, { accountId: rec.accountId, userId: d.userId, args });
      const body = scrubKey(r.successful ? JSON.stringify(r.data ?? null) : `${name} returned an error: ${r.error ?? "unknown error"}`, [d.apiKey]);
      const cap = LIMITS5.mcpOutputSpillBytes;
      return text(body.length > cap ? `${body.slice(0, cap)}\n\n[The rest of the result was cut. Ask for less, e.g. with a smaller page size.]` : body, !r.successful);
    } catch (e) {
      return text(`${name} through Composio: ${calm(e)}`, true);
    }
  };

  const server = (botId: string): McpSdkServerConfigWithInstance | null => {
    if (!grantedApps(botId).length) return null;
    const mcp = new McpServer({ name: COMPOSIO_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools(botId) }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(botId, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    // Reserved id: only this built-in is ever mounted under it (mcp/reserved.ts).
    return markBuiltinServer({ type: "sdk", name: COMPOSIO_SERVER, instance: mcp as unknown as McpSdkServerConfigWithInstance["instance"] });
  };

  return {
    api, status, poll, grantedApps, listTools, callTool, hostLookup, server,
    setKey: async (raw) => {
      const key = String(raw ?? "").trim();
      if (!key) throw new GatewayError("BAD_ARGS", STRX.clipboardEmpty);
      if (key.length < 8 || key.length > 300 || /[\s\0]/.test(key)) throw new GatewayError("BAD_ARGS", STRX.notAKey);
      try { await api.validate(key); } catch (e) {
        throw new GatewayError("BAD_ARGS", e instanceof ComposioError && e.kind === "unreachable" ? STRX.unreachable : STRX.keyRejected);
      }
      const d = read();
      // Another key may be another Composio project: its accounts and grants don't carry over.
      const same = d.apiKey === key;
      for (const tk of Object.keys(d.apps ?? {})) if (!same) stopPoll(tk);
      store.write({ apiKey: key, userId: d.userId ?? `synapse-${randomBytes(9).toString("hex")}`, ...(same ? {} : { apps: {}, grants: {} }) });
      toolCache.clear();
      publish();
      return status();
    },
    clearKey: async () => {
      const d = read();
      for (const tk of Object.keys(d.apps ?? {})) stopPoll(tk);
      store.write({ apiKey: undefined, apps: {}, grants: {} });
      toolCache.clear();
      publish();
      return status();
    },
    acceptDisclosure: () => { store.write({ disclosureAccepted: true }); publish(); return status(); },
    connect: async (toolkit) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      const d = read();
      if (!d.apiKey) throw new GatewayError("BAD_ARGS", STRX.needsKey);
      if (d.disclosureAccepted !== true) throw new GatewayError("BAD_ARGS", STRX.needsDisclosure);
      let link: { redirectUrl: string; accountId: string };
      let authConfigId: string;
      try {
        authConfigId = await api.ensureAuthConfig(toolkit);
        link = await api.link(authConfigId, d.userId ?? `synapse-${randomBytes(9).toString("hex")}`);
      } catch (e) {
        throw new GatewayError("BAD_ARGS", calm(e));
      }
      const prev = read().apps?.[toolkit];
      setApp(toolkit, { accountId: link.accountId, authConfigId, state: "waiting", since: ctx.now(), error: undefined });
      // A retry replaces an unfinished attempt; the old half-made account is removed on Composio's side.
      if (prev && prev.accountId !== link.accountId && prev.state !== "connected") void api.removeAccount(prev.accountId).catch(() => {});
      schedule(toolkit);
      publish();
      return { redirectUrl: link.redirectUrl, status: status() };
    },
    disconnect: async (toolkit) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      stopPoll(toolkit);
      const d = read();
      const rec = d.apps?.[toolkit];
      if (rec) await api.removeAccount(rec.accountId).catch(() => {}); // gone here either way
      const grants = { ...(d.grants ?? {}) };
      delete grants[toolkit];
      const apps = { ...(d.apps ?? {}) };
      delete apps[toolkit];
      store.write({ apps, grants });
      toolCache.delete(toolkit);
      publish();
      return status();
    },
    setGrant: (toolkit, botId, enabled) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      if (!ctx.bots.has(botId)) throw new GatewayError("NOT_FOUND", "No such Bot.", 404);
      const d = read();
      const set = new Set(d.grants?.[toolkit] ?? []);
      if (enabled) set.add(botId); else set.delete(botId);
      store.write({ grants: { ...(d.grants ?? {}), [toolkit]: [...set].sort() } });
      publish();
      return status();
    },
    stop: () => { for (const tk of [...timers.keys()]) stopPoll(tk); },
  };
}

export function createComposioModule(_ctx: ModuleContext, c: ComposioServices): HostModule {
  return {
    name: "composio",
    stop: () => c.stop(),
    // Only a Bot granted at least one connected app gets the server (and its prompt note), so a grant changes the
    // spawn set and the next turn respawns with it.
    mcpServers: (botId): Record<string, McpServerConfig> => {
      const s = c.server(botId);
      return s ? { [COMPOSIO_SERVER]: s } : {};
    },
    systemAppendExtra: (botId) => {
      const apps = c.grantedApps(botId);
      return apps.length ? STRX.botPrompt(apps.map(composioAppName)) : "";
    },
    handlers: {
      getComposioStatus: () => c.status(),
      setComposioKey: (a) => c.setKey(String(a?.key ?? "")),
      clearComposioKey: () => c.clearKey(),
      acceptComposioDisclosure: () => c.acceptDisclosure(),
      connectComposioApp: (a) => c.connect(String(a?.toolkit ?? "")),
      disconnectComposioApp: (a) => c.disconnect(String(a?.toolkit ?? "")),
      setComposioGrant: (a) => c.setGrant(String(a?.toolkit ?? ""), String(a?.botId ?? ""), a?.enabled === true),
    },
  };
}

/** FUZZ/E2E: the FakeBrain runs mcp__composio_apps__ calls through the same per-Bot path (null = not a Composio call). */
export async function runComposioToolForFake(c: ComposioServices, botId: string, toolName: string, input: Record<string, unknown>): Promise<string | null> {
  const prefix = `mcp__${COMPOSIO_SERVER}__`;
  if (!toolName.startsWith(prefix)) return null;
  const r = await c.callTool(botId, toolName.slice(prefix.length), input);
  return (r.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
}
