// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { HiddenBotsDialog } from "../../src/renderer/components/HiddenBotsDialog";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useTemplates } from "../../src/renderer/templates/store";
import { botFixture, installFakeBridge, phase3BridgeStubs } from "./fake-bridge";

describe("context menu (BOT-14) and Hidden Bots (BOT-10)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  afterEach(cleanup);
  beforeEach(() => {
    // Canned so the async continuations in bot-actions.ts (which read the host's real response
    // shape) resolve instead of rejecting on an uncanned `{}` — the tests only assert on the
    // synchronously-recorded `bridge.calls`, not on these resolved values.
    bridge = installFakeBridge({
      setAgentHiddenFromSidebar: (args: { id: string; hidden: boolean }) => {
        const bot = useUi.getState().bots[args.id]!;
        return { agent: { ...bot, settings: { ...bot.settings, hiddenFromSidebar: args.hidden } } };
      },
      setAgentUnread: (args: { id: string; unread: boolean }) => {
        const bot = useUi.getState().bots[args.id]!;
        return { agent: { ...bot, marker: args.unread ? "unread" : null } };
      },
      duplicateAgent: () => ({ id: "c" }),
      openAgent: (args: { id: string }) => ({ agent: useUi.getState().bots[args.id] ?? botFixture(args.id, "Copy") }),
      getAgentTranscriptTail: () => ({ entries: [] }),
    });
    const a = botFixture("a", "Scout");
    const b = { ...botFixture("b", "Ledger"), settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true } };
    useUi.setState({ bots: { a, b }, pinned: [], view: { kind: "chat", botId: "a" } } as never);
  });

  it("lists the items in spec order with Delete last; Share as Template opens the export review (TPL-01)", () => {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    const menu = screen.getByRole("menu", { name: "Bot actions" });
    const labels = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    expect(labels).toEqual([STR.pin, STR.markUnread, STR.editProfile, STR.duplicate, STR.copyConversationId, STR.shareAsTemplate, STR.hideFromSidebar, STR.deleteBot]);
    const openExport = vi.fn(async () => {});
    useTemplates.setState({ openExport });
    const item = within(menu).getByRole("menuitem", { name: STR.shareAsTemplate }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(openExport).toHaveBeenCalledWith("a");
  });

  it("Hide calls the host; the Hidden Bots row opens the dialog; Unhide calls the host", async () => {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.hideFromSidebar }));
    expect(bridge.calls.at(-1)).toEqual(["setAgentHiddenFromSidebar", { id: "a", hidden: true }]);
    fireEvent.click(screen.getByRole("button", { name: STR.hiddenBots }));
    render(<HiddenBotsDialog />);
    fireEvent.click(screen.getByRole("button", { name: `${STR.unhide} Ledger` }));
    expect(bridge.calls.at(-1)).toEqual(["setAgentHiddenFromSidebar", { id: "b", hidden: false }]);
  });

  it("Duplicate and Mark as Unread call the host", () => {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.duplicate }));
    expect(bridge.calls.at(-1)).toEqual(["duplicateAgent", { id: "a" }]);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.markUnread }));
    expect(bridge.calls.at(-1)).toEqual(["setAgentUnread", { id: "a", unread: true }]);
  });
});

// Fix round 1, finding 2: hideBot/unhideBot/duplicateBot/setUnread/setNotify are called
// fire-and-forget (`void ...`) from Sidebar.tsx and BotSettingsPanel.tsx, so a rejected
// gateway call must not become a silent unhandled rejection — it must surface the same way
// deleteBot/setPinned already do (store.ts:51-66 sets `actionError`, which Sidebar.tsx renders
// as a role="alert" banner).
describe("bot-actions.ts error handling (fix round 1, finding 2)", () => {
  // Fails only the named command; every other command (including the ones openBot/loadTranscript
  // fire as side effects) succeeds with a harmless empty result, mirroring sidebar.test.tsx's
  // "surfaces a visible error" tests for deleteBot/setPinned.
  const installFailing = (cmd: string) => {
    (window as unknown as { synapse: unknown }).synapse = {
      call: vi.fn(async (called: string, args: unknown) => {
        if (called === cmd) return { ok: false, error: { code: "GATEWAY_ERROR", message: "Could not reach the computer" } };
        if (called === "setAgentHiddenFromSidebar") {
          const bot = useUi.getState().bots[(args as { id: string }).id]!;
          return { ok: true, result: { agent: { ...bot, settings: { ...bot.settings, hiddenFromSidebar: (args as { hidden: boolean }).hidden } } } };
        }
        return { ok: true, result: {} };
      }),
      onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "tester" }),
      ...phase3BridgeStubs(),
    };
  };
  afterEach(cleanup);
  beforeEach(() => {
    const a = botFixture("a", "Scout");
    const b = { ...botFixture("b", "Ledger"), settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: true } };
    useUi.setState({ ...initialState(), bots: { a, b }, pinned: [], view: { kind: "chat", botId: "a" } });
  });

  it("surfaces a visible error and doesn't crash when Hide fails", async () => {
    installFailing("setAgentHiddenFromSidebar");
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.hideFromSidebar }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("surfaces a visible error and doesn't crash when Unhide fails", async () => {
    installFailing("setAgentHiddenFromSidebar");
    render(<Sidebar />);
    render(<HiddenBotsDialog />);
    fireEvent.click(screen.getByRole("button", { name: `${STR.unhide} Ledger` }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("surfaces a visible error and doesn't crash when Duplicate fails", async () => {
    installFailing("duplicateAgent");
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.duplicate }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("surfaces a visible error and doesn't crash when Mark as Unread fails", async () => {
    installFailing("setAgentUnread");
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Scout/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.markUnread }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("surfaces a visible error and doesn't crash when toggling Notifications fails", async () => {
    installFailing("setAgentNotificationsEnabled");
    render(<Sidebar />);
    render(<BotSettingsPanel botId="a" />);
    fireEvent.click(screen.getByRole("switch", { name: STR.notifications }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });
});
