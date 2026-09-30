import path from "node:path";
import {
  STR_HEALTH, composioAppName, isBadHealth,
  type ComposioStatusView, type ConnectorHealthView, type GoogleStatusView, type HealthFix, type KeyCheckView, type McpServerView, type SseEvent,
} from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { ComposioServices } from "../composio/module";
import { ComposioError } from "../composio/api";
import type { GoogleServices } from "../google/module";
import { GoogleAuthError } from "../google/oauth";
import { mcpServerViews, type McpServices } from "../mcp/module";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { TurnObserver } from "../runner/observers";
import { ConnectorHealth, HealthProbes, type HealthReport } from "./connector-health";
import { cliMcpState, connectorOfTool, githubAuthFailed, toolOutcome } from "./signals";

const DAY = 24 * 60 * 60_000;
const GOOGLE_NAMES: Record<string, string> = { Gmail: "Gmail", Calendar: "Google Calendar", Drive: "Google Drive" };
const NETWORKISH = /timed out|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|\b50[234]\b|unreachable/i;

export interface HealthServices {
  health: ConnectorHealth;
  probes: HealthProbes;
  /** The line for this Bot's next turn, or null (a prompt decorator in app.ts). */
  noteFor(botId: string): string | null;
  /** Google's expired sign-in (the reconnect check or a Bot's call that hit invalid_grant). */
  googleChanged(): void;
  keyCheck(v: KeyCheckView): void;
  observer: TurnObserver;
}

/**
 * 4.4: every connector's health from its own real signals, wired to the one model (connector-health.ts).
 * - Google: the account state, plus a daily token refresh (free) and one right after a Testing token's end.
 * - MCP servers: the host proxy's connect / list_tools result, the CLI's own init status for servers it runs,
 *   and one warm-up connect per server at start (a real initialize, off the turn path).
 * - Apps through Composio: the app state, plus Composio's free account-status call every 6 hours.
 * - GitHub (per Bot): the sign-in events, and a Bot's git/gh call refused for its credentials.
 * - Telegram: what the app's main process reports (it owns the long poll).
 * - The Anthropic API key: the key check's answer (never probed: it costs a message).
 * - Every connector a Bot calls: auth errors at once, other failures after three in a row.
 */
export function createHealthServices(ctx: Pick<ModuleContext, "cfg" | "hub" | "trays" | "bots" | "now">, o: {
  google: GoogleServices | null; mcp: McpServices | null; composio: ComposioServices | null;
  setTimer?(fn: () => void, ms: number): unknown; clearTimer?(t: unknown): void; file?: string | null;
}): HealthServices {
  const setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  // 4.3b: a Bot uses an account's row only when that account is granted to it.
  const uses = (botId: string, c: ConnectorHealthView): boolean => {
    if (c.kind === "google") return !!o.google?.enabledFor(botId) && o.google.grantedAccounts(botId).some((a) => `google:${a.id}` === c.id);
    if (c.kind === "mcp") { const r = o.mcp?.registry.get(c.id.slice("mcp:".length)); return !r || o.mcp!.registry.grantedTo(r, botId); }
    if (c.kind === "composio") {
      const [, tk = "", acc = ""] = c.id.split(":");
      return !!o.composio?.grantedAccounts(botId, tk).some((a) => a.id === acc);
    }
    if (c.kind === "github") return c.id === `github:${botId}`;
    return false;
  };
  const health = new ConnectorHealth({
    publish: (e) => ctx.hub.publish(e), trays: ctx.trays, now: ctx.now, uses, setTimer, clearTimer,
    file: o.file === undefined ? path.join(ctx.cfg.hostPrivate, "connector-health.json") : o.file,
  });
  const probes = new HealthProbes({ now: ctx.now, setTimer, clearTimer });

  // ---- Google (4.3b: one row per account) ----
  const googleName = (services: GoogleStatusView["services"], email: string | null, many: boolean) => {
    const base = services.length === 1 ? GOOGLE_NAMES[services[0]!] ?? "Google" : "Google";
    return many && email ? `${base} (${email})` : base;
  };
  const googleIds = new Set<string>();
  const google = (): void => {
    if (!o.google) return;
    const g = o.google;
    const st = g.status();
    health.report("google", null); // the one row from before 4.3b
    const accounts = st.state === "not-configured" ? [] : st.accounts ?? [];
    const seen = new Set<string>();
    for (const a of accounts) {
      const id = `google:${a.id}`;
      seen.add(id);
      const base = { kind: "google" as const, name: googleName(a.services, a.email, accounts.length > 1), fix: { kind: "google" as const, accountId: a.id } };
      health.report(id, a.state === "connected" ? { ...base, state: "ok" } : { ...base, state: "needs-sign-in" });
      if (a.state !== "connected") { probes.delete(id); continue; }
      // Token expiry: a Testing app's refresh token ends at a known time; check just after it instead of waiting a day.
      const end = g.auth.refreshExpiresAt(a.id);
      const firstAt = end && end > ctx.now() ? Math.min(ctx.now() + DAY, end + 60_000) : undefined;
      probes.set(id, async () => {
        if (!g.auth.isConnected(a.id)) return true;
        try { await g.auth.accessToken(true, a.id); return true; } catch (e) { return e instanceof GoogleAuthError && e.kind === "needs-reconnect"; }
      }, { everyMs: DAY, ...(firstAt ? { firstAt } : {}) });
    }
    for (const id of googleIds) if (!seen.has(id)) { health.report(id, null); probes.delete(id); }
    googleIds.clear();
    for (const id of seen) googleIds.add(id);
  };
  // A Bot's Google call, against the account it used.
  o.google?.onToolOutcome((accountId, r) => {
    const out = toolOutcome(r.isError === true, r.text);
    if (out) health.noteTool(`google:${accountId}`, out);
  });

  // ---- MCP servers ----
  const cliStates = new Map<string, string>();
  const mcp = (views?: McpServerView[]): void => {
    if (!o.mcp) return;
    const reg = o.mcp.registry;
    const list = views ?? mcpServerViews(o.mcp);
    const seen = new Set<string>();
    for (const r of reg.list()) {
      const id = `mcp:${r.id}`;
      seen.add(id);
      if (!r.enabled) { health.report(id, null); continue; }
      const name = r.label ? `${r.name} (${r.label})` : r.name;
      let rep: HealthReport;
      if (reg.hostProxied(r)) {
        const v = list.find((x) => x.id === r.id);
        const status = v?.status ?? "unknown";
        if (status === "disabled") { health.report(id, null); continue; }
        const signIn = status === "needs-auth" || status === "waiting-auth";
        const network = status === "failed" && NETWORKISH.test(v?.error ?? "");
        rep = {
          kind: "mcp", name, fix: signIn ? { kind: "mcp-auth", serverId: r.id } : { kind: "mcp-restart", serverId: r.id },
          state: status === "connected" ? "ok" : signIn ? "needs-sign-in" : status === "failed" ? "broken" : "checking",
          reason: status === "failed" ? (network ? STR_HEALTH.reasons.unreachable : STR_HEALTH.reasons.didntStart) : null,
          ...(network ? { network: true } : {}),
        };
      } else {
        const s = cliMcpState(cliStates.get(r.id) ?? "pending");
        rep = { kind: "mcp", name, fix: { kind: "mcp-restart", serverId: r.id }, state: s.state, reason: s.reason };
      }
      health.report(id, rep);
    }
    for (const v of health.list()) if (v.kind === "mcp" && !seen.has(v.id)) health.report(v.id, null);
  };

  // ---- Apps through Composio (4.3b: one row per account) ----
  /** Composio account ids whose free status call said the sign-in is gone. */
  const cxProbeFailed = new Set<string>();
  const cxIds = new Set<string>();
  const composio = (st?: ComposioStatusView): void => {
    if (!o.composio) return;
    const c = o.composio;
    const s = st ?? c.status();
    const seen = new Set<string>();
    for (const a of s.apps) {
      health.report(`composio:${a.toolkit}`, null); // the one row per app from before 4.3b
      if (!s.keySet) continue;
      const many = (a.accounts ?? []).length > 1;
      for (const acct of a.accounts ?? []) {
        const id = `composio:${a.toolkit}:${acct.id}`;
        seen.add(id);
        if (acct.state === "waiting") cxProbeFailed.delete(acct.id); // the owner is signing in again
        const app = a.name || composioAppName(a.toolkit);
        const name = many ? (acct.label.startsWith(app) ? acct.label : `${app} (${acct.label})`) : app;
        const base = { kind: "composio" as const, name, fix: { kind: "composio-app" as const, toolkit: a.toolkit, accountId: acct.id } };
        const state = acct.state === "connected" ? (cxProbeFailed.has(acct.id) ? "needs-sign-in" : "ok") : acct.state === "waiting" ? "checking" : "needs-sign-in";
        health.report(id, { ...base, state });
        if (acct.state !== "connected") { probes.delete(id); continue; }
        probes.set(id, async () => {
          if (!c.accountIds(a.toolkit).some((x) => x.id === acct.id)) return true;
          try {
            const phase = await c.api.accountStatus(acct.id);
            if (phase === "failed") cxProbeFailed.add(acct.id); else if (phase === "active") cxProbeFailed.delete(acct.id);
          } catch (e) {
            if (!(e instanceof ComposioError) || e.kind !== "rejected") return false;
            cxProbeFailed.add(acct.id);
          }
          composio();
          return true;
        });
      }
    }
    for (const id of cxIds) if (!seen.has(id)) { health.report(id, null); probes.delete(id); cxProbeFailed.delete(id.split(":")[2] ?? ""); }
    cxIds.clear();
    for (const id of seen) cxIds.add(id);
  };
  o.composio?.onToolOutcome((tk, accountId, isError, text) => {
    const out = toolOutcome(isError, text);
    if (out) health.noteTool(`composio:${tk}:${accountId}`, out);
  });

  // ---- GitHub (per Bot) ----
  const githubName = (botId: string) => STR_HEALTH.githubFor(ctx.bots.has(botId) ? ctx.bots.summary(botId).profile.name : botId);
  const github = (botId: string, state: "ok" | "needs-sign-in" | null) => {
    const id = `github:${botId}`;
    if (state === null) { health.report(id, null); return; }
    if (state === "needs-sign-in" && !health.get(id)) return; // never signed in through Synapse: nothing broke
    health.report(id, { kind: "github", name: githubName(botId), state, fix: { kind: "github", botId } });
  };

  // ---- The Anthropic API key ----
  const keyCheck = (v: KeyCheckView) => {
    const base = { kind: "provider" as const, name: STR_HEALTH.anthropicKey, fix: { kind: "provider" as const } };
    if (v.works === true) health.report("provider:anthropic", { ...base, state: "ok" });
    else if (v.works === false && v.problem) {
      const k = v.problem.kind;
      if (k === "no-key") health.report("provider:anthropic", null);
      else if (k === "invalid-key") health.report("provider:anthropic", { ...base, state: "needs-sign-in" });
      else if (k === "billing" || k === "permission") health.report("provider:anthropic", { ...base, state: "broken", reason: v.problem.title });
      // rate limits, overload, the network: passing weather, not a broken key
    }
  };

  ctx.hub.subscribe((e: SseEvent) => {
    if (e.channel === "mcp-servers") mcp(e.payload.servers);
    else if (e.channel === "composio") composio(e.payload);
    else if (e.channel === "google") google();
    else if (e.channel === "key-check") keyCheck(e.payload);
    else if (e.channel === "github") {
      if (e.payload.state === "signed-in") github(e.payload.botId, "ok");
      else if (e.payload.state === "signed-out") github(e.payload.botId, null);
    } else if (e.channel === "agents") health.forgetBot(e.payload.removedId);
  });

  const observer: TurnObserver = {
    onEvent: (botId, e) => {
      if (e.kind === "tool_end") {
        const id = connectorOfTool(e.name, (sid) => !!o.mcp?.registry.get(sid));
        if (id) { const out = toolOutcome(e.isError, e.output); if (out) health.noteTool(id, out); }
        else if (githubAuthFailed(e.name, e.output)) github(botId, "needs-sign-in");
      } else if (e.kind === "session" && e.mcpServers && o.mcp) {
        let changed = false;
        for (const s of e.mcpServers) {
          const r = o.mcp.registry.get(s.name);
          if (!r || o.mcp.registry.hostProxied(r) || cliStates.get(s.name) === s.status) continue;
          cliStates.set(s.name, s.status);
          changed = true;
        }
        if (changed) mcp();
      }
    },
  };

  google();
  mcp();
  composio();
  return { health, probes, noteFor: (b) => health.noteFor(b), googleChanged: google, keyCheck, observer };
}

export function createHealthModule(h: HealthServices, o: { mcp: McpServices | null; warmUpMs?: number }): HostModule {
  let warm: ReturnType<typeof setTimeout> | null = null;
  return {
    name: "health",
    observers: [h.observer],
    start: () => {
      h.probes.start();
      // A real initialize + list_tools for each host-proxied server, once, well after start and one at a time: the
      // list then says what is true before any Bot needs it (and the first turn finds it warm).
      const mcp = o.mcp;
      if (!mcp) return;
      warm = setTimeout(() => {
        void (async () => {
          for (const r of mcp.registry.list()) {
            if (!r.enabled || !mcp.registry.hostProxied(r) || mcp.pool.status(r.id) !== "unknown") continue;
            await mcp.pool.ensure(r.id).catch(() => undefined);
          }
        })();
      }, o.warmUpMs ?? 15_000);
      warm.unref?.();
    },
    stop: () => { if (warm) clearTimeout(warm); h.probes.stop(); h.health.stop(); },
    handlers: {
      getConnectorHealth: () => ({ connectors: h.health.list() }),
      reportConnectorHealth: (a) => {
        if (a?.id !== "telegram") throw new GatewayError("BAD_ARGS", "Unknown connector.");
        const state = a.state;
        if (state === null) { h.health.report("telegram", null); return {}; }
        if (state !== "ok" && state !== "needs-sign-in" && state !== "broken" && state !== "checking") throw new GatewayError("BAD_ARGS", "Unknown state.");
        const reason = typeof a.reason === "string" ? a.reason.slice(0, 80) : null;
        h.health.report("telegram", { kind: "telegram", name: "Telegram", state, reason: isBadHealth(state) ? reason : null, fix: { kind: "telegram" }, ...(a.network === true ? { network: true } : {}) });
        return {};
      },
    },
  };
}
