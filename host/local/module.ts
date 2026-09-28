import { isAgentMessage } from "@synapse/shared";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { LocalAsks } from "./asks";
import type { BrowserCards } from "./browser-cards";
import type { LocalBridge } from "./bridge";
import type { EgressCounter } from "./egress";
import { createLocalTools } from "./local-tools";

/** The user's latest message to this Bot (a password/card value may be typed only if it is in there, this turn). */
function lastUserMessage(ctx: ModuleContext, botId: string): string | null {
  const tail = ctx.bots.tail(botId, 20);
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i]!;
    if (e.kind === "message" && !isAgentMessage(e)) return (e as { content?: string }).content ?? null;
  }
  return null;
}

export function createLocalModule(ctx: ModuleContext, o: { bridge: LocalBridge; asks: LocalAsks; egress: EgressCounter; browserCards?: BrowserCards }): HostModule {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    name: "local",
    // Per-turn token floor: these five reach the user's own Mac over the bridge. Before any Mac has ever registered
    // with this host they are five schemas (851 tokens a turn, measured with the CLI's own /context accounting on
    // 2026-09-19) that cannot do anything, so they are left out. Bug-log 129: once a Mac has registered they stay in
    // every Bot's list for good, across host restarts (the bridge persists it) and while the Mac is away (each one
    // answers STR5.localNotConnected). Gating on "registered in this process" made the list flap: a Bot spawned in the gap
    // after a restart had no Mac tools and told the user Mac access was a per-Bot permission. The first
    // registration changes the tool names, so the spawn key respawns a warm session at its next turn.
    // mac-browser: Browser rides with them, deferred behind ToolSearch in both profiles (its name only, per turn).
    botTools: (botId, slot, base) => [
      ...(base ?? []),
      ...(o.bridge.computer() ? createLocalTools({ botId, slot, bridge: o.bridge, asks: o.asks, now: ctx.now, autoReviewOn: () => ctx.settings.get().autoReviewEnabled, permMode: () => (ctx.bots.has(botId) ? ctx.bots.summary(botId).settings.permMode ?? "ask" : "ask"), noLimits: () => ctx.bots.has(botId) && ctx.bots.summary(botId).settings.noLimits === true, workspace: ctx.cfg.workspace,
        botName: () => (ctx.bots.has(botId) ? ctx.bots.summary(botId).profile.name : "This Bot"), lastUserMessage: () => lastUserMessage(ctx, botId), browserCards: o.browserCards }) : []),
    ],
    start: () => { void o.egress.sample(); timer = setInterval(() => void o.egress.sample(), 10_000); timer.unref?.(); },
    stop: () => { if (timer) clearInterval(timer); },
    handlers: {
      registerLocalComputer: (a) => { o.bridge.register(a.computer); return {}; },
      localExecHeartbeat: (a) => o.bridge.heartbeat(a.computerId),
      localExecOutput: (a) => { o.bridge.output(a.execId, a.stream, a.chunk); return {}; },
      localExecDone: (a) => { o.bridge.done(a.execId, a); return {}; },
      localExecUpload: (a) => { o.bridge.upload(a.execId, a.offset, a.bytesBase64, a.final); return {}; },
      // Note: the brief's handler key was `readWorkspaceFile`; the gateway command is `readLocalFile`
      // (shared/src/phase5.ts GatewayCommands) — using the real command name so this typechecks.
      readLocalFile: (a) => o.bridge.readWorkspaceFile(a.path, a.offset, a.length),
      resolveLocalToolPermission: (a) => ({ status: o.asks.resolve(a.id, a.askId, a.choice) }),
      getNetworkStats: () => ({ routedThisSession: o.egress.count() }),
      getBrowserUsage: () => o.browserCards?.usage() ?? { actions: 0, screenshots: 0, outlineChars: 0, byBot: {} },
    },
  };
}
