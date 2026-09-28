// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRV, type BotSummary } from "@synapse/shared";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useCallPresence } from "../../src/renderer/voice/call-presence";
import { botPresence } from "../../src/renderer/voice/presence-label";
import { useVoice } from "../../src/renderer/voice/VoiceOverlay";

// Bug 134: a call button beside each Bot in the sidebar (item 9), and each Bot's presence (item 12).

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name, title: "", description: "", avatarShape: "gem", avatarColor: "#49a393", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});
const invoked: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  invoked.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string) => ({ ok: true, result: cmd === "getAgentTranscriptTail" ? { entries: [] } : cmd === "openAgent" ? { agent: bot("n", "Nova") } : {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "alex" }),
    native: { invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: {} }; }), on: () => () => {} },
  };
  useCallPresence.setState({ chatId: null, members: [] });
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, userName: "alex", bots: {
    n: bot("n", "Nova", { statusLine: "Booked the flights." }),
    l: bot("l", "Ledger", { running: true, presence: "working", activity: { tool: "Bash", detail: "Reconciling the March invoices for Acme" } }),
    s: bot("s", "Scout", { settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, voice: "kokoro:bf_emma" } }),
  } });
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

describe("presence", () => {
  it("On a call / Working · <task, short> / Idle — from what the app already knows", () => {
    const b = useUi.getState().bots;
    expect(botPresence(b.n!, true)).toEqual({ kind: "call", label: "On a call" });
    expect(botPresence(b.l!, false)).toEqual({ kind: "busy", label: "Working · Reconciling the March invoices…" });
    expect(botPresence(b.n!, false)).toEqual({ kind: "idle", label: "Idle" });
    expect(botPresence({ ...b.n!, running: true }, false).label).toBe("Working");
  });

  it("the sidebar rows say it (an idle Bot keeps its last line), and follow the live call", () => {
    render(<Sidebar />);
    const row = (name: string) => screen.getByText(name).closest("a")!;
    expect(row("Ledger").querySelector(".row-status")!.textContent).toMatch(/^Working · Reconciling/);
    expect(row("Nova").querySelector(".row-status")!.textContent).toBe("Booked the flights.");
    expect(row("Nova").getAttribute("title")).toBe(STRV.presenceIdle);
    act(() => useCallPresence.getState().set("n", ["n", "s"]));
    expect(row("Nova").querySelector(".row-status")!.textContent).toBe(STRV.presenceOnCall);
    expect(row("Scout").getAttribute("data-presence")).toBe("call");
  });
});

describe("call from the sidebar", () => {
  it("each Bot has a call button: clicking opens the chat and calls", async () => {
    const openBot = vi.fn(async (id: string) => { useUi.setState({ view: { kind: "chat", botId: id } }); });
    useUi.setState({ openBot } as never);
    render(<Sidebar />);
    const b = screen.getByRole("button", { name: STRV.callBot("Scout") });
    fireEvent.click(b);
    await vi.waitFor(() => expect(useVoice.getState().openFor).toBe("s"));
    expect(openBot).toHaveBeenCalledWith("s");
  });
});
