import { vi } from "vitest";
import { defaultSafetyState, describeRule, type SafetyView } from "@synapse/shared";
import type { BotSummary, HostSettingsView, SseEvent } from "@synapse/shared";

type Canned = Record<string, unknown | ((args: never) => unknown)>;

export function botFixture(id: string, name: string): BotSummary {
  return {
    id, profile: { name, title: "", description: "", avatarShape: "pebble", avatarColor: "#3472d9", avatarKind: "shape" },
    settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, presence: "idle", activity: null, marker: null, statusLine: "",
    running: false, awaiting: null, createdAt: 0, updatedAt: 0, lastBotMessageAt: 0,
  };
}

export function settingsFixture(): HostSettingsView {
  return { autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "America/New_York", userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false };
}

// Defaults for the commands App's loadAll() fires on every "connected" render, so a test that
// renders <App /> without canning them doesn't crash on `.map` of an uncanned `{}`.
/** Safety v2: Settings → Rules reads the rules once it opens (Balanced, no rules of the owner's). */
export function safetyFixture(): SafetyView {
  const s = defaultSafetyState();
  return { preset: s.preset, rules: s.rules.map((r) => ({ ...r, words: describeRule(r) })), guidelines: [], networks: {} };
}

const BOOT_DEFAULTS: Record<string, unknown> = {
  getSafety: safetyFixture(),
  listAgents: { agents: [], activeAgentId: null },
  getHostSettings: settingsFixture(),
  getTrays: { trays: [] },
  getMarketplace: { installed: { count: 0, logos: [] }, featuredBots: [], forYou: null, fromTeam: [], featuredPlugins: [], categories: [], claudeAi: { detected: false, count: 0 } },
  // Task 21: App checks getOnboarding() once connected; already-seen keeps existing seam tests on the normal layout.
  getOnboarding: { hasSeenOnboarding: true, tokenConfigured: true },
  getTeachRecordingStatus: { status: { state: "IDLE", botId: null, sessionId: null, sessionDir: null, startedAtMs: null, elapsedMs: 0, goal: null } },
};

/** The Phase 3 half of window.synapse (VNC, secrets, box lifecycle) as inert stubs, for Phase 2 fixtures that render <App /> or Bot settings. */
export function phase3BridgeStubs() {
  return {
    vncUrl: () => null,
    secrets: { list: vi.fn(async () => []), save: vi.fn(async () => ({})), remove: vi.fn(async () => ({})), submitRequest: vi.fn(async () => "saved"), submitForm: vi.fn(async () => "submitted") },
    box: { update: vi.fn(async () => ({ status: "done" })), recover: vi.fn(async () => {}), reset: vi.fn(async () => {}), info: vi.fn(async () => ({ bundledImageVersion: "test" })), onLifecycle: () => () => {} },
  };
}

/** window.synapse with recorded calls, canned results (a value, or a function of the args) and event/notification emitters. */
export function installFakeBridge(canned: Canned = {}) {
  const calls: [string, unknown][] = [];
  const events = new Set<(e: SseEvent) => void>();
  const openBot = new Set<(id: string) => void>();
  const bridge = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      const c = canned[cmd];
      const result = typeof c === "function" ? (c as (a: unknown) => unknown)(args) : c ?? BOOT_DEFAULTS[cmd] ?? {};
      return { ok: true, result };
    }),
    onEvent: (cb: (e: SseEvent) => void) => { events.add(cb); return () => events.delete(cb); },
    onConnection: (cb: (s: unknown) => void) => { cb({ kind: "connected" }); return () => {}; },
    retry: vi.fn(),
    appInfo: async () => ({ userName: "tester" }),
    saveFile: vi.fn(async () => ({ saved: true })),
    setNativeTheme: vi.fn(),
    onOpenBot: (cb: (id: string) => void) => { openBot.add(cb); return () => openBot.delete(cb); },
    ...phase3BridgeStubs(),
    // Task 22 (CHAT-08): Composer's useDictation subscribes to window.synapse.native on mount, so every
    // test that renders Composer (directly or via ChatView) needs this even when it never dictates.
    native: {
      invoke: vi.fn(async () => ({ ok: true, result: {} })),
      on: (_channel: string, _cb: (p: unknown) => void) => () => {},
    },
  };
  (window as unknown as { synapse: typeof bridge }).synapse = bridge;
  return {
    calls,
    emitEvent: (e: SseEvent) => { for (const f of events) f(e); },
    emitOpenBot: (id: string) => { for (const f of openBot) f(id); },
  };
}
