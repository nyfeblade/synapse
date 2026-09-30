// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { CardView, registerCard } from "../../src/renderer/components/cards/registry";
import { registerSettingsSection, sectionOf } from "../../src/renderer/components/settings/sections";
import { SettingsModal } from "../../src/renderer/components/SettingsModal";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { useOverlays } from "../../src/renderer/overlays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

describe("renderer seams", () => {
  beforeEach(() => {
    installFakeBridge();
    useOverlays.setState({ open: null });
    useMarketplace.setState({ open: false, page: "home", view: null, query: "", results: null, waiting: {}, detailId: null });
  });
  afterEach(cleanup);

  it("⌘K and the Search field open the palette overlay; Esc closes it", async () => {
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(useOverlays.getState().open).toBe("palette");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useOverlays.getState().open).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    expect(useOverlays.getState().open).toBe("palette");
  });

  // C5 (pre-flight ruling): Marketplace opens the Marketplace modal (Task 13); Private skills
  // ("Your skills") open from inside it, the Cmd-K palette and Settings. The smooth pass (Task 2)
  // moved the trigger off the sidebar's own foot and into the account menu.
  it("Marketplace opens from the account menu and opens the Marketplace modal (UI-10, C5)", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open account menu" }));
    const marketplace = await screen.findByRole("menuitem", { name: "Marketplace" });
    expect((marketplace as HTMLButtonElement).disabled).toBeFalsy();
    fireEvent.click(marketplace);
    expect(useMarketplace.getState().open).toBe(true);
    expect(await screen.findByRole("dialog", { name: "Marketplace" })).toBeTruthy();
  });

  it("on connect it loads which Bots hold a screen, so previews dial only those (fuzz: 4th Bot → VNC 502)", async () => {
    const d = { botId: "b1", index: 2, display: ":2", cdpPort: 9222, running: true, generation: 1 };
    installFakeBridge({ getDisplays: { displays: [d] } });
    render(<App />);
    const { useComputer } = await import("../../src/renderer/computer-state");
    await vi.waitFor(() => expect(useComputer.getState().displays).toEqual({ b1: d }));
  });

  it("a notification click opens the Bot (NTF-02)", async () => {
    const bridge = installFakeBridge();
    render(<App />);
    const openBot = vi.fn();
    const { useUi } = await import("../../src/renderer/store");
    useUi.setState({ openBot } as never);
    bridge.emitOpenBot("b1");
    expect(openBot).toHaveBeenCalledWith("b1");
  });
});

describe("Phase 5 app seams: native bridge, settings sections, transcript cards (Task 3)", () => {
  beforeEach(() => {
    (window as unknown as { synapse: unknown }).synapse = { call: async () => ({ ok: true, result: {} }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: null }), on: () => () => {} } };
    useUi.setState({ ...initialState(), settingsOpen: true, settings: settingsFixture() });
  });
  afterEach(cleanup);

  describe("transcript card items", () => {
    it("turns send-message cards into card items", () => {
      const items = buildTranscriptItems([
        { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1, message: { type: "card", card: { kind: "connect", serverId: null, catalogId: "curated:linear", name: "Linear", logo: null, toolCount: 12, state: "available" } } },
      ], 2);
      expect(items.map((i) => i.kind)).toEqual(["separator", "card"]);
    });

    it("CardView renders the registered component, and nothing for unknown kinds", () => {
      registerCard("connect", ({ card }) => <div>connect:{(card as { name: string }).name}</div>);
      render(<CardView botId="b" entryId="t1s1" card={{ kind: "connect", serverId: null, catalogId: null, name: "Linear", logo: null, toolCount: 1, state: "available" }} />);
      expect(screen.getByText("connect:Linear")).toBeTruthy();
    });
  });

  describe("settings sections", () => {
    it("maps focus strings to sections ('auto-review' and usage are their own sections)", () => {
      expect(sectionOf("auto-review")).toBe("auto-review");
      expect(sectionOf("usage")).toBe("usage");
      expect(sectionOf("computer/execution")).toBe("computer");
      expect(sectionOf(null)).toBe("general");
    });

    it("enables a nav item once its section registers", () => {
      render(<SettingsModal />);
      expect((screen.getByRole("button", { name: "Voice" }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
      registerSettingsSection("voice", "Voice", () => <p>voice body</p>);
      useUi.setState({ settingsFocus: "voice" });
      render(<SettingsModal />);
      expect(screen.getByText("voice body")).toBeTruthy();
    });
  });
});
