/**
 * 4.4 — connector health and work-finished notifications.
 *
 * One health model for every connector the owner has set up (Google, MCP servers, apps through Composio, Telegram,
 * each Bot's GitHub sign-in, the Anthropic API key). The host decides the state from real signals (auth errors,
 * repeated tool failures, token expiry, a failed MCP initialize) and says so plainly: one tray, one macOS
 * notification per break, and a line in the next turn of every Bot that uses it. Titles and labels only.
 */

export type HealthState = "ok" | "needs-sign-in" | "broken" | "checking";
export type ConnectorKind = "google" | "mcp" | "composio" | "telegram" | "github" | "provider";

/** What the Fix button runs: always the connector's existing reconnect flow, in the app. */
export type HealthFix =
  | { kind: "google"; accountId?: string }
  | { kind: "mcp-auth"; serverId: string }
  | { kind: "mcp-restart"; serverId: string }
  | { kind: "composio-app"; toolkit: string; accountId?: string }
  | { kind: "telegram" }
  | { kind: "github"; botId: string }
  | { kind: "provider" };

export interface ConnectorHealthView {
  /** "google:<accountId>", "mcp:<serverId>", "composio:<toolkit>:<accountId>", "telegram", "github:<botId>", "provider:anthropic", "provider:<provider id>" (0.1.6).
   *  4.3b: one row per account, so a broken work account never marks the personal one. */
  id: string;
  kind: ConnectorKind;
  name: string;
  state: HealthState;
  /** Broken only: a short reason ("Didn't start", "Access denied"). Never a credential. */
  reason: string | null;
  /** When this state began (epoch ms). */
  since: number;
  fix: HealthFix | null;
}

export const isBadHealth = (s: HealthState): boolean => s === "needs-sign-in" || s === "broken";

/** Settings → General → Work finished. */
export type WorkNotify = "on" | "long" | "off";
export const WORK_NOTIFY_MODES: readonly WorkNotify[] = ["on", "long", "off"];
export const isWorkNotify = (x: unknown): x is WorkNotify => typeof x === "string" && (WORK_NOTIFY_MODES as readonly string[]).includes(x);
export const DEFAULT_WORK_NOTIFY: WorkNotify = "on";

export const HEALTH_LIMITS = {
  /** "Only long tasks": a task longer than this. */
  longTaskMs: 60_000,
  /** A task's turns closer together than this are one task (a reply nudge, a shell that finishes). */
  taskSettleMs: 3_000,
  /** Work-finished notifications arriving within this window become one. */
  workCoalesceMs: 2_500,
  /** At most one work-finished notification this often; later ones join the next. */
  workMinGapMs: 10_000,
  /** Connector alerts arriving within this window become one notification. */
  alertCoalesceMs: 1_500,
  /** At most one connector notification this often. */
  alertMinGapMs: 60_000,
  /** A connector that broke again this soon after its last notification doesn't notify again (the tray still shows). */
  alertFlapMs: 60 * 60_000,
  /** Tool failures in a row (not auth) before a connector reads Broken. */
  toolFailuresToBreak: 3,
  /** A network-type error only counts once it has lasted this long (a blip isn't a break). */
  networkGraceMs: 5 * 60_000,
  /** Periodic probes (only where a connector has a free status call): the base interval and the backoff cap. */
  probeEveryMs: 6 * 60 * 60_000,
  probeMaxBackoffMs: 24 * 60 * 60_000,
  probeRetryMs: 15 * 60_000,
  summaryMax: 100,
  reasonMax: 80,
} as const;

/** Titles and labels only. */
export const STR_HEALTH = {
  section: "Connections",
  state: { ok: "OK", "needs-sign-in": "Needs sign-in", broken: "Broken", checking: "Checking" } as Record<HealthState, string>,
  fix: "Fix",
  none: "No connections yet",
  trayNeedsSignIn: (name: string) => `${name} needs you to sign in again`,
  trayBroken: (name: string) => `${name} stopped working`,
  alertMany: (n: number) => `${n} connections need attention`,
  workFinished: (bot: string, summary: string) => `${bot} finished: ${summary}`,
  workFinishedTitle: (bot: string) => `${bot} finished`,
  workFinishedMany: (n: number) => `${n} Bots finished`,
  workNotify: "Work finished",
  workNotifyOn: "On",
  workNotifyLong: "Only long tasks",
  workNotifyOff: "Off",
  workNotifyTelegram: "Also on Telegram",
  anthropicKey: "Anthropic API key",
  /** 0.1.6: a model provider's key (OpenAI, Gemini, …), one row per provider with a saved key. */
  providerKey: (label: string) => `${label} API key`,
  githubFor: (bot: string) => `GitHub (${bot})`,
  reasons: {
    didntStart: "Didn't start",
    failing: "Tools keep failing",
    accessDenied: "Access denied",
    unreachable: "Can't reach it",
    tokenRejected: "Token rejected",
    conflict: "Another program is using it",
    keyRejected: "Key rejected",
    noCredit: "No credit or no access",
  },
} as const;

/** The Bot's next turn: plain facts, so it says so instead of failing silently or looping. */
export const HEALTH_BOT_NOTE = {
  down: (lines: string[]) =>
    `<connector-status>\n${lines.join("\n")}\nDon't call these connectors' tools until they work again. If the task needs one, tell the user plainly that it is down and that Settings → Connections has a Fix button. Don't retry in a loop.\n</connector-status>`,
  needsSignIn: (name: string) => `- ${name} needs the user to sign in again.`,
  broken: (name: string, reason: string | null) => `- ${name} is not working${reason ? ` (${reason})` : ""}.`,
  back: (names: string[]) => `<connector-status>\n${names.join(", ")} ${names.length === 1 ? "is" : "are"} working again.\n</connector-status>`,
} as const;

export type HealthSseEvent =
  | { channel: "connector-health"; payload: { connectors: ConnectorHealthView[] } }
  /** One macOS notification per break (the coordinator shows it when the window isn't focused). */
  | { channel: "connector-alert"; payload: { ids: string[]; title: string; body: string } }
  /** A task the owner started finished (the host already applied Settings → Work finished). */
  | { channel: "work-finished"; payload: { botId: string; name: string; summary: string; startedAt: number; endedAt: number; telegram: boolean } };

declare module "./gateway" {
  interface GatewayCommands {
    getConnectorHealth: { args: Record<string, never>; result: { connectors: ConnectorHealthView[] } };
    /** The app's own connectors (Telegram lives in the app's main process). `state: null` = not set up / off. */
    reportConnectorHealth: { args: { id: "telegram"; state: HealthState | null; reason?: string | null; network?: boolean }; result: Record<string, never> };
  }
}
