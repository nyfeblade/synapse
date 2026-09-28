// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PERMISSION_PREFIX, STR, STRB, STRMA, STRV, STR5, type BotSummary, type HostSettingsView, type LocalToolCardView } from "@synapse/shared";
import { BrowserRow } from "../../src/renderer/components/BrowserRow";
import { MacAppRow } from "../../src/renderer/components/MacAppRow";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";
import { CallFeelCard } from "../../src/renderer/voice/CallFeelCard";
import { VoiceSection } from "../../src/renderer/components/settings/VoiceSection";
import { setNotify } from "../../src/renderer/bot-actions";
import { setTheme } from "../../src/renderer/theme";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// settings-persist: "You switch something on, it stays on through reloads" — and "the turn on things in the
// settings for different abilities don't work". Each block pins one way a Settings control used to lie.

type Handler = (args: Record<string, unknown>) => unknown;
let host: Record<string, Handler> = {};
let native: Record<string, Handler> = {};
const calls: [string, unknown][] = [];

const ok = (result: unknown) => ({ ok: true as const, result });
const fail = (message: string, code = "NETWORK") => ({ ok: false as const, error: { code, message } });

beforeEach(() => {
  calls.length = 0;
  host = {};
  native = {};
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const h = host[cmd];
      if (!h) return ok({});
      try { return ok(await h(args)); } catch (e) { return fail((e as Error).message, (e as { code?: string }).code ?? "NETWORK"); }
    }),
    native: {
      invoke: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push([`native:${name}`, args]);
        const h = native[name];
        if (!h) return ok({});
        try { return ok(await h(args)); } catch (e) { return fail((e as Error).message); }
      }),
      on: () => () => {},
    },
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), connection: { kind: "connected" } as never });
});
afterEach(cleanup);

const abilityRows = [
  { name: "Browser", Row: BrowserRow, get: "getLocalBrowserAllowed", set: "setLocalBrowserAllowed", label: STRB.setting, action: "browser" as const },
  { name: "Mac apps", Row: MacAppRow, get: "getLocalMacAppAllowed", set: "setLocalMacAppAllowed", label: STRMA.setting, action: "mac-app" as const },
];

describe.each(abilityRows)("ability switch: $name", ({ Row, get, set, label, action }) => {
  it("a read that failed is shown as a failure with Retry, never as a plain Off switch", async () => {
    let stored = true;
    let up = false;
    host[get] = () => { if (!up) throw Object.assign(new Error("Not connected yet"), { code: "NOT_CONNECTED" }); return { allowed: stored }; };
    render(<Row botId="b1" />);
    expect(await screen.findByText("Not connected yet")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: label })).toBeNull(); // no Off standing in for a state nobody read
    up = true;
    fireEvent.click(screen.getByRole("button", { name: STR.retry }));
    await vi.waitFor(() => expect(screen.getByRole("switch", { name: label }).getAttribute("aria-checked")).toBe("true"));
    expect(stored).toBe(true);
  });

  it("re-reads when the app (re)connects, so a switch opened before the connection shows what is stored", async () => {
    let up = false;
    host[get] = () => { if (!up) throw Object.assign(new Error("Not connected yet"), { code: "NOT_CONNECTED" }); return { allowed: true }; };
    useUi.setState({ connection: { kind: "starting" } as never });
    render(<Row botId="b1" />);
    await screen.findByText("Not connected yet");
    up = true;
    act(() => useUi.setState({ connection: { kind: "connected" } as never }));
    await vi.waitFor(() => expect(screen.getByRole("switch", { name: label }).getAttribute("aria-checked")).toBe("true"));
  });

  it("flips at once, and a save that fails puts it back and says so", async () => {
    host[get] = () => ({ allowed: false });
    let release!: () => void;
    host[set] = () => new Promise((_, reject) => { release = () => reject(new Error("The coordinator went away")); });
    render(<Row botId="b1" />);
    const sw = await screen.findByRole("switch", { name: label });
    await vi.waitFor(() => { expect((sw as HTMLButtonElement).disabled).toBe(false); expect(sw.getAttribute("aria-checked")).toBe("false"); });
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true"); // optimistic
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => { release(); });
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("alert").textContent).toContain(STR.settingNotSaved);
  });

  it("a save the Mac did not keep (it answers Off) goes back to Off with an error, not a silent On", async () => {
    let stored = false;
    host[get] = () => ({ allowed: stored });
    host[set] = () => ({ allowed: stored }); // the write was dropped: the read-back says Off
    render(<Row botId="b1" />);
    const sw = await screen.findByRole("switch", { name: label });
    await vi.waitFor(() => { expect((sw as HTMLButtonElement).disabled).toBe(false); expect(sw.getAttribute("aria-checked")).toBe("false"); });
    fireEvent.click(sw);
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain(STR.settingNotSaved));
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("answering Always on this ability's permission card turns the open switch on without a remount", async () => {
    let stored = false;
    host[get] = () => ({ allowed: stored });
    host.resolveLocalToolPermission = () => { stored = true; return { status: "always" }; };
    const card: LocalToolCardView = { kind: "local-tool-permission", askId: "k1", action, target: `${BROWSER_PERMISSION_PREFIX}https://x.test`, description: null, status: "pending", createdAt: 1, expiresAt: 2 };
    render(<><Row botId="b1" /><LocalToolCard botId="b1" entryId="e1" card={card} /></>);
    const sw = await screen.findByRole("switch", { name: label });
    await vi.waitFor(() => { expect((sw as HTMLButtonElement).disabled).toBe(false); expect(sw.getAttribute("aria-checked")).toBe("false"); });
    fireEvent.click(screen.getAllByRole("button", { name: STR5.localAlways })[0]!);
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  });
});

const bot = (settings: Partial<BotSummary["settings"]>, rev: number, epoch = "e1"): BotSummary => ({
  rev, epoch, updatedAt: 1_000 - rev, // wall clock deliberately running backwards: only rev may decide
  id: "b1", createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, lastBotMessageAt: 0,
  profile: { name: "Chief of Staff", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, ...settings },
} as BotSummary);
const hostSettings = (p: Partial<HostSettingsView>): HostSettingsView => ({
  autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "UTC", userTimeZoneOverride: null, pinnedAgentIds: [],
  themePreference: "system", memoryRecall: true, advancedEnabled: false, epoch: "e1", ...p,
});

describe("the startup load never reverts a change made while it was in flight", () => {
  it("a Bot setting the user changed during loadAll stays changed", async () => {
    let answerList!: () => void;
    host.listAgents = () => new Promise((r) => { answerList = () => r({ agents: [bot({ engineeringMode: false }, 10)], activeAgentId: null }); });
    host.getHostSettings = () => hostSettings({});
    host.getTrays = () => ({ trays: [] });
    const load = useUi.getState().loadAll();
    await vi.waitFor(() => expect(answerList).toBeTypeOf("function"));
    // The user's switch, confirmed by the host's own event, lands before the (older) list does.
    act(() => useUi.getState().apply({ channel: "agent-upserted", payload: { agent: bot({ engineeringMode: true }, 20) } } as never));
    answerList();
    await load;
    expect(useUi.getState().bots.b1!.settings.engineeringMode).toBe(true);
  });

  it("an account setting the user changed during loadAll stays changed", async () => {
    let answerSettings!: () => void;
    host.listAgents = () => ({ agents: [], activeAgentId: null });
    host.getHostSettings = () => new Promise((r) => { answerSettings = () => r(hostSettings({ themePreference: "system", rev: 4 })); });
    host.getTrays = () => ({ trays: [] });
    const load = useUi.getState().loadAll();
    await vi.waitFor(() => expect(answerSettings).toBeTypeOf("function"));
    act(() => useUi.getState().apply({ channel: "host-settings", payload: hostSettings({ themePreference: "dark", rev: 5 }) } as never));
    answerSettings();
    await load;
    expect(useUi.getState().settings!.themePreference).toBe("dark");
  });
});

describe("a slow save's answer never overwrites a newer one", () => {
  it("Bot: an older response landing after the host's newer event is ignored", async () => {
    useUi.setState({ bots: { b1: bot({ notifyOnAgentUpdates: true }, 10) } });
    let answer!: () => void;
    host.setAgentNotificationsEnabled = () => new Promise((r) => { answer = () => r({ agent: bot({ notifyOnAgentUpdates: false }, 11) }); });
    const p = setNotify("b1", false);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    // A second switch (engineering mode) saved in the meantime: its event carries both changes.
    act(() => useUi.getState().apply({ channel: "agent-upserted", payload: { agent: bot({ notifyOnAgentUpdates: false, engineeringMode: true }, 12) } } as never));
    answer();
    await p;
    expect(useUi.getState().bots.b1!.settings.engineeringMode).toBe(true);
  });

  it("Account: an older setHostSettings response landing after a newer event is ignored", async () => {
    useUi.setState({ settings: hostSettings({ rev: 1 }) });
    let answer!: () => void;
    host.setHostSettings = () => new Promise((r) => { answer = () => r(hostSettings({ themePreference: "light", rev: 2 })); });
    const p = setTheme("light");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    act(() => useUi.getState().apply({ channel: "host-settings", payload: hostSettings({ themePreference: "light", saveUsage: true, rev: 3 }) } as never));
    answer();
    await p;
    expect(useUi.getState().settings!.saveUsage).toBe(true);
  });
});

describe("a host reset (new epoch) is taken, even though its counter starts again", () => {
  it("Account: a quarantined settings file (rev back to 0, new epoch) is accepted, not refused forever", async () => {
    useUi.setState({ settings: hostSettings({ themePreference: "dark", rev: 40 }) });
    host.setHostSettings = () => hostSettings({ themePreference: "light", rev: 1, epoch: "e2" });
    await setTheme("light");
    expect(useUi.getState().settings).toMatchObject({ themePreference: "light", epoch: "e2", rev: 1 });
  });

  it("Bot: a restarted host's first answer (rev 1, new epoch) is accepted", async () => {
    useUi.setState({ bots: { b1: bot({ notifyOnAgentUpdates: true }, 50) } });
    host.setAgentNotificationsEnabled = () => ({ agent: bot({ notifyOnAgentUpdates: false }, 1, "e2") });
    await setNotify("b1", false);
    expect(useUi.getState().bots.b1!.settings.notifyOnAgentUpdates).toBe(false);
  });
});

describe("Mac-side switches never show a default as if it were the saved value", () => {
  it("Call feel: a switch whose read failed is not drawn On; a failed save goes back and says so", async () => {
    native["calls.sounds.get"] = () => ({ on: true });
    native["calls.shortcut.get"] = () => ({ accelerator: null });
    native["kokoro.keepReady.get"] = () => { throw new Error("gone"); };
    native["calls.sounds.set"] = () => { throw new Error("disk full"); };
    render(<CallFeelCard />);
    const sounds = await screen.findByRole("switch", { name: STRV.callSounds });
    expect(screen.queryByRole("switch", { name: STRV.keepVoiceReady })).toBeNull(); // unread: no switch, not a default On
    fireEvent.click(sounds);
    await vi.waitFor(() => expect(sounds.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain(STR.settingNotSaved);
  });

  it("Call feel: a fast double-click saves once, and a failed save goes back to the CONFIRMED value", async () => {
    native["calls.sounds.get"] = () => ({ on: true });
    native["calls.shortcut.get"] = () => ({ accelerator: null });
    native["kokoro.keepReady.get"] = () => ({ on: true });
    let release!: () => void;
    native["calls.sounds.set"] = () => new Promise((_, reject) => { release = () => reject(new Error("disk full")); });
    render(<CallFeelCard />);
    const sounds = await screen.findByRole("switch", { name: STRV.callSounds });
    fireEvent.click(sounds);
    fireEvent.click(sounds);
    fireEvent.click(sounds);
    expect(calls.filter(([c]) => c === "native:calls.sounds.set")).toHaveLength(1);
    expect(sounds.getAttribute("aria-checked")).toBe("false");
    await act(async () => { release(); });
    await vi.waitFor(() => expect(sounds.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("alert").textContent).toContain(STR.settingNotSaved);
  });

  it("Voice mode shows neither choice until the saved mode is read (it used to draw Full)", async () => {
    let answer!: () => void;
    native["voiceMode.get"] = () => new Promise((r) => { answer = () => r({ mode: "light" }); });
    render(<VoiceSection />);
    const group = await screen.findByRole("radiogroup", { name: STR5.voiceModeLabel });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    await act(async () => { answer(); });
    await vi.waitFor(() => expect(within(group).getByRole("radio", { name: STR5.voiceModeLight }).getAttribute("aria-checked")).toBe("true"));
  });

  it("an ability switch still being read is a neutral placeholder, not an Off switch", async () => {
    host.getLocalBrowserAllowed = () => new Promise(() => {});
    render(<BrowserRow botId="b1" />);
    expect(await screen.findByRole("status", { name: STRB.setting })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: STRB.setting })).toBeNull();
  });

  it("Computer (bug 225): a permission key file that can't be trusted shows the reason and Reset permissions, which clears it", async () => {
    host.getLocalComputer = () => ({ computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/alex" } });
    host.getNetworkStats = () => ({ routedThisSession: 0 });
    let broken = true;
    host.getLocalPolicyStatus = () => (broken ? { ok: false, reason: STR5.localPolicyKeyBroken } : { ok: true });
    host.resetLocalPolicy = () => { broken = false; return { ok: true }; };
    native["keepBoxOnQuit.get"] = () => ({ on: false });
    render(<ComputerSection />);
    expect(await screen.findByText(STR5.localPolicyKeyBroken)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR5.resetPermissions }));
    await vi.waitFor(() => expect(screen.queryByText(STR5.localPolicyKeyBroken)).toBeNull());
    expect(calls.map((c) => c[0])).toContain("resetLocalPolicy");
    expect(screen.queryByRole("button", { name: STR5.resetPermissions })).toBeNull();
  });

  it("Computer: Keep Bots running is not drawn On when its read failed; a failed save goes back and says so", async () => {
    host.getLocalComputer = () => ({ computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/alex" } });
    host.getNetworkStats = () => ({ routedThisSession: 0 });
    let readOk = false;
    native["keepBoxOnQuit.get"] = () => { if (!readOk) throw new Error("gone"); return { on: false }; };
    native["keepBoxOnQuit.set"] = () => { throw new Error("disk full"); };
    const first = render(<ComputerSection />);
    await screen.findByText(STR.settingNotLoaded);
    expect(screen.queryByRole("switch", { name: STR5.keepBoxOnQuit })).toBeNull();
    first.unmount();
    readOk = true;
    render(<ComputerSection />);
    const again = await screen.findByRole("switch", { name: STR5.keepBoxOnQuit });
    await vi.waitFor(() => expect(again.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(again);
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toContain(STR.settingNotSaved));
    expect(again.getAttribute("aria-checked")).toBe("false");
  });
});
