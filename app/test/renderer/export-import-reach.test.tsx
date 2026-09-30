// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { ChatHeaderActions } from "../../src/renderer/components/ChatHeaderActions";
import { typedRows, type PaletteCtx } from "../../src/renderer/palette-rows";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useTemplates } from "../../src/renderer/templates/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

afterEach(cleanup);

const ctx = (actions: Partial<PaletteCtx["actions"]>): PaletteCtx => ({
  bots: { a: botFixture("a", "Scout") }, pinned: [], currentBotId: "a", theme: "system",
  actions: { openBot: vi.fn(), openChatSettings: vi.fn(), openSettings: vi.fn(), cycleTheme: vi.fn(), newBot: vi.fn(), showHidden: vi.fn(), jumpTo: vi.fn(), startCall: vi.fn(), exportBot: vi.fn(), importBot: vi.fn(), ...actions },
});

describe("new-user walk finding 10: Export and Import Bot are one step away", () => {
  it("⌘K 'export' and 'import' find the actions", () => {
    const exportBot = vi.fn(); const importBot = vi.fn();
    const ex = typedRows(ctx({ exportBot, importBot }), "export", []);
    ex.find((r) => r.title === STR5.exportBot)!.run();
    expect(exportBot).toHaveBeenCalledWith("a");
    typedRows(ctx({ exportBot, importBot }), "import", []).find((r) => r.title === STR5.importBot)!.run();
    expect(importBot).toHaveBeenCalled();
  });

  it("the ⋯ menu lists Export Bot… and Import Bot… directly", async () => {
    installFakeBridge({ getTemplate: { template: null } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") } } as never);
    const openExport = vi.spyOn(useTemplates.getState(), "openExport").mockResolvedValue();
    useTemplates.setState({ openExport });
    render(<ChatHeaderActions botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: STR5.importBot })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: STR5.exportBot }));
    expect(openExport).toHaveBeenCalledWith("a");
  });
});
