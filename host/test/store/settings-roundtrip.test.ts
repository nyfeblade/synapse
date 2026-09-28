import { afterEach, describe, expect, it } from "vitest";
import { NO_LIMITS_CONFIRM, type BotSummary } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

/**
 * settings-persist: "You switch something on, it stays on through reloads." One row per Settings control the HOST
 * keeps (account settings, the memory and standup blocks, and every per-Bot switch and select in Bot settings):
 * save it through the real command, stop the host, start a new one over the same data, and read it back through
 * the command the app itself loads it with. The Mac-side controls (ability switches, voice, calls, updates) have
 * their own round trips: app/test/coordinator/ability-persist.test.ts and app/test/main/app-settings-roundtrip.test.ts.
 */
type H = HostApp["handlers"];
interface Row { control: string; save(h: H, bot: string): Promise<unknown> | unknown; read(h: H, bot: string): Promise<unknown>; want: unknown }

const botOf = async (h: H, id: string): Promise<BotSummary> => (await h.listAgents!({})).agents.find((a: BotSummary) => a.id === id)!;
const account = (k: string) => async (h: H) => (await h.getHostSettings!({}) as unknown as Record<string, unknown>)[k];
const botSetting = (k: string) => async (h: H, id: string) => ((await botOf(h, id)).settings as unknown as Record<string, unknown>)[k];

const ROWS: Row[] = [
  // Settings → General
  { control: "Timezone", save: (h) => h.setHostSettings!({ userTimeZone: "Europe/Paris" }), read: account("userTimeZoneOverride"), want: "Europe/Paris" },
  { control: "Auto-review", save: (h) => h.setHostSettings!({ autoReviewEnabled: false }), read: account("autoReviewEnabled"), want: false },
  { control: "Auto-review rules (allow)", save: (h) => h.setHostSettings!({ allowInstructions: ["Run the test suite"] }), read: account("allowInstructions"), want: ["Run the test suite"] },
  { control: "Auto-review rules (ask first)", save: (h) => h.setHostSettings!({ blockInstructions: ["Push to main"] }), read: account("blockInstructions"), want: ["Push to main"] },
  { control: "Theme", save: (h) => h.setHostSettings!({ themePreference: "dark" }), read: account("themePreference"), want: "dark" },
  { control: "Save usage (account)", save: (h) => h.setHostSettings!({ saveUsage: true }), read: account("saveUsage"), want: true },
  { control: "Show advanced controls", save: (h) => h.setHostSettings!({ advancedEnabled: true }), read: account("advancedEnabled"), want: true },
  { control: "Per-turn recall", save: (h) => h.setHostSettings!({ memoryRecall: false }), read: account("memoryRecall"), want: false },
  // Settings → Usage → Savings (saving-settings)
  { control: "Keep conversations ready", save: (h) => h.setHostSettings!({ promptCacheTtl: "5m" }), read: account("promptCacheTtl"), want: "5m" },
  { control: "Call replies", save: (h) => h.setHostSettings!({ callReplies: "match" }), read: account("callReplies"), want: "match" },
  { control: "Long-context model", save: (h) => h.setHostSettings!({ longContext: "when-needed" }), read: account("longContext"), want: "when-needed" },
  { control: "Webhooks on the local network", save: (h) => h.setHostSettings!({ webhookLan: true }), read: account("webhookLan"), want: true },
  { control: "Memory (Standard / Dreaming)", save: (h) => h.setMemoryMode!({ mode: "dreaming" }), read: async (h) => (await h.getPhase5Settings!({})).memoryMode, want: "dreaming" },
  // Settings → Schedules
  { control: "Daily standup", save: (h) => h.setStandupSettings!({ enabled: true, time: "08:30", weekdaysOnly: false, spoken: true }), read: async (h) => (await h.getStandup!({})).settings, want: expect.objectContaining({ enabled: true, time: "08:30", weekdaysOnly: false, spoken: true }) },
  // Sidebar pin (kept with the account settings)
  { control: "Pinned", save: (h, id) => h.setAgentPinned!({ id, pinned: true }), read: account("pinnedAgentIds"), want: expect.arrayContaining([expect.any(String)]) },
  // Bot settings
  { control: "Bot name", save: (h, id) => h.updateAgent!({ id, name: "Chief of Staff" }), read: async (h, id) => (await botOf(h, id)).profile.name, want: "Chief of Staff" },
  { control: "Model", save: (h, id) => h.updateAgent!({ id, model: "claude-opus-5" }), read: async (h, id) => (await botOf(h, id)).profile.model, want: "claude-opus-5" },
  { control: "Effort", save: (h, id) => h.updateAgent!({ id, effort: "max" }), read: async (h, id) => (await botOf(h, id)).profile.effort, want: "max" },
  { control: "Notifications", save: (h, id) => h.setAgentNotificationsEnabled!({ id, enabled: false }), read: botSetting("notifyOnAgentUpdates"), want: false },
  { control: "Engineering mode", save: (h, id) => h.setAgentEngineeringMode!({ id, enabled: true }), read: botSetting("engineeringMode"), want: true },
  { control: "Permission mode", save: (h, id) => h.setAgentPermMode!({ id, mode: "full-auto" }), read: botSetting("permMode"), want: "full-auto" },
  { control: "No limits", save: (h, id) => h.setAgentNoLimits!({ id, enabled: true, confirm: NO_LIMITS_CONFIRM }), read: botSetting("noLimits"), want: true },
  { control: "Save usage (Bot)", save: (h, id) => h.setAgentSaveUsage!({ id, enabled: true }), read: botSetting("saveUsage"), want: true },
  { control: "Google", save: (h, id) => h.setAgentGoogle!({ id, enabled: true }), read: botSetting("google"), want: true },
  { control: "Proactive follow-ups", save: (h, id) => h.setAgentFollowups!({ id, enabled: true }), read: async (h, id) => (await botOf(h, id)).settings.advanced?.followups, want: true },
  { control: "Keep more history", save: (h, id) => h.setAgentHistoryKeep!({ id, keep: "full" }), read: async (h, id) => (await botOf(h, id)).settings.advanced?.historyKeep, want: "full" },
  { control: "Voice", save: (h, id) => h.setAgentVoice!({ id, voice: "kokoro:af_heart" }), read: botSetting("voice"), want: "kokoro:af_heart" },
  { control: "Speed", save: (h, id) => h.setAgentVoice!({ id, speechRate: 1.25 }), read: botSetting("speechRate"), want: 1.25 },
  { control: "Spoken language", save: (h, id) => h.setAgentVoice!({ id, spokenLanguage: "fr-FR" }), read: botSetting("spokenLanguage"), want: "fr-FR" },
  { control: "May call you", save: (h, id) => h.setBotCallPermission!({ id, mayCall: true }), read: botSetting("mayCall"), want: true },
];

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("every host-kept Settings control round-trips through save → host restart → load", () => {
  it.each(ROWS)("$control", async ({ save, read, want }) => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const { id } = await app.handlers.createAgent!({ name: "Probe" });
    await save(app.handlers, id);
    await app.close();
    app = await createHostApp(cfg);
    expect(await read(app.handlers, id)).toEqual(want);
  });
});

describe("the account settings carry their age (rev), so the app can drop a stale answer", () => {
  it("every save bumps rev, and a restart keeps counting from where it was", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const r0 = (await app.handlers.getHostSettings!({})).rev ?? -1;
    const r1 = (await app.handlers.setHostSettings!({ themePreference: "light" })).rev ?? -1;
    const r2 = (await app.handlers.setHostSettings!({ themePreference: "dark" })).rev ?? -1;
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    await app.close();
    app = await createHostApp(cfg);
    expect((await app.handlers.getHostSettings!({})).rev).toBe(r2);
    expect((await app.handlers.setHostSettings!({ themePreference: "system" })).rev).toBeGreaterThan(r2);
  });

  it("each host run is a new epoch (so a quarantined file's rev 0 is still taken), and a Bot's rev only ever grows", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    app = await createHostApp(cfg);
    const e1 = (await app.handlers.getHostSettings!({})).epoch;
    const { id } = await app.handlers.createAgent!({ name: "Probe" });
    const a = (await app.handlers.setAgentNotificationsEnabled!({ id, enabled: false })).agent;
    const b = (await app.handlers.setAgentEngineeringMode!({ id, enabled: true })).agent;
    expect(typeof a.rev).toBe("number");
    expect(b.rev!).toBeGreaterThan(a.rev!);
    expect(b.epoch).toBe(a.epoch);
    await app.close();
    app = await createHostApp(cfg);
    expect((await app.handlers.getHostSettings!({})).epoch).not.toBe(e1);
    expect((await botOf(app.handlers, id)).epoch).not.toBe(b.epoch);
  });
});
