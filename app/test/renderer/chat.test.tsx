// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { ChatView } from "../../src/renderer/components/ChatView";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { phase3BridgeStubs } from "./fake-bridge";

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});
const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: { entryId: "t9u" } }; }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    // Task 22 (CHAT-08): Composer's useDictation subscribes to window.synapse.native on mount.
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
    // Bug 192: the header's settings gear can now open BotSettingsPanel from this test, which needs
    // the Phase 3 half of the bridge (secrets, box) it never touched before.
    ...phase3BridgeStubs(),
  };
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({
    ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" }, bots: { a: bot() },
    transcripts: { a: [
      { kind: "event", id: "tba1", createdAt: 1, event: { type: "bot-created", botId: "a", name: "Courier" } },
      { kind: "message", id: "t1u", role: "user", content: "clear out my inbox", createdAt: 2 },
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 3, message: { type: "text", content: "**Done sorting.** 41 were newsletters." } },
    ] },
    trays: [{ id: "tr", botId: "a", title: "Bot failed to respond", detail: null, requestId: "req_1", buttons: [{ label: "Retry", action: "retry" }], dedupeKey: null, count: 1, createdAt: 1 }],
  });
});
afterEach(cleanup);

describe("ChatView (S10–S17)", () => {
  it("renders the header, created event, bubbles with markdown and the composer", () => {
    render(<ChatView botId="a" />);
    expect(screen.getByRole("button", { name: "View conversation details" }).textContent).toContain("Courier");
    expect(screen.getByText("Created").parentElement?.textContent).toContain("Courier");
    expect(screen.getByText("clear out my inbox")).toBeTruthy();
    expect(screen.getByText("Done sorting.").tagName).toBe("STRONG");
    expect(screen.getByPlaceholderText("Message Courier")).toBeTruthy();
  });

  it("shows a small neutral Engineering indicator in the header only while engineering mode is on", () => {
    const { unmount } = render(<ChatView botId="a" />);
    expect(document.querySelector(".chat-header .mode-chip")).toBeNull();
    unmount();
    useUi.setState({ bots: { a: bot({ settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, engineeringMode: true } }) } });
    render(<ChatView botId="a" />);
    const chip = document.querySelector(".chat-header .mode-chip");
    expect(chip?.textContent).toBe("Engineering");
    expect(chip?.className).toBe("chip mode-chip"); // the shared neutral chip; no status colour
  });

  // Gate M-3: Bots write `~` for "approximately"; a single tilde must not strike text through (double still does).
  it("renders a single ~ literally and only ~~double~~ as strikethrough, in bubbles and the typing preview", () => {
    useUi.setState({
      bots: { a: bot({ running: true }) }, typing: { a: { typing: true, partialText: "about ~25 to ~50 so far" } },
      transcripts: { a: [{ kind: "send-message", id: "t1s1", requestId: "r", createdAt: 3, message: { type: "text", content: "Range ~25–50.6\", best warranty (~$400–500). ~~old~~" } }] },
    });
    const { container } = render(<ChatView botId="a" />);
    const dels = [...container.querySelectorAll("del")].map((d) => d.textContent);
    expect(dels).toEqual(["old"]);
    expect(container.textContent).toContain("Range ~25–50.6\", best warranty (~$400–500).");
    expect(container.textContent).toContain("about ~25 to ~50 so far");
  });

  it("sends on Enter with a nonce, keeps Shift+Enter as a newline", async () => {
    render(<ChatView botId="a" />);
    calls.length = 0; // DetailsPanel's RoutinesSection (Task 22) and the composer's listMcpServers (PLG-06) fire on mount
    const box = screen.getByPlaceholderText("Message Courier");
    fireEvent.change(box, { target: { value: "send the 5 drafts" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => expect(calls[0]).toEqual(["sendPrompt", { id: "a", text: "send the 5 drafts", clientNonce: expect.any(String) }]));
  });

  it("shows Working, the typing indicator and a Stop button while running (BOT-22, CHAT-10, CHAT-18)", async () => {
    useUi.setState({ bots: { a: bot({ running: true, presence: "thinking" }) }, typing: { a: { typing: true, partialText: "Sent all" } } });
    render(<ChatView botId="a" />);
    calls.length = 0; // DetailsPanel's RoutinesSection (Task 22) and the composer's listMcpServers (PLG-06) fire on mount
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Sent all")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await vi.waitFor(() => expect(calls[0]).toEqual(["interruptAgent", { id: "a" }]));
  });

  it("shows trays with Retry and dismiss (NTF-03)", async () => {
    render(<ChatView botId="a" />);
    calls.length = 0; // DetailsPanel's RoutinesSection (Task 22) and the composer's listMcpServers (PLG-06) fire on mount
    expect(screen.getByText("Bot failed to respond")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(calls[0]).toEqual(["dismissTray", { trayId: "tr", action: "retry" }]));
  });

  it("renders a notice entry instead of silently dropping it", () => {
    useUi.setState({ transcripts: { a: [
      { kind: "notice", id: "n1", text: "The model service is busy", createdAt: 1 },
    ] } });
    render(<ChatView botId="a" />);
    expect(screen.getByText("The model service is busy")).toBeTruthy();
  });

  // The smooth pass left the right panel closed by default, which buried Bot settings behind
  // PanelTabs' gear or a composer pill — both only reachable once the panel is already open. A gear
  // right in the header is reachable from a closed panel too.
  describe("the header's settings gear", () => {
    it("renders in the header, closed by default", () => {
      render(<ChatView botId="a" />);
      const gear = screen.getByRole("button", { name: "Bot settings" });
      expect(gear.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens the settings panel on click", () => {
      render(<ChatView botId="a" />);
      fireEvent.click(screen.getByRole("button", { name: "Bot settings" }));
      expect(useUi.getState().panel).toBe("settings");
      expect(screen.getByRole("button", { name: "Bot settings" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("closes the panel on a second click", () => {
      render(<ChatView botId="a" />);
      const gear = screen.getByRole("button", { name: "Bot settings" });
      fireEvent.click(gear);
      fireEvent.click(gear);
      expect(useUi.getState().panel).toBe("closed");
      expect(gear.getAttribute("aria-expanded")).toBe("false");
    });

    it("is a real, enabled button reachable by Tab", () => {
      render(<ChatView botId="a" />);
      const gear = screen.getByRole("button", { name: "Bot settings" }) as HTMLButtonElement;
      expect(gear.disabled).toBe(false);
      expect(gear.tabIndex).toBe(0);
      gear.focus();
      expect(document.activeElement).toBe(gear);
    });
  });

  it("shows a visible error and keeps the draft when sendPrompt fails, without an unhandled rejection", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "sendPrompt") return { ok: false, error: { code: "GATEWAY_ERROR", message: "Couldn't reach the computer" } };
      return { ok: true, result: { entryId: "t9u" } };
    });
    render(<ChatView botId="a" />);
    const box = screen.getByPlaceholderText("Message Courier") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "send the 5 drafts" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't reach the computer");
    expect(box.value).toBe("send the 5 drafts");
  });
});
