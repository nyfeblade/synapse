// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STR5 } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { ComposerPlusMenu } from "../../src/renderer/components/ComposerPlusMenu";
import { typedRows, defaultRows, type PaletteCtx } from "../../src/renderer/palette-rows";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

beforeEach(() => {
  installFakeBridge({});
  useUi.setState({ ...initialState(), bots: { a: { ...botFixture("a", "Feedback Miner"), profile: { ...botFixture("a", "Feedback Miner").profile, description: "You read customer feedback and find themes." } } }, panel: "settings" } as never);
});
afterEach(cleanup);

const ctx = (): PaletteCtx => ({
  bots: useUi.getState().bots, pinned: [], currentBotId: "a", theme: "system",
  actions: { openBot: vi.fn(), openChatSettings: vi.fn(), openSettings: vi.fn(), cycleTheme: vi.fn(), newBot: vi.fn(), showHidden: vi.fn(), jumpTo: vi.fn(), startCall: vi.fn(), exportBot: vi.fn(), importBot: vi.fn() },
});

describe("new-user walk nits", () => {
  it("26: the welcome button says Add API key", () => {
    expect(STR5.signIn).toBe("Add API key");
  });

  it("27: Escape closes the Bot settings panel", () => {
    render(<BotSettingsPanel botId="a" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().panel).toBe("closed");
  });

  it("28: ⌘K says Bot settings, and a Bot row doesn't preview its raw instructions", () => {
    const rows = defaultRows(ctx());
    expect(rows.find((r) => r.key === "chat-settings")?.title).toBe(STR.botSettingsRow);
    expect(rows.find((r) => r.key === "bot:a")?.subtitle).toBe("");
    // still found by what it does
    expect(typedRows(ctx(), "feedback themes", []).some((r) => r.key === "bot:a") || typedRows(ctx(), "themes", []).some((r) => r.key === "bot:a")).toBe(true);
  });

  it("31: Use a skill has a drawn chevron, not a text triangle", () => {
    render(<ComposerPlusMenu botId="a" />);
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(document.body.textContent).not.toContain("▸");
  });
});
