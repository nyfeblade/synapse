// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5, type BotSummary, type LocalToolCardView, type RoutineView } from "@synapse/shared";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { RoutineDetail } from "../../src/renderer/components/RoutineDetail";
import { ComputerView } from "../../src/renderer/components/ComputerView";
import { AttachFileButton, VoiceInputButton } from "../../src/renderer/components/ComposerActionButtons";
import { useComputer } from "../../src/renderer/computer-state";
import { useUi } from "../../src/renderer/store";
import { initialState } from "../../src/renderer/reducer";

const rfb = { viewOnly: true, scaleViewport: false, resizeSession: false, showDotCursor: false, focusOnClick: false, background: "", disconnect: vi.fn(), focus: vi.fn(), sendKey: vi.fn(), clipboardPasteFrom: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
vi.mock("../../src/renderer/vnc/rfb", () => ({ createRfb: () => rfb }));

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {},
    appInfo: async () => ({ userName: "u" }), vncUrl: () => "ws://x", native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} },
  };
});
afterEach(cleanup);

const card = (status: LocalToolCardView["status"]): LocalToolCardView => ({ kind: "local-tool-permission", askId: "k1", action: "run-command", target: "brew upgrade", description: null, status, createdAt: 1, expiresAt: 2 });

describe("LOC-04 outcome lines say what the answer actually does", () => {
  it("“Always” names this Bot and this kind of action, never “Bots and all Bots”", () => {
    render(<LocalToolCard botId="b" entryId="t1s1" card={card("always")} />);
    // asks.ts settle() + the coordinator's policy.grant(botId, action): the grant is per-Bot + per-action.
    expect(screen.getByText("Always allowed for this Bot and this kind of action.")).toBeTruthy();
    expect(screen.queryByText(/Bots and all Bots/)).toBeNull();
  });

  it("“Never” says execution is off for this computer, which is what it sets", () => {
    render(<LocalToolCard botId="b" entryId="t1s1" card={card("never")} />);
    // daemon.ts intercept(): choice "never" writes executionPolicy "never" for the current computer.
    expect(screen.getByText("Running commands on this computer is turned off for every Bot. Change it in Settings → Computer.")).toBeTruthy();
    expect(screen.queryByText(/Bots and all Bots/)).toBeNull();
  });
});

describe("C4: the raw cron expression is a tooltip, never body text", () => {
  const routine: RoutineView = {
    botId: "a", id: "nightly", name: "Nightly digest", prompt: "Summarise.", enabled: true, triggerKind: "schedule",
    schedule: "0 21 * * *", scheduleRaw: "CRON_TZ=America/New_York 0 21 * * *", description: "Every day at 9:00 PM",
    nextRunAt: null, lastRunAt: null, createdAt: 0, runs: [], webhook: null, trigger: null, listenerConnected: null,
  };
  const bot = { id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" }, settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0 } as unknown as BotSummary;

  it("shows the plain-English schedule and keeps CRON_TZ only in the input's title", () => {
    useUi.setState({ ...initialState(), bots: { a: bot }, routines: { a: [routine] }, panel: "routine", routineId: "nightly" });
    render(<RoutineDetail botId="a" routineId="nightly" onBack={vi.fn()} />);
    const when = screen.getByLabelText(STR.whenToRun) as HTMLInputElement;
    expect(when.value).toBe("Every day at 9:00 PM");
    expect(when.getAttribute("title")).toBe("CRON_TZ=America/New_York 0 21 * * *");
    expect(screen.queryByText("CRON_TZ=America/New_York 0 21 * * *")).toBeNull();
  });
});

describe("the computer screen is not announced as a library name", () => {
  it("names the Bot's screen instead of noVNC", () => {
    useUi.setState({ bots: { b: { id: "b", profile: { name: "Scout", avatarShape: "pebble", avatarColor: "#3472d9" } } } as never, transcripts: { b: [] } as never });
    useComputer.setState({ open: { botId: "b" }, displays: { b: { botId: "b", index: 2, display: ":2", cdpPort: 9224, running: true, generation: 1 } } });
    render(<ComputerView />);
    expect(screen.getByRole("application", { name: STR.screenCaption("Scout") })).toBeTruthy();
    expect(screen.queryByRole("application", { name: "noVNC" })).toBeNull();
  });
});

describe("delivery-phase vocabulary never reaches the user", () => {
  it("STR has no laterPhase string", () => {
    expect("laterPhase" in STR).toBe(false);
  });

  it("disabled composer buttons are titled with the shipped wording", () => {
    render(<><AttachFileButton /><VoiceInputButton /></>);
    expect(screen.getByLabelText("Attach file").getAttribute("title")).toBe(STR5.notAvailableYet);
    expect(screen.getByLabelText("Start voice input").getAttribute("title")).toBe(STR5.notAvailableYet);
  });
});
