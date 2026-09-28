// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, type BotSummary, type RoutineView, type SendMessageEntry } from "@synapse/shared";
import { ConnectListenerCard } from "../../src/renderer/components/ConnectListenerCard";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { RoutineDetail } from "../../src/renderer/components/RoutineDetail";
import { RoutinesSection } from "../../src/renderer/components/RoutinesSection";
import { applyEvent, initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";

const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0,
};
const routine = (over: Partial<RoutineView> = {}): RoutineView => ({
  botId: "a", id: "morning-inbox-sweep", name: "Morning inbox sweep", prompt: "Archive newsletters.", enabled: true, triggerKind: "schedule",
  schedule: "0 8 * * *", scheduleRaw: "CRON_TZ=America/New_York 0 8 * * *", description: "Every day at 8:00 AM", nextRunAt: null, lastRunAt: null,
  createdAt: 0, runs: [], webhook: null, trigger: null, listenerConnected: null, ...over,
});
const calls: [string, Record<string, unknown>][] = [];
let reply: (cmd: string, args: Record<string, unknown>) => unknown = () => ({});
const clip = vi.fn(async () => {});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({});
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clip }, configurable: true });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      const r = reply(cmd, args);
      if (r instanceof Error) return { ok: false, error: { code: "BAD_SCHEDULE", message: r.message } };
      return { ok: true, result: r };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), vncUrl: () => null,
  };
  useUi.setState({ ...initialState(), bots: { a: bot }, settings: { autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "America/New_York", userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system", memoryRecall: true, advancedEnabled: false, smartGroupTurns: false, teachSidecar: true, publicWebhook: { enabled: false, url: null } } });
});
afterEach(cleanup);

describe("Routines section (RTN-03, C4)", () => {
  it("shows the empty-state copy after loading", async () => {
    reply = (cmd) => (cmd === "getAgentAutomations" ? { routines: [] } : {});
    render(<RoutinesSection botId="a" />);
    expect(await screen.findByText(STR.routinesEmpty)).toBeTruthy();
    expect(calls[0]).toEqual(["getAgentAutomations", { id: "a" }]);
  });

  it("shows plain English with the raw CRON_TZ as the tooltip, and Paused for inactive routines", async () => {
    const list = [routine(), routine({ id: "friday", name: "Friday follow-ups", enabled: false })];
    reply = (cmd) => (cmd === "getAgentAutomations" ? { routines: list } : {});
    render(<RoutinesSection botId="a" />);
    const when = await screen.findByText("Every day at 8:00 AM");
    expect(when.getAttribute("title")).toBe("CRON_TZ=America/New_York 0 8 * * *");
    expect(screen.getByText(STR.paused)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Morning inbox sweep/ }));
    expect(useUi.getState()).toMatchObject({ panel: "routine", routineId: "morning-inbox-sweep" });
  });

  it("DetailsPanel swaps to the routine detail and back", async () => {
    reply = (cmd) => (cmd === "getAgentAutomations" ? { routines: [routine()] } : {});
    useUi.setState({ routines: { a: [routine()] }, panel: "routine", routineId: "morning-inbox-sweep" });
    render(<DetailsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Back to details" }));
    expect(useUi.getState()).toMatchObject({ panel: "details", routineId: null });
  });

  it("the automations SSE channel replaces a Bot's routines", () => {
    const s = applyEvent(initialState(), { channel: "automations", payload: { botId: "a", routines: [routine()] } });
    expect(s.routines.a).toHaveLength(1);
  });
});

describe("Routine detail (RTN-03, RTN-18, RTN-24)", () => {
  const renderDetail = (r = routine()) => {
    useUi.setState({ routines: { a: [r] }, panel: "routine", routineId: r.id });
    const onBack = vi.fn();
    render(<RoutineDetail botId="a" routineId={r.id} onBack={onBack} />);
    return onBack;
  };

  it("saves name and instruction on blur, toggles Active, runs a Test run and deletes once confirmed (UI polish pass: a destructive act asks first)", async () => {
    window.confirm = () => true; // no ConfirmHost mounted here, so askConfirm falls back to the platform confirm
    reply = (cmd) => (cmd === "runAgentAutomationNow" ? { runId: "r1" } : cmd === "deleteAgentAutomation" ? {} : { routine: routine() });
    const onBack = renderDetail();
    const name = screen.getByLabelText("Routine name");
    fireEvent.change(name, { target: { value: "Inbox sweep" } });
    fireEvent.blur(name);
    const instr = screen.getByLabelText(STR.instruction);
    fireEvent.change(instr, { target: { value: "Archive newsletters and receipts." } });
    fireEvent.blur(instr);
    fireEvent.click(screen.getByRole("switch", { name: STR.active }));
    expect(screen.getByText(STR.testRunWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR.testRun }));
    expect(screen.getByText(STR.routineUsageHelp)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR.deleteRoutine }));
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(calls).toEqual([
      ["updateAgentAutomation", { id: "a", routineId: "morning-inbox-sweep", name: "Inbox sweep" }],
      ["updateAgentAutomation", { id: "a", routineId: "morning-inbox-sweep", prompt: "Archive newsletters and receipts." }],
      ["setAgentAutomationEnabled", { id: "a", routineId: "morning-inbox-sweep", enabled: false }],
      ["runAgentAutomationNow", { id: "a", routineId: "morning-inbox-sweep" }],
      ["deleteAgentAutomation", { id: "a", routineId: "morning-inbox-sweep" }],
    ]);
  });

  it("rapid Active clicks flip what the user sees each time and reach the host in click order (e2e S15 flake)", async () => {
    // The host answers slowly: every click lands before the previous write returns.
    const gates: (() => void)[] = [];
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      await new Promise<void>((res) => gates.push(res));
      return { ok: true, result: { routine: routine({ enabled: args.enabled as boolean }) } };
    });
    renderDetail();
    const sw = screen.getByRole("switch", { name: STR.active });
    for (let i = 0; i < 3; i++) fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false"); // on → off → on → off, shown at once
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1)); // one write in flight at a time
      gates[i]!();
    }
    await vi.waitFor(() => expect(useUi.getState().routines.a![0]!.enabled).toBe(false));
    expect(calls.map(([, a]) => a.enabled)).toEqual([false, true, false]);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the raw expression in the tooltip (C4) and shows the host's schedule error when a new schedule is rejected", async () => {
    reply = (cmd) => (cmd === "updateAgentAutomation" ? new Error(STR.scheduleSpacing) : {});
    renderDetail();
    expect(screen.queryByText("CRON_TZ=America/New_York 0 8 * * *")).toBeNull();
    const when = screen.getByLabelText(STR.whenToRun);
    expect(when.getAttribute("title")).toBe("CRON_TZ=America/New_York 0 8 * * *");
    fireEvent.change(when, { target: { value: "every minute" } });
    fireEvent.blur(when);
    expect((await screen.findByRole("alert")).textContent).toBe(STR.scheduleSpacing);
  });

  it("run history: No runs yet, statuses, and right-click Copy request ID", async () => {
    renderDetail();
    expect(screen.getByText(STR.noRunsYet)).toBeTruthy();
    cleanup();
    renderDetail(routine({ runs: [
      { id: "x1", trigger: "schedule", startedAt: Date.UTC(2026, 8, 19, 12), finishedAt: Date.UTC(2026, 8, 19, 12, 2), status: "ok", requestId: "req_ok" },
      { id: "x2", trigger: "manual", startedAt: Date.UTC(2026, 8, 18, 12), finishedAt: Date.UTC(2026, 8, 18, 12, 1), status: "error", detail: STR.runHardLimit, requestId: "req_err" },
    ] }));
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.getByText(STR.runHardLimit)).toBeTruthy();
    fireEvent.contextMenu(screen.getByText("Failed"));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.copyRequestId }));
    expect(clip).toHaveBeenCalledWith("req_err");
  });

  it("webhook routines: Available after save, then click-to-copy fields and Rotate", async () => {
    renderDetail(routine({ triggerKind: "webhook", schedule: null, scheduleRaw: null, description: "When a webhook is received" }));
    expect(screen.getByText(STR.availableAfterSave)).toBeTruthy();
    cleanup();
    reply = (cmd) => (cmd === "rotateAutomationWebhookKey" ? { url: "http://box.local:47801/hooks/u1", key: "bot_NEWKEY", header: "Authorization: Bearer bot_NEWKEY" }
      : cmd === "setHostSettings" ? { ...useUi.getState().settings, publicWebhook: { enabled: true, url: null } } : {});
    renderDetail(routine({ triggerKind: "webhook", schedule: null, scheduleRaw: null, description: "When a webhook is received", webhook: { url: "http://box.local:47801/hooks/u1", keyPreview: "…abcd", header: "Authorization: Bearer …abcd" } }));
    fireEvent.click(screen.getByRole("button", { name: `${STR.postTo} http://box.local:47801/hooks/u1` }));
    expect(clip).toHaveBeenCalledWith("http://box.local:47801/hooks/u1");
    fireEvent.click(screen.getByRole("button", { name: STR.rotateKey }));
    expect(await screen.findByRole("button", { name: `${STR.webhookKey} bot_NEWKEY` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${STR.webhookHeader} Authorization: Bearer bot_NEWKEY` }));
    expect(clip).toHaveBeenLastCalledWith("Authorization: Bearer bot_NEWKEY");
    fireEvent.click(screen.getByRole("switch", { name: STR.publicWebhookUrl }));
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["setHostSettings", { publicWebhook: { enabled: true, url: null } }]));
  });

  it("rapid Public webhook URL clicks flip what the user sees each time and reach the host in click order (controller ruling 2)", async () => {
    const gates: (() => void)[] = [];
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      await new Promise<void>((res) => gates.push(res));
      return { ok: true, result: { ...useUi.getState().settings, publicWebhook: { enabled: (args.publicWebhook as { enabled: boolean }).enabled, url: null } } };
    });
    renderDetail(routine({ triggerKind: "webhook", schedule: null, scheduleRaw: null, description: "When a webhook is received", webhook: { url: "http://box.local:47801/hooks/u1", keyPreview: "…abcd", header: "Authorization: Bearer …abcd" } }));
    const sw = screen.getByRole("switch", { name: STR.publicWebhookUrl });
    for (let i = 0; i < 3; i++) fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true"); // off → on → off → on, shown at once
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1)); // one write in flight at a time
      gates[i]!();
    }
    await vi.waitFor(() => expect(useUi.getState().settings?.publicWebhook?.enabled).toBe(true));
    expect(calls.map(([, a]) => (a.publicWebhook as { enabled: boolean }).enabled)).toEqual([true, false, true]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("rapid webhook-LAN clicks flip what the user sees each time and reach the host in click order (controller ruling 2)", async () => {
    const gates: (() => void)[] = [];
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      await new Promise<void>((res) => gates.push(res));
      return { ok: true, result: { ...useUi.getState().settings, webhookLan: args.webhookLan as boolean } };
    });
    renderDetail(routine({ triggerKind: "webhook", schedule: null, scheduleRaw: null, description: "When a webhook is received", webhook: { url: "http://box.local:47801/hooks/u1", keyPreview: "…abcd", header: "Authorization: Bearer …abcd" } }));
    const sw = screen.getByRole("switch", { name: "Reachable on your local network" });
    for (let i = 0; i < 3; i++) fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true"); // off → on → off → on, shown at once
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1)); // one write in flight at a time
      gates[i]!();
    }
    await vi.waitFor(() => expect(useUi.getState().settings?.webhookLan).toBe(true));
    expect(calls.map(([, a]) => a.webhookLan)).toEqual([true, false, true]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("a LAN switch the host could not honour says why on its own row, and the switch is the retry (bug 52)", async () => {
    const why = STR.webhookLanFailed("EADDRINUSE", true);
    renderDetail(routine({ triggerKind: "webhook", schedule: null, scheduleRaw: null, description: "When a webhook is received", webhook: { url: "http://box.local:47801/hooks/u1", keyPreview: "…abcd", header: "Authorization: Bearer …abcd" } }));
    expect(screen.queryByText(why), "must not fire: nothing has failed yet").toBeNull();
    act(() => { useUi.setState({ settings: { ...useUi.getState().settings!, webhookLan: false, webhookLanError: why } }); });
    const sw = screen.getByRole("switch", { name: "Reachable on your local network" });
    expect(sw.getAttribute("aria-checked"), "the switch shows what is bound, not what was asked for").toBe("false");
    expect(screen.getByText(why), "the switch flipped back OFF with no word of why").toBeTruthy();
    expect(sw.getAttribute("aria-describedby"), "the reason is tied to the control it is about").toBeTruthy();
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)?.textContent).toContain(why);
  });

  it("email routines: no claude.ai connector poll note (API key only), and the mailbox form saves", async () => {
    reply = (cmd) => (cmd === "addMailbox" ? { mailboxes: [{ label: "work", host: "imap.x.com", user: "me" }] } : {});
    renderDetail(routine({ triggerKind: "email", trigger: { email: { account: "work", query: "is:unread" } }, schedule: null, scheduleRaw: null, description: "When an email in work matches “is:unread”" }));
    expect(document.body.textContent).not.toMatch(/Claude usage/);
    fireEvent.click(screen.getByRole("button", { name: STR.addMailbox }));
    fireEvent.change(screen.getByLabelText("Mailbox label"), { target: { value: "work" } });
    fireEvent.change(screen.getByLabelText("IMAP host"), { target: { value: "imap.x.com" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "me" } });
    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mailbox" }));
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["addMailbox", { id: "a", label: "work", host: "imap.x.com", port: 993, user: "me", appPassword: "pw" }]));
  });
});

describe("Connect-listener card (RTN-12)", () => {
  it("renders in the transcript and saves Slack credentials", async () => {
    reply = (cmd) => (cmd === "setListenerCredentials" ? { connected: true } : {});
    const entry: SendMessageEntry = { kind: "send-message", id: "t4a1", requestId: "listener-slack", createdAt: 0, message: { type: "card", card: { kind: "connect-listener", platform: "slack", routineId: "ops", routineName: "Ops mentions", connected: false } } };
    expect(buildTranscriptItems([entry], 0).find((i) => i.kind === "connect-card")).toBeTruthy();
    render(<ConnectListenerCard botId="a" entry={entry} />);
    expect(screen.getByText(STR.connectSoRoutineCanFire("Slack"))).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Slack app token"), { target: { value: "xapp-1" } });
    fireEvent.change(screen.getByLabelText("Slack bot token"), { target: { value: "xoxb-1" } });
    fireEvent.click(screen.getByRole("button", { name: STR.connect }));
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(["setListenerCredentials", { id: "a", platform: "slack", fields: { appToken: "xapp-1", botToken: "xoxb-1" } }]));
    expect(await screen.findByText("Connected")).toBeTruthy();
  });
});

describe("reconnect (Task 50 fuzz)", () => {
  it("reloads cached routines on (re)connect, so a run the restarted host marked interrupted stops showing Running", async () => {
    const running = { id: "r1", trigger: "manual", startedAt: 1, finishedAt: null, status: "running", requestId: "" } as RoutineView["runs"][number];
    useUi.setState({ routines: { a: [routine({ runs: [running] })] } });
    const interrupted = { ...running, status: "error", finishedAt: 2, detail: STR.runInterrupted } as RoutineView["runs"][number];
    reply = (cmd) => {
      if (cmd === "listAgents") return { agents: [bot], activeAgentId: null };
      if (cmd === "getHostSettings") return useUi.getState().settings;
      if (cmd === "getTrays") return { trays: [] };
      if (cmd === "getAgentAutomations") return { routines: [routine({ runs: [interrupted] })] };
      return {};
    };
    await useUi.getState().loadAll();
    await vi.waitFor(() => expect(useUi.getState().routines.a?.[0]?.runs[0]?.detail).toBe(STR.runInterrupted));
  });
});
