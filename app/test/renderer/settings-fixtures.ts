// Shared fixtures for the Settings / Usage / Updates hand-testing round, in the same spirit as
// fake-bridge.ts: one window.synapse stand-in the individual test files re-point per case.
import { vi } from "vitest";
import type { BotSummary, HostSettingsView, RoutineView, UsageView } from "@synapse/shared";
import type { UpdateState } from "../../src/renderer/updates/store";

/** Copy the fixes introduce, quoted here so a wording change fails loudly in one place. */
export const COPY = {
  waiting: "Waiting for the agents to finish…",
  resetDone: "Your computer was reset.",
  noSource: "No update source is set, so there's nothing to check for.",
  downloading: "Downloading…",
  budgetInvalid: "Enter an amount greater than 0, or choose None.",
  saveRule: "Save rule",
  addRule: "Add rule",
  loading: "Loading…",
  retry: "Retry",
};

export const settings = (over: Partial<HostSettingsView> = {}): HostSettingsView => ({
  autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "America/New_York", userTimeZoneOverride: null,
  pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false, smartGroupTurns: false, teachSidecar: true,
  publicWebhook: { enabled: false, url: null }, ...over,
});

export const usageView: UsageView = {
  source: "metering", budgetUsd: null, budgetPct: null,
  level: "L0", limitedUntil: null, weekStart: 0,
  rows: [{ botId: "a", name: "Courier", model: "claude-sonnet-5", turns: 1, tokens: 10, costUsd: 1 }],
  efficiency: { dropped: 1, wakesAvoided: 1, burstsCoalesced: 1, loopsEnded: 1 },
};

export const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0,
};

export const routine = (over: Partial<RoutineView> = {}): RoutineView => ({
  botId: "a", id: "morning-inbox-sweep", name: "Morning inbox sweep", prompt: "Archive newsletters.", enabled: true, triggerKind: "schedule",
  schedule: "0 8 * * *", scheduleRaw: "CRON_TZ=America/New_York 0 8 * * *", description: "Every day at 8:00 AM", nextRunAt: null, lastRunAt: null,
  createdAt: 0, runs: [], webhook: null, trigger: null, listenerConnected: null, ...over,
});

export const boxStatus = (imageVersion: string, busyBotIds: string[] = []) => ({
  phase: "ready" as const, step: null, imageVersion, latestVersion: true, backupReady: true, lastSnapshotAt: 1, busyBotIds,
  doctor: { ranAt: null, failed: [] }, error: null,
});

export const baseUpdate: UpdateState = { version: "0.2.0", track: "stable", auto: false, feed: null, status: "idle", latest: null, error: null };

type SecretRow = { name: string; description: string; updatedAt: number };

/** Installs window.synapse and hands back the knobs. Returning an Error from `gateway`/`nativeReply`
 *  makes that call reject, the way a real gateway/native failure does. */
export function installBridge() {
  const h = {
    calls: [] as [string, unknown][],
    gateway: ((cmd: string) => (cmd === "getUsage" ? usageView : {})) as (cmd: string, args: Record<string, unknown>) => unknown,
    nativeReply: (() => baseUpdate) as (name: string, args: unknown) => unknown,
    box: {
      update: vi.fn<(force: boolean) => Promise<{ status: "done" | "busy"; busyBotIds?: string[] }>>(),
      recover: vi.fn(async () => {}),
      reset: vi.fn<(alsoBots: boolean) => Promise<void>>(async () => {}),
      info: vi.fn(async () => ({ bundledImageVersion: "v2" })),
      onLifecycle: vi.fn(() => () => {}),
    },
    secrets: {
      list: vi.fn<(botId: string) => Promise<SecretRow[]>>(async () => []),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      submitRequest: vi.fn(),
      submitForm: vi.fn(),
    },
  };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      h.calls.push([cmd, args]);
      const r = h.gateway(cmd, args);
      if (r instanceof Error) return { ok: false, error: { code: "ERR", message: r.message } };
      return { ok: true, result: r };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), vncUrl: () => null,
    secrets: h.secrets, box: h.box,
    native: {
      invoke: vi.fn(async (name: string, args: unknown) => {
        h.calls.push([`native:${name}`, args]);
        const r = h.nativeReply(name, args);
        if (r instanceof Error) return { ok: false, error: { code: "ERR", message: r.message } };
        return { ok: true, result: r };
      }),
      on: () => () => {},
    },
  };
  return h;
}
