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
import { ComposioStore, type ComposioAccountRecord, type ComposioData } from "./store";
import { log } from "../util/log";

/** Bug 421: the reads the host itself runs for Full auto's checks (see composio/recipients.ts). */
const HOST_LOOKUPS: ReadonlySet<string> = new Set(["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "SLACK_LIST_ALL_CHANNELS", "GMAIL_FETCH_EMAILS"]);
/** 4.3b: the Composio account id and the label a Bot and a card use. */
export interface ComposioAccountRef { id: string; label: string }

export const COMPOSIO_SERVER = COMPOSIO_SERVER_ID;

export interface ComposioServices {
  api: ComposioApi;
  status(): ComposioStatusView;
  setKey(key: string): Promise<ComposioStatusView>;
  clearKey(): Promise<ComposioStatusView>;
  acceptDisclosure(): ComposioStatusView;
  /** 4.3b: adds an account; `replace` (the Fix flow) makes the new account take over that one once it connects. */
  connect(toolkit: string, o?: { replace?: string }): Promise<{ redirectUrl: string; status: ComposioStatusView }>;
  /** One status check of a waiting app (the poll loop calls this; tests call it directly). */
  poll(toolkit: string): Promise<ComposioStatusView>;
  /** 4.3b: with accountId, only that account; without, every account of the app. Its grants go with it. */
  disconnect(toolkit: string, accountId?: string): Promise<ComposioStatusView>;
  /** 4.3b: with accountId, that account; without, every connected account of the app. */
  setGrant(toolkit: string, botId: string, enabled: boolean, accountId?: string): ComposioStatusView;
  rename(toolkit: string, accountId: string, label: string): ComposioStatusView;
  /** 4.3b: a duplicated Bot gets the source's account grants. */
  copyGrants(srcId: string, copyId: string): void;
  /** Connected apps this Bot may use (through at least one granted account). */
  grantedApps(botId: string): string[];
  /** 4.3b: this Bot's connected, granted accounts of one app. */
  grantedAccounts(botId: string, toolkit: string): ComposioAccountRef[];
  /** 4.3b: every connected account's label for this app. */
  allLabels(toolkit: string): string[];
  /** 4.3b: the account a call uses (its `account` argument), among this Bot's grants only. */
  resolveAccount(botId: string, toolkit: string, raw: unknown): ComposioAccountRef | { error: string };
  listTools(botId: string): Promise<Tool[]>;
  callTool(botId: string, slug: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Bug 421: a host-internal lookup (thread participants, channel sizes, the Sent folder). Never offered to a Bot. */
  hostLookup(botId: string, slug: string, args: Record<string, unknown>): Promise<CallToolResult>;
  server(botId: string): McpSdkServerConfigWithInstance | null;
  /** 4.4: a connected app's (first) Composio account id (null when not connected). */
  accountId(toolkit: string): string | null;
  /** 4.3b: each Bot call's result, against the account it used (connector health, per account). */
  onToolOutcome(fn: (toolkit: string, accountId: string, isError: boolean, text: string) => void): void;
  /** 4.3b: every connected account of this app, for the per-account status probe. */
  accountIds(toolkit: string): ComposioAccountRef[];
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
  /** Poll timers, per Composio account id. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const toolCache = new Map<string, { at: number; tools: ComposioTool[] }>();
  /** Bug 404: an unlisted slug refreshes an app's tool list at most once a minute. */
  const lastRefresh = new Map<string, number>();
  const outcomeListeners = new Set<(toolkit: string, accountId: string, isError: boolean, text: string) => void>();

  // ---- 4.3b: accounts ----
  const accountsOf = (d: ComposioData, tk: string): ComposioAccountRecord[] => d.accounts?.[tk] ?? [];
  const labelOf = (tk: string, rec: ComposioAccountRecord, i: number) => rec.label ?? STRX.accountLabel(composioAppName(tk), i + 1);
  const botsOf = (d: ComposioData, accountId: string) => (d.accountGrants?.[accountId] ?? []).filter((id) => ctx.bots.has(id));
  const findAccount = (d: ComposioData, accountId: string): { toolkit: string; rec: ComposioAccountRecord } | null => {
    for (const [tk, list] of Object.entries(d.accounts ?? {})) { const rec = list.find((r) => r.accountId === accountId); if (rec) return { toolkit: tk, rec }; }
    return null;
  };
  const writeAccounts = (tk: string, list: ComposioAccountRecord[]) => {
    const accounts = { ...(read().accounts ?? {}) };
    if (list.length) accounts[tk] = list; else delete accounts[tk];
    store.write({ accounts });
  };
  const patchAccount = (accountId: string, patch: Partial<ComposioAccountRecord>) => {
    const d = read();
    const hit = findAccount(d, accountId);
    if (!hit) return;
    writeAccounts(hit.toolkit, accountsOf(d, hit.toolkit).map((r) => {
      if (r.accountId !== accountId) return r;
      const next = { ...r, ...patch };
      for (const k of Object.keys(next) as (keyof ComposioAccountRecord)[]) if (next[k] === undefined) delete next[k];
      return next;
    }));
  };

  const status = (): ComposioStatusView => {
    const d = read();
    return {
      keySet: !!d.apiKey,
      disclosureAccepted: d.disclosureAccepted === true,
      apps: COMPOSIO_APPS.map((a) => {
        const list = accountsOf(d, a.toolkit);
        const accounts = list.map((r, i) => ({ id: r.accountId, label: labelOf(a.toolkit, r, i), state: r.state, bots: botsOf(d, r.accountId), error: r.state === "failed" ? r.error ?? STRX.failed : null }));
        const connected = accounts.filter((x) => x.state === "connected");
        const state = connected.length ? "connected" : accounts.some((x) => x.state === "waiting") ? "waiting" : accounts.some((x) => x.state === "failed") ? "failed" : "available";
        return {
          toolkit: a.toolkit, name: a.name, state,
          bots: [...new Set(connected.flatMap((x) => x.bots))].sort(),
          error: state === "failed" ? accounts.find((x) => x.error)?.error ?? STRX.failed : null,
          accounts,
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
  const stopPoll = (accountId: string) => { const t = timers.get(accountId); if (t) clearTimeout(t); timers.delete(accountId); };
  const schedule = (accountId: string) => {
    stopPoll(accountId);
    const t = setTimeout(() => { timers.delete(accountId); void pollAccount(accountId).catch(() => {}); }, pollMs);
    t.unref?.();
    timers.set(accountId, t);
  };

  /** 4.3b: a Gmail account is labelled by its address, when Composio's profile read tells it (best effort). */
  const labelFromProfile = async (tk: string, accountId: string) => {
    if (tk !== "gmail") return;
    const d = read();
    if (!d.userId) return;
    try {
      const r = await api.execute("GMAIL_GET_PROFILE", { accountId, userId: d.userId, args: {} });
      const email = JSON.stringify(r.data ?? "").match(/"(?:emailAddress|email_address|email)":"([^"@\s]+@[^"\s]+)"/)?.[1];
      if (r.successful && email && !findAccount(read(), accountId)?.rec.label) { patchAccount(accountId, { label: email.slice(0, 120) }); publish(); }
    } catch { /* keeps "Gmail 2" */ }
  };

  const pollAccount = async (accountId: string): Promise<void> => {
    const hit = findAccount(read(), accountId);
    if (!hit || hit.rec.state !== "waiting") return;
    let phase: "pending" | "active" | "failed";
    try { phase = await api.accountStatus(accountId); } catch { phase = "pending"; } // a blip: keep waiting
    if (phase === "active") {
      patchAccount(accountId, { state: "connected", since: ctx.now(), replaces: undefined });
      // A reconnect (Fix) takes over the account it replaces: its Bots and its name, and the old one goes.
      const old = hit.rec.replaces ? findAccount(read(), hit.rec.replaces) : null;
      if (old) {
        const g = { ...(read().accountGrants ?? {}) };
        g[accountId] = [...new Set([...(g[accountId] ?? []), ...(g[old.rec.accountId] ?? [])])].sort();
        store.write({ accountGrants: g });
        if (old.rec.label) patchAccount(accountId, { label: old.rec.label });
        await removeAccounts(new Set([old.rec.accountId]));
      }
      toolCache.delete(hit.toolkit);
      publish();
      void labelFromProfile(hit.toolkit, accountId);
      return;
    }
    if (phase === "failed") { patchAccount(accountId, { state: "failed", error: STRX.failed }); publish(); return; }
    if (ctx.now() - hit.rec.since > waitMs) { patchAccount(accountId, { state: "failed", error: STRX.timedOut }); publish(); return; }
    schedule(accountId);
  };
  /** One status check of every waiting account of this app. */
  const poll = async (toolkit: string): Promise<ComposioStatusView> => {
    for (const r of accountsOf(read(), toolkit)) if (r.state === "waiting") await pollAccount(r.accountId);
    return status();
  };

  const tools = async (toolkit: string): Promise<ComposioTool[]> => {
    const c = toolCache.get(toolkit);
    if (c && ctx.now() - c.at < TOOL_TTL_MS) return c.tools;
    const t = await api.tools(toolkit);
    toolCache.set(toolkit, { at: ctx.now(), tools: t });
    return t;
  };

  /** 4.3b: this Bot's connected, granted accounts of one app, with their labels. */
  const grantedAccounts = (botId: string, toolkit: string): { id: string; label: string }[] => {
    const d = read();
    return accountsOf(d, toolkit).map((r, i) => ({ r, i }))
      .filter(({ r }) => r.state === "connected" && (d.accountGrants?.[r.accountId] ?? []).includes(botId))
      .map(({ r, i }) => ({ id: r.accountId, label: labelOf(toolkit, r, i) }));
  };
  const grantedApps = (botId: string): string[] => COMPOSIO_APPS.map((a) => a.toolkit).filter((tk) => grantedAccounts(botId, tk).length > 0);
  const allLabels = (toolkit: string): string[] => accountsOf(read(), toolkit).map((r, i) => ({ r, i })).filter(({ r }) => r.state === "connected").map(({ r, i }) => labelOf(toolkit, r, i));
  /** 4.3b: the account a call uses, among this Bot's grants only: never a guess. */
  const resolveAccount = (botId: string, toolkit: string, raw: unknown): { id: string; label: string } | { error: string } => {
    const name = composioAppName(toolkit);
    const granted = grantedAccounts(botId, toolkit);
    const asked = typeof raw === "string" ? raw.trim() : "";
    if (asked) return granted.find((a) => a.id === asked || a.label.toLowerCase() === asked.toLowerCase()) ?? { error: STRX.toolAccountNotGranted(name, asked, granted.map((a) => a.label)) };
    if (!granted.length) return { error: STRX.toolNotGranted(name) };
    if (granted.length > 1) return { error: STRX.toolChooseAccount(name, granted.map((a) => a.label)) };
    return granted[0]!;
  };

  const listTools = async (botId: string): Promise<Tool[]> => {
    const out: Tool[] = [];
    for (const tk of grantedApps(botId)) {
      try {
        const app = composioAppName(tk);
        for (const t of await tools(tk)) {
          // 4.3b: every tool takes the account it acts on (the host resolves it against this Bot's grants).
          const schema = t.inputSchema as { properties?: Record<string, unknown> };
          const inputSchema = { ...schema, properties: { ...(schema.properties ?? {}), account: { type: "string", description: STRX.accountDescribe(app) } } };
          out.push({ name: t.slug, description: `${app} (through Composio): ${t.description}`, inputSchema: inputSchema as unknown as Tool["inputSchema"], annotations: { readOnlyHint: composioToolReadOnly(t.slug) } });
        }
      } catch { /* an unreachable toolkit lists nothing this time; the call path says why */ }
    }
    return out;
  };

  const callTool = async (botId: string, slug: string, args: Record<string, unknown>) => {
    const r = await run(botId, slug, args, false);
    const tk = composioToolkitOf(slug);
    const acc = tk ? resolveAccount(botId, tk, args.account) : null;
    if (tk && acc && !("error" in acc)) {
      const t = (r.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
      for (const fn of outcomeListeners) { try { fn(tk, acc.id, r.isError === true, t); } catch { /* health is best effort */ } }
    }
    return r;
  };
  /** Bug 421: the host's own recipient and Sent-folder lookups (never the Bot's): a fixed read list, grant-checked,
   *  run even when Composio's featured tool list leaves them out. */
  const hostLookup = (botId: string, slug: string, args: Record<string, unknown>) =>
    HOST_LOOKUPS.has(slug) ? run(botId, slug, args, true) : Promise.resolve(text(`Not a host lookup: ${slug.slice(0, 120)}`, true));

  const run = async (botId: string, slug: string, rawArgs: Record<string, unknown>, host: boolean): Promise<CallToolResult> => {
    const tk = composioToolkitOf(slug);
    if (!tk) return text(`No such tool: ${slug.slice(0, 120)}`, true);
    const name = composioAppName(tk);
    const d = read();
    // Re-checked at call time: a grant or a connection can change while a session is warm.
    if (!accountsOf(d, tk).some((r) => r.state === "connected") || !d.apiKey || !d.userId) return text(STRX.toolNotConnected(name), true);
    if (!grantedAccounts(botId, tk).length) return text(STRX.toolNotGranted(name), true);
    // 4.3b: the account is resolved in the host, among this Bot's grants; `account` never reaches Composio.
    const { account: askedAccount, ...args } = rawArgs;
    const acc = resolveAccount(botId, tk, askedAccount);
    if ("error" in acc) { log.info(`accounts: composio refused bot=${botId} tool=${slug}`); return text(acc.error, true); }
    if (!host) log.info(`accounts: composio bot=${botId} tool=${slug} account=${acc.id}`);
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
      const r = await api.execute(slug, { accountId: acc.id, userId: d.userId, args });
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

  const removeAccounts = async (ids: Set<string>) => {
    for (const id of ids) { stopPoll(id); await api.removeAccount(id).catch(() => {}); } // gone here either way
    const d = read();
    const accounts: Record<string, ComposioAccountRecord[]> = {};
    for (const [tk, list] of Object.entries(d.accounts ?? {})) { const keep = list.filter((r) => !ids.has(r.accountId)); if (keep.length) accounts[tk] = keep; }
    const accountGrants = { ...(d.accountGrants ?? {}) };
    for (const id of ids) delete accountGrants[id];
    store.write({ accounts, accountGrants });
  };

  return {
    onToolOutcome: (fn) => { outcomeListeners.add(fn); },
    copyGrants: (src, copy) => {
      const g = { ...(read().accountGrants ?? {}) };
      let changed = false;
      for (const [id, list] of Object.entries(g)) if (list.includes(src) && !list.includes(copy)) { g[id] = [...list, copy].sort(); changed = true; }
      if (changed) { store.write({ accountGrants: g }); publish(); }
    },
    api, status, poll, grantedApps, grantedAccounts, allLabels, resolveAccount, listTools, callTool, hostLookup, server,
    accountId: (toolkit) => accountsOf(read(), toolkit).find((r) => r.state === "connected")?.accountId ?? null,
    accountIds: (toolkit) => accountsOf(read(), toolkit).filter((r) => r.state === "connected").map((r, i) => ({ id: r.accountId, label: labelOf(toolkit, r, i) })),
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
      if (!same) for (const id of [...timers.keys()]) stopPoll(id);
      store.write({ apiKey: key, userId: d.userId ?? `synapse-${randomBytes(9).toString("hex")}`, ...(same ? {} : { accounts: {}, accountGrants: {} }) });
      toolCache.clear();
      publish();
      return status();
    },
    clearKey: async () => {
      for (const id of [...timers.keys()]) stopPoll(id);
      store.write({ apiKey: undefined, accounts: {}, accountGrants: {} });
      toolCache.clear();
      publish();
      return status();
    },
    acceptDisclosure: () => { store.write({ disclosureAccepted: true }); publish(); return status(); },
    connect: async (toolkit, o2 = {}) => {
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
      // 4.3b: connected accounts stay (this adds one); a retry replaces an unfinished attempt, whose half-made
      // account is removed on Composio's side.
      const prev = accountsOf(read(), toolkit);
      const stale = prev.filter((r) => r.state !== "connected" && r.accountId !== link.accountId);
      for (const r of stale) { stopPoll(r.accountId); void api.removeAccount(r.accountId).catch(() => {}); }
      const kept = prev.filter((r) => r.state === "connected" && r.accountId !== link.accountId);
      const replaces = o2.replace && kept.some((r) => r.accountId === o2.replace) ? o2.replace : undefined;
      writeAccounts(toolkit, [...kept, { accountId: link.accountId, authConfigId, state: "waiting", since: ctx.now(), ...(replaces ? { replaces } : {}) }]);
      // A new account starts with no Bots; a retry of an unfinished attempt keeps that attempt's Bots and name.
      const grants = { ...(read().accountGrants ?? {}) };
      grants[link.accountId] = [...new Set(stale.flatMap((r) => grants[r.accountId] ?? []))].sort();
      for (const r of stale) delete grants[r.accountId];
      store.write({ accountGrants: grants });
      const label = stale.find((r) => r.label)?.label;
      if (label) patchAccount(link.accountId, { label });
      schedule(link.accountId);
      publish();
      return { redirectUrl: link.redirectUrl, status: status() };
    },
    disconnect: async (toolkit, accountId) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      const list = accountsOf(read(), toolkit);
      if (accountId !== undefined && !list.some((r) => r.accountId === accountId)) throw new GatewayError("NOT_FOUND", "No such account.", 404);
      log.info(`accounts: composio disconnect ${toolkit} ${accountId ? `account=${accountId}` : "all"}`);
      await removeAccounts(new Set(list.filter((r) => accountId === undefined || r.accountId === accountId).map((r) => r.accountId)));
      toolCache.delete(toolkit);
      publish();
      return status();
    },
    setGrant: (toolkit, botId, enabled, accountId) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      if (!ctx.bots.has(botId)) throw new GatewayError("NOT_FOUND", "No such Bot.", 404);
      const d = read();
      const list = accountsOf(d, toolkit);
      if (accountId !== undefined && !list.some((r) => r.accountId === accountId)) throw new GatewayError("NOT_FOUND", "No such account.", 404);
      // Without an account: every connected account of the app (the one-account switch).
      const ids = accountId !== undefined ? [accountId] : list.filter((r) => r.state === "connected").map((r) => r.accountId);
      const grants = { ...(d.accountGrants ?? {}) };
      for (const id of ids) {
        const set = new Set(grants[id] ?? []);
        if (enabled) set.add(botId); else set.delete(botId);
        grants[id] = [...set].sort();
      }
      store.write({ accountGrants: grants });
      log.info(`accounts: composio grant ${enabled ? "on" : "off"} bot=${botId} ${toolkit} ${ids.length} account(s)`);
      publish();
      return status();
    },
    rename: (toolkit, accountId, raw) => {
      if (!isComposioToolkit(toolkit)) throw new GatewayError("BAD_ARGS", "Unknown app.");
      if (!accountsOf(read(), toolkit).some((r) => r.accountId === accountId)) throw new GatewayError("NOT_FOUND", "No such account.", 404);
      const label = String(raw ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 60);
      if (!label) throw new GatewayError("BAD_ARGS", "Give the account a name.");
      const taken = accountsOf(read(), toolkit).map((r, i) => ({ r, i })).some(({ r, i }) => r.accountId !== accountId && labelOf(toolkit, r, i).toLowerCase() === label.toLowerCase());
      if (taken) throw new GatewayError("BAD_ARGS", "Another account of this app already has that name.");
      patchAccount(accountId, { label });
      publish();
      return status();
    },
    stop: () => { for (const id of [...timers.keys()]) stopPoll(id); },
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
      if (!apps.length) return "";
      // 4.3b: an app with more than one account this Bot may use: every call names its account.
      const multi = apps.map((tk) => ({ tk, labels: c.grantedAccounts(botId, tk).map((a) => a.label) })).filter((x) => x.labels.length > 1);
      const which = multi.map((x) => `\nYou can use ${x.labels.length} ${composioAppName(x.tk)} accounts: ${x.labels.join(", ")}. Pass account on every ${composioAppName(x.tk)} call; if the user didn't say which account, ask them.`).join("");
      return STRX.botPrompt(apps.map(composioAppName)) + which;
    },
    handlers: {
      getComposioStatus: () => c.status(),
      setComposioKey: (a) => c.setKey(String(a?.key ?? "")),
      clearComposioKey: () => c.clearKey(),
      acceptComposioDisclosure: () => c.acceptDisclosure(),
      connectComposioApp: (a) => c.connect(String(a?.toolkit ?? ""), typeof a?.replace === "string" && a.replace ? { replace: a.replace } : {}),
      disconnectComposioApp: (a) => c.disconnect(String(a?.toolkit ?? ""), typeof a?.accountId === "string" && a.accountId ? a.accountId : undefined),
      setComposioGrant: (a) => c.setGrant(String(a?.toolkit ?? ""), String(a?.botId ?? ""), a?.enabled === true, typeof a?.accountId === "string" && a.accountId ? a.accountId : undefined),
      renameComposioAccount: (a) => c.rename(String(a?.toolkit ?? ""), String(a?.accountId ?? ""), String(a?.label ?? "")),
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
