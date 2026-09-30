import type { BotSummary } from "./bots";
import type { GoogleReconnectCheckView, GoogleSetupMode, GoogleSetupTaskView } from "./google-setup";

type None = Record<string, never>;

// ---------- Built-in Google connector (ORIG-GOOGLE) ----------
// The app connects to Google with the user's own "Desktop app" OAuth client; Bots use whatever the app connected.

/** Minimal scopes (controller ruling): Gmail read/compose/send, Calendar events, Drive read + app-created files. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/** The existing OAuth loopback (app/src/coordinator/oauth-loopback.ts, host/mcp/oauth.ts OAUTH_LOOPBACK_PORT). */
export const GOOGLE_REDIRECT_URI = "http://127.0.0.1:47823/mcp/oauth/callback";

/** Final secfix item 10: a Google id (message, draft, event, calendar, file, folder). Never "." or "..". */
export const GOOGLE_ID_RE = /^[A-Za-z0-9_@.-]+$/;
export function isGoogleId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 1024 && GOOGLE_ID_RE.test(v) && v !== "." && v !== "..";
}
/** The tool arguments that carry a Google id. */
export const GOOGLE_ID_ARGS = ["id", "draft_id", "reply_to_id", "file_id", "folder", "calendar"] as const;

export const GOOGLE_TOOL_NAMES = [
  "gmail_search", "gmail_read", "gmail_draft", "gmail_send",
  "calendar_list", "calendar_create", "calendar_update", "calendar_delete",
  "drive_search", "drive_read", "drive_upload",
] as const;
export type GoogleToolName = (typeof GOOGLE_TOOL_NAMES)[number];

export type GoogleService = "Gmail" | "Calendar" | "Drive";
export type GoogleConnState = "not-configured" | "disconnected" | "waiting" | "connected" | "needs-reconnect";
export interface GoogleStatusView {
  state: GoogleConnState;
  /** The client ID is not a secret; the client secret and the tokens never leave the host. */
  clientId: string | null;
  email: string | null;
  services: GoogleService[];
  redirectUri: string;
  error: string | null;
  /** google-setup: Google marked this sign-in's refresh token as expiring (the app is in Testing). Null before one. */
  testing?: boolean | null;
  /** google-setup: the "Let a Bot do it" task, while one runs. */
  setupTask?: GoogleSetupTaskView | null;
}

/** The reserved MCP server id the built-in Google connector mounts under. */
export const GOOGLE_SERVER_ID = "google";

/**
 * How the built-in Google connector stands **for one Bot**. The account can be connected while a Bot still has no
 * Google tools, because the tools are per-Bot (Bot Settings → Google). Three stores used to answer this question
 * separately — the Marketplace catalog read the Google account, GetMcpServerStatus read the MCP registry (which
 * never holds this connector), and the spawn set read the Bot's toggle — so the Bot was told "connected" and
 * "no connectors are installed" about the same thing. Everything Bot-facing now derives from this one view, and
 * `ready` is defined to mean exactly "mcp__google__ tools are in this Bot's spawn set".
 */
/** Never bare "connected": a connected account is either `ready` for this Bot or `off-for-bot`. */
export type GoogleBotState = Exclude<GoogleConnState, "connected"> | "off-for-bot" | "ready";
export interface GoogleBotStatusView {
  state: GoogleBotState;
  /** The per-Bot toggle (Bot Settings → Google). */
  enabled: boolean;
  /** The app-level account state, which is what the Marketplace shows. */
  account: GoogleConnState;
  email: string | null;
}

/**
 * The states in which this Bot's spawn set actually carries the mcp__google__ tools. `needs-reconnect` still mounts
 * them (they exist and fail with a clear message); every other non-`ready` state means the Bot has no Google tools
 * at all. This predicate is the contract between the Bot-facing status and `Phase5.mcpServers(botId)`.
 */
export const googleToolsMounted = (v: GoogleBotStatusView): boolean => v.state === "ready" || v.state === "needs-reconnect";

export type GoogleSseEvent = { channel: "google"; payload: GoogleStatusView };

const TOOL_NEEDS_RECONNECT = "The user's Google sign-in expired. They were shown a \"Reconnect Google\" notification; tell them to reconnect, then try again. Don't work around it.";

export const STRG = {
  connectGoogle: "Connect Google",
  google: "Google",
  connectedAccounts: "Connected accounts",
  copy: "Copy",
  copied: "Copied",
  clientId: "Client ID",
  clientSecret: "Client secret",
  connect: "Connect",
  waiting: "Waiting for you to approve in the browser…",
  reopen: "Reopen",
  connectedAs: (email: string) => `Connected as ${email}`,
  grantedServices: (s: string[]) => `Access to ${s.join(", ")}`,
  disconnect: "Disconnect",
  reconnect: "Reconnect Google",
  needsReconnect: "Google needs you to sign in again.",
  notConnected: "Not connected",
  manage: "Manage",
  botToggle: "Google",
  botToggleSub: "Let this Bot use your connected Gmail, Calendar and Drive",
  botToggleNeedsConnect: "Connect Google first (Settings → Connected accounts)",
  /** The switch is on but the account is not connected yet — a real, honoured state, not a mistake:
   *  host/google/module.ts's publish() wakes every already-enabled Bot the moment the account
   *  connects, so turning this on early is a choice the host keeps. The row said
   *  botToggleNeedsConnect in this state too, which put an ON switch above "connect Google first". */
  botToggleOnBeforeConnect: "On for this Bot — it gets Gmail, Calendar and Drive as soon as you connect Google (Settings → Connected accounts)",
  reconnectTray: "Reconnect Google",
  reconnectTrayDetail: "Your Google sign-in expired. Bots can't read mail, calendar or files until you reconnect.",
  // Tool errors (the Bot reads these)
  toolNotConnected: "Google isn't connected. Ask the user to connect it in Settings → Connected accounts → Google, then try again.",
  toolNeedsReconnect: TOOL_NEEDS_RECONNECT,
  toolNotEnabled: "Google is turned off for this Bot. The user can turn it on in this Bot's settings.",
  // Per-Bot legibility: the account being connected is not the same thing as this Bot being able to use it.
  botToggleOffWhileConnected: (email: string | null) =>
    `Connected${email ? ` as ${email}` : ""}, but off for this Bot — it has no Gmail, Calendar or Drive tools until you turn this on.`,
  botStateLabel: {
    "not-configured": "Not set up",
    disconnected: "Not connected",
    waiting: "Waiting for the user to approve in their browser",
    "needs-reconnect": "Connected, but the sign-in expired",
    "off-for-bot": "Connected to the user's account, but turned off for this Bot",
    ready: "Connected and on for this Bot",
  } as Record<GoogleBotState, string>,
  /** What the Bot must actually do next. Read by GetMcpServerStatus, GetPlugin, AuthenticateMcpServer and the system prompt. */
  botNextStep: (v: GoogleBotStatusView): string => {
    const who = v.email ? ` as ${v.email}` : "";
    switch (v.state) {
      case "not-configured":
        return "The user hasn't set Google up yet. Ask them to open Settings \u2192 Connected accounts \u2192 Google and follow the setup steps. You can't start this yourself.";
      case "disconnected":
        return "Ask the user to connect Google in Settings \u2192 Connected accounts \u2192 Google. You can't start the sign-in yourself, and restarting connectors won't help.";
      case "waiting":
        return "The user has started the Google sign-in and finishes it in their browser. Wait for them \u2014 your Google tools load on their own once they're done.";
      case "needs-reconnect":
        return TOOL_NEEDS_RECONNECT;
      case "off-for-bot":
        return `Google is connected${who}, but turned off for this Bot, so you have no mcp__google__ tools. Ask the user to open this Bot's settings and turn Google on. The tools load on their own as soon as they do \u2014 they don't need to message you again, and restarting connectors won't help.`;
      case "ready":
        return `Google is connected${who} and on for this Bot: your mcp__google__ tools are loaded and callable now.`;
    }
  },
  /** The hidden wake that carries the respawn: the Bot picks up its new tools without waiting for a user message. */
  botWakeReady: (email: string | null) =>
    `The user turned Google on for you${email ? ` (${email})` : ""}. Your mcp__google__ tools (Gmail, Calendar, Drive) are loaded and callable from this turn on. If they were waiting on Google work, pick it up now; if nothing is outstanding, don't send a message.`,
  perBotNote: "Connecting your account is only half of it: each Bot has its own Google switch in its settings, and a Bot with the switch off has no Gmail, Calendar or Drive tools.",
  cardLocation: "Acts on your Google account",
  // Draft-send card (ORIG-GOOGLE follow-up): the card must show what a gmail_send(draft_id) call actually sends.
  cardFactsFailed: (reason: string) => `Couldn't look this up in your Google account before showing it to you, so nothing was changed: ${reason}`,
  draftFetchFailed: (reason: string) => `Couldn't check the Gmail draft before showing it to you, so it wasn't sent: ${reason}`,
  draftChanged: "This Gmail draft changed since it was approved, so it wasn't sent. Ask again to review the current draft.",
  draftUnapproved: "This Gmail draft send wasn't bound to an approved card, so it wasn't sent. Ask again so the user can review it.",
};

declare module "./gateway" {
  interface GatewayCommands {
    getGoogleStatus: { args: None; result: GoogleStatusView };
    /** inProduction: the guided sheet's "Publishing status: In production" tick, when the user made one. */
    setGoogleClient: { args: { clientId: string; clientSecret: string; inProduction?: boolean }; result: GoogleStatusView };
    startGoogleAuth: { args: None; result: { authorizationUrl: string } };
    disconnectGoogle: { args: None; result: GoogleStatusView };
    setAgentGoogle: { args: { id: string; enabled: boolean }; result: { agent: BotSummary } };
    startGoogleSetupTask: { args: { botId: string; mode: GoogleSetupMode; projectId?: string | null }; result: GoogleStatusView };
    cancelGoogleSetupTask: { args: None; result: GoogleStatusView };
    getGoogleReconnectCheck: { args: None; result: GoogleReconnectCheckView };
    setGoogleReconnectCheck: { args: { enabled: boolean }; result: GoogleReconnectCheckView };
  }
}
