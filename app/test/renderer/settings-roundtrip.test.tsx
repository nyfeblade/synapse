// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, STRB, STRG, STRMA, STRS, STRV, type BotSummary, type HostSettingsView } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { AutoReviewSection, GeneralSection } from "../../src/renderer/components/settings/GeneralSection";
import { AppearanceBlock } from "../../src/renderer/components/settings/AppearanceBlock";
import { MemoryBlock } from "../../src/renderer/components/settings/MemoryBlock";
import { SchedulesSection } from "../../src/renderer/components/settings/SchedulesSection";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";
import { UpdatesSection } from "../../src/renderer/components/settings/UpdatesSection";
import { CallFeelCard } from "../../src/renderer/voice/CallFeelCard";
import { WakeWordCard } from "../../src/renderer/voice/WakeWordCard";
import { BotCallsCard } from "../../src/renderer/voice/BotCallsCard";
import { WhisperCard } from "../../src/renderer/voice/WhisperCard";
import { VoiceSection } from "../../src/renderer/components/settings/VoiceSection";
import { useStandup } from "../../src/renderer/standup/store";
import { useUpdates } from "../../src/renderer/updates/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

/**
 * settings-persist: the table the bug asked for. Every Settings control, changed through its own UI, then the
 * app is RELOADED (every renderer store back to its first-launch state, the startup load run again, the
 * component mounted fresh) against a backend that keeps only what was saved. The control must come back
 * showing the saved value. The backend here stands in for the host / coordinator / main process with their
 * own semantics; each of those is round-tripped for real in host/test/store/settings-roundtrip.test.ts,
 * app/test/coordinator/ability-persist.test.ts and app/test/main/app-settings-roundtrip.test.ts.
 */

// ---- a backend that keeps only what was saved -------------------------------------------------------------
interface Saved {
  settings: HostSettingsView; bot: BotSummary; memoryMode: string; standup: { enabled: boolean; time: string; weekdaysOnly: boolean; spoken: boolean };
  grants: Set<string>; mac: Record<string, unknown>; macMode: string;
}
let saved: Saved;
let clock = 100;
const bump = (bot: BotSummary, patch: Partial<BotSummary["settings"]>, profile: Partial<BotSummary["profile"]> = {}) =>
  ({ ...bot, updatedAt: ++clock, rev: clock, epoch: "e1", settings: { ...bot.settings, ...patch }, profile: { ...bot.profile, ...profile } });

function fresh(): Saved {
  return {
    settings: { autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "UTC", userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false, saveUsage: false, rev: 1 },
    bot: {
      id: "b1", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, lastBotMessageAt: 0,
      profile: { name: "Chief of Staff", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
      settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
    } as BotSummary,
    memoryMode: "standard",
    standup: { enabled: false, time: "09:00", weekdaysOnly: true, spoken: false },
    grants: new Set(),
    mac: {},
    macMode: "ask",
  };
}

const host: Record<string, (a: Record<string, unknown>) => unknown> = {
  listAgents: () => ({ agents: [saved.bot], activeAgentId: null }),
  getHostSettings: () => saved.settings,
  setHostSettings: (a) => {
    const { userTimeZone, ...rest } = a;
    saved.settings = { ...saved.settings, ...rest, ...(userTimeZone !== undefined ? { userTimeZoneOverride: (userTimeZone as string) || null } : {}), rev: (saved.settings.rev ?? 0) + 1 };
    return saved.settings;
  },
  getTrays: () => ({ trays: [] }),
  getTeachRecordingStatus: () => ({ status: undefined }),
  updateAgent: (a) => { const { id: _id, ...p } = a; saved.bot = bump(saved.bot, {}, p as never); return { agent: saved.bot }; },
  setAgentNotificationsEnabled: (a) => { saved.bot = bump(saved.bot, { notifyOnAgentUpdates: a.enabled as boolean }); return { agent: saved.bot }; },
  setAgentEngineeringMode: (a) => { saved.bot = bump(saved.bot, { engineeringMode: a.enabled as boolean }); return { agent: saved.bot }; },
  setAgentPermMode: (a) => { saved.bot = bump(saved.bot, { permMode: a.mode as never }); saved.macMode = a.mode as string; return { agent: saved.bot }; },
  getLocalBotMode: () => ({ mode: saved.macMode }),
  setAgentSaveUsage: (a) => { saved.bot = bump(saved.bot, { saveUsage: a.enabled as boolean }); return { agent: saved.bot }; },
  setAgentGoogle: (a) => { saved.bot = bump(saved.bot, { google: a.enabled as boolean }); return { agent: saved.bot }; },
  setAgentFollowups: (a) => { saved.bot = bump(saved.bot, { advanced: { ...saved.bot.settings.advanced, followups: a.enabled as boolean } }); return { agent: saved.bot }; },
  setAgentHistoryKeep: (a) => { saved.bot = bump(saved.bot, { advanced: { ...saved.bot.settings.advanced, historyKeep: a.keep as never } }); return { agent: saved.bot }; },
  setAgentVoice: (a) => { const { id: _id, ...p } = a; saved.bot = bump(saved.bot, p as never); return { agent: saved.bot }; },
  setBotCallPermission: (a) => { saved.bot = bump(saved.bot, { mayCall: a.mayCall as never }); return {}; },
  getLocalBrowserAllowed: () => ({ allowed: saved.grants.has("browser") }),
  setLocalBrowserAllowed: (a) => { if (a.allowed) saved.grants.add("browser"); else saved.grants.delete("browser"); return { allowed: saved.grants.has("browser") }; },
  getLocalMacAppAllowed: () => ({ allowed: saved.grants.has("mac-app") }),
  setLocalMacAppAllowed: (a) => { if (a.allowed) saved.grants.add("mac-app"); else saved.grants.delete("mac-app"); return { allowed: saved.grants.has("mac-app") }; },
  getPhase5Settings: () => ({ memoryMode: saved.memoryMode, hasSeenOnboarding: true, advancedEnabled: saved.settings.advancedEnabled }),
  setMemoryMode: (a) => { saved.memoryMode = a.mode as string; return host.getPhase5Settings!({}); },
  getStandup: () => ({ settings: saved.standup, latest: null }),
  setStandupSettings: (a) => { saved.standup = { ...saved.standup, ...a }; return host.getStandup!({}); },
  listAllAutomations: () => ({ routines: [] }),
  getLocalComputer: () => ({ computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/alex", autoRunRoots: [] } }),
  getNetworkStats: () => ({ routedThisSession: 0 }),
  getAgentContext: () => null,
  getGoogleStatus: () => ({ state: "disconnected" }),
};
const macGet = (k: string, dflt: unknown) => (k in saved.mac ? saved.mac[k] : dflt);
const macSet = (k: string, v: unknown) => { saved.mac[k] = v; return v; };
const native: Record<string, (a: Record<string, unknown>) => unknown> = {
  "keepBoxOnQuit.get": () => ({ on: macGet("keepBoxOnQuit", true) }),
  "keepBoxOnQuit.set": (a) => ({ on: macSet("keepBoxOnQuit", a.on) }),
  "kokoro.keepReady.get": () => ({ on: macGet("keepVoiceReady", true) }),
  "kokoro.keepReady.set": (a) => ({ on: macSet("keepVoiceReady", a.on) }),
  "calls.sounds.get": () => ({ on: macGet("callSounds", true) }),
  "calls.sounds.set": (a) => ({ on: macSet("callSounds", a.on) }),
  "calls.shortcut.get": () => ({ accelerator: macGet("callShortcut", "Alt+CommandOrControl+C") }),
  "calls.quiet.get": () => ({ quietHours: macGet("quietHours", { start: "22:00", end: "08:00" }) }),
  "calls.quiet.set": (a) => ({ quietHours: macSet("quietHours", a.quietHours) }),
  "wake.get": () => ({ enabled: macGet("wakeWord", false), pauseOnBattery: macGet("wakePauseOnBattery", true), listening: false, pausedFor: [], error: null, names: 1 }),
  "wake.set": (a) => {
    if (a.enabled !== undefined) macSet("wakeWord", a.enabled);
    if (a.pauseOnBattery !== undefined) macSet("wakePauseOnBattery", a.pauseOnBattery);
    return native["wake.get"]!({});
  },
  "whisper.status.get": () => ({ state: "ready", name: "large-v3-turbo", size: "574 MB", inCalls: macGet("whisperInCalls", false), root: "/x" }),
  "whisper.inCalls.set": (a) => ({ on: macSet("whisperInCalls", a.on) }),
  "voiceMode.get": () => ({ mode: macGet("voiceMode", "full") }),
  "voiceMode.set": (a) => ({ mode: macSet("voiceMode", a.mode) }),
  "audio.voices.list": () => ({ voices: [{ id: "com.apple.voice.premium.en-US.Ava", name: "Ava", lang: "en-US", quality: "premium" }, { id: "com.apple.voice.enhanced.en-GB.Daniel", name: "Daniel", lang: "en-GB", quality: "enhanced" }], chosen: macGet("ttsVoice", null) }),
  "audio.voice.set": (a) => ({ voice: macSet("ttsVoice", a.voice) }),
  "audio.devices.list": () => ({ devices: [], prefs: { input: null, output: null } }),
  "kokoro.status": () => ({ state: "missing", voices: [] }),
  "qwen.status": () => ({ state: "missing", voices: [] }),
  "updates.get": () => ({ version: "1.0.0", track: "stable", auto: macGet("autoUpdate", false), feed: null, status: "idle", latest: null, error: null }),
  "updates.setAuto": (a) => { macSet("autoUpdate", a.on); return native["updates.get"]!({}); },
  "phone.status": () => ({ state: "off" }),
};

beforeEach(() => {
  saved = fresh();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      const h = host[cmd];
      return { ok: true, result: h ? structuredClone(h(a ?? {})) : {} };
    }),
    native: {
      invoke: vi.fn(async (name: string, a: Record<string, unknown>) => {
        const h = native[name];
        return { ok: true, result: h ? structuredClone(h(a ?? {})) : {} };
      }),
      on: () => () => {},
    },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    secrets: { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn() },
  };
});
afterEach(cleanup);

/** A reload: every renderer store back to how a fresh launch starts, then the startup load. */
async function reload(): Promise<void> {
  cleanup();
  useStandup.setState({ view: null, error: null });
  useUpdates.setState({ state: null });
  useUi.setState({ ...initialState(), connection: { kind: "connected" } as never });
  await act(async () => { await useUi.getState().loadAll(); });
}

const sw = (name: string) => screen.findByRole("switch", { name });
const isOn = async (name: string) => { const el = await sw(name); await vi.waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false)); return el.getAttribute("aria-checked"); };
const flip = async (name: string) => { const el = await sw(name); await vi.waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(el); };
const pick = async (name: string, value: string) => { const el = await screen.findByRole("combobox", { name }); fireEvent.change(el, { target: { value } }); };
const selected = async (name: string) => ((await screen.findByRole("combobox", { name })) as HTMLSelectElement).value;
const advancedOn = () => { saved.settings = { ...saved.settings, advancedEnabled: true }; };

interface Row { control: string; ui: () => ReactElement; before?: () => void; change: () => Promise<void>; stored: () => unknown; want: unknown; shows: () => Promise<unknown>; showsWant: unknown }

const panel = () => <BotSettingsPanel botId="b1" />;
const ROWS: Row[] = [
  // Settings → General
  { control: "Timezone", ui: () => <GeneralSection />, change: () => pick(STR.timezone, "Europe/Paris"), stored: () => saved.settings.userTimeZoneOverride, want: "Europe/Paris", shows: () => selected(STR.timezone), showsWant: "Europe/Paris" },
  { control: "Auto-review", ui: () => <AutoReviewSection />, change: () => flip(STR.autoReview), stored: () => saved.settings.autoReviewEnabled, want: false, shows: () => isOn(STR.autoReview), showsWant: "false" },
  { control: "Save usage (account)", ui: () => <GeneralSection />, change: () => flip(`${STR.saveUsage}: ${STR.saveUsageHint.toLowerCase()}`), stored: () => saved.settings.saveUsage, want: true, shows: () => isOn(`${STR.saveUsage}: ${STR.saveUsageHint.toLowerCase()}`), showsWant: "true" },
  { control: "Show advanced controls", ui: () => <GeneralSection />, change: () => flip(STR.showAdvanced), stored: () => saved.settings.advancedEnabled, want: true, shows: () => isOn(STR.showAdvanced), showsWant: "true" },
  { control: "Per-turn recall", ui: () => <GeneralSection />, before: advancedOn, change: () => flip(STR.perTurnRecall), stored: () => saved.settings.memoryRecall, want: false, shows: () => isOn(STR.perTurnRecall), showsWant: "false" },
  { control: "Theme", ui: () => <AppearanceBlock />, change: () => pick(STR.theme, "dark"), stored: () => saved.settings.themePreference, want: "dark", shows: () => selected(STR.theme), showsWant: "dark" },
  { control: "Memory", ui: () => <MemoryBlock />, change: () => pick(STR5.memory, "dreaming"), stored: () => saved.memoryMode, want: "dreaming", shows: () => selected(STR5.memory), showsWant: "dreaming" },
  // Settings → Schedules
  { control: "Daily standup", ui: () => <SchedulesSection />, change: async () => { const el = await screen.findByRole("switch", { name: STRS.standup }); await vi.waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(el); }, stored: () => saved.standup.enabled, want: true, shows: async () => { const el = await screen.findByRole("switch", { name: STRS.standup }); await vi.waitFor(() => expect((el as HTMLButtonElement).disabled).toBe(false)); return el.getAttribute("aria-checked"); }, showsWant: "true" },
  // Settings → Computer
  { control: "Keep Bots running when the app quits", ui: () => <ComputerSection />, change: () => flip(STR5.keepBoxOnQuit), stored: () => saved.mac.keepBoxOnQuit, want: false, shows: () => isOn(STR5.keepBoxOnQuit), showsWant: "false" },
  // Settings → Voice
  { control: "Voice mode", ui: () => <VoiceSection />, change: async () => { fireEvent.click(within(await screen.findByRole("radiogroup", { name: STR5.voiceModeLabel })).getByRole("radio", { name: STR5.voiceModeLight })); }, stored: () => saved.mac.voiceMode, want: "light", shows: async () => { const g = await screen.findByRole("radiogroup", { name: STR5.voiceModeLabel }); await vi.waitFor(() => expect(within(g).getByRole("radio", { name: STR5.voiceModeLight }).getAttribute("aria-checked")).toBe("true")); return "light"; }, showsWant: "light" },
  { control: "Call voice", ui: () => <VoiceSection />, change: async () => { await screen.findByRole("option", { name: /Daniel/ }); await pick(STR5.callVoice, "com.apple.voice.enhanced.en-GB.Daniel"); }, stored: () => saved.mac.ttsVoice, want: "com.apple.voice.enhanced.en-GB.Daniel", shows: async () => { await vi.waitFor(async () => expect(await selected(STR5.callVoice)).toBe("com.apple.voice.enhanced.en-GB.Daniel")); return "ok"; }, showsWant: "ok" },
  { control: "Hey <Bot name>", ui: () => <WakeWordCard />, change: () => flip(STRV.wakeWord), stored: () => saved.mac.wakeWord, want: true, shows: () => isOn(STRV.wakeWord), showsWant: "true" },
  { control: "Pause on battery", ui: () => <WakeWordCard />, before: () => { saved.mac.wakeWord = true; }, change: () => flip(STRV.wakePauseOnBattery), stored: () => saved.mac.wakePauseOnBattery, want: false, shows: () => isOn(STRV.wakePauseOnBattery), showsWant: "false" },
  { control: "Quiet hours", ui: () => <BotCallsCard />, change: () => flip(STRV.quietHours), stored: () => saved.mac.quietHours, want: null, shows: () => isOn(STRV.quietHours), showsWant: "false" },
  { control: "May call you", ui: () => <BotCallsCard />, change: () => pick(STRV.mayCall("Chief of Staff"), "yes"), stored: () => saved.bot.settings.mayCall, want: true, shows: () => selected(STRV.mayCall("Chief of Staff")), showsWant: "yes" },
  { control: "Keep voice ready", ui: () => <CallFeelCard />, change: () => flip(STRV.keepVoiceReady), stored: () => saved.mac.keepVoiceReady, want: false, shows: () => isOn(STRV.keepVoiceReady), showsWant: "false" },
  { control: "Call sounds", ui: () => <CallFeelCard />, change: () => flip(STRV.callSounds), stored: () => saved.mac.callSounds, want: false, shows: () => isOn(STRV.callSounds), showsWant: "false" },
  { control: "Whisper in calls", ui: () => <WhisperCard />, change: () => flip(STRV.whisperInCalls), stored: () => saved.mac.whisperInCalls, want: true, shows: () => isOn(STRV.whisperInCalls), showsWant: "true" },
  // Settings → Updates
  { control: "Automatic updates", ui: () => <UpdatesSection />, change: () => flip(STR5.automaticUpdates), stored: () => saved.mac.autoUpdate, want: true, shows: () => isOn(STR5.automaticUpdates), showsWant: "true" },
  // Bot settings
  { control: "Notifications", ui: panel, change: () => flip(STR.notifications), stored: () => saved.bot.settings.notifyOnAgentUpdates, want: false, shows: () => isOn(STR.notifications), showsWant: "false" },
  { control: "Engineering mode", ui: panel, change: () => flip(STR5.engineeringMode), stored: () => saved.bot.settings.engineeringMode, want: true, shows: () => isOn(STR5.engineeringMode), showsWant: "true" },
  { control: "Permission mode", ui: panel, change: () => pick(STR5.permMode, "full-auto"), stored: () => saved.bot.settings.permMode, want: "full-auto", shows: () => selected(STR5.permMode), showsWant: "full-auto" },
  { control: "Save usage (Bot)", ui: panel, change: () => flip(STR.saveUsage), stored: () => saved.bot.settings.saveUsage, want: true, shows: () => isOn(STR.saveUsage), showsWant: "true" },
  { control: "May use the browser on your Mac", ui: panel, change: () => flip(STRB.setting), stored: () => saved.grants.has("browser"), want: true, shows: () => isOn(STRB.setting), showsWant: "true" },
  { control: "May use the apps on your Mac", ui: panel, change: () => flip(STRMA.setting), stored: () => saved.grants.has("mac-app"), want: true, shows: () => isOn(STRMA.setting), showsWant: "true" },
  { control: "Google", ui: panel, change: () => flip(STRG.botToggle), stored: () => saved.bot.settings.google, want: true, shows: () => isOn(STRG.botToggle), showsWant: "true" },
  { control: "Proactive follow-ups", ui: panel, before: advancedOn, change: () => flip(STR5.proactiveFollowups), stored: () => saved.bot.settings.advanced?.followups, want: true, shows: () => isOn(STR5.proactiveFollowups), showsWant: "true" },
  { control: "Keep more history", ui: panel, before: advancedOn, change: () => pick(STR.keepMoreHistory, "full"), stored: () => saved.bot.settings.advanced?.historyKeep, want: "full", shows: () => selected(STR.keepMoreHistory), showsWant: "full" },
  { control: "Bot voice speed", ui: panel, change: async () => { const el = document.getElementById("speed") as HTMLSelectElement; fireEvent.change(el, { target: { value: "1.25" } }); }, stored: () => saved.bot.settings.speechRate, want: 1.25, shows: async () => (document.getElementById("speed") as HTMLSelectElement).value, showsWant: "1.25" },
  { control: "Model", ui: panel, change: async () => { fireEvent.click(await screen.findByRole("button", { name: /^Model: / })); fireEvent.click(screen.getByRole("option", { name: "Opus 5" })); }, stored: () => saved.bot.profile.model, want: "claude-opus-5", shows: async () => (await screen.findByRole("button", { name: /^Model: / })).getAttribute("aria-label"), showsWant: "Model: Opus 5" },
];

describe("every Settings control round-trips through save → reload", () => {
  it.each(ROWS)("$control", async ({ ui, before, change, stored, want, shows, showsWant }) => {
    before?.();
    await reload();
    render(ui());
    await change();
    await vi.waitFor(() => expect(stored()).toEqual(want));
    await reload();
    render(ui());
    expect(await shows()).toEqual(showsWant);
  });
});
