// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { CommandPalette } from "../../src/renderer/components/CommandPalette";
import { useOverlays } from "../../src/renderer/overlays";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge, settingsFixture } from "./fake-bridge";

// The New Chat screen keeps its own bubble-phase window listener for ⌘1–9 and Escape while the
// palette is open on top of it. The palette must consume those keys so only one thing happens.
describe("command palette keyboard ownership (PAL-01)", () => {
  const others: ((e: KeyboardEvent) => void)[] = [];
  afterEach(() => { for (const f of others) window.removeEventListener("keydown", f); others.length = 0; cleanup(); });
  beforeEach(() => {
    installFakeBridge({ search: { results: [] } });
    useUi.setState({ bots: { courier: botFixture("courier", "Courier") }, pinned: [], view: { kind: "new-chat" }, settings: settingsFixture() } as never);
    useOverlays.setState({ open: "palette" });
  });

  /** Stands in for NewChat's own window keydown, registered on the bubble path like the real one. */
  function screenBehindThePalette() {
    const spy = vi.fn();
    const f = (e: KeyboardEvent) => spy(e.key, e.metaKey);
    others.push(f);
    window.addEventListener("keydown", f);
    return spy;
  }

  it("⌘1 runs only the palette's first row, not the screen underneath", () => {
    const openBot = vi.fn(async () => {});
    useUi.setState({ openBot } as never);
    render(<CommandPalette />);
    const behind = screenBehindThePalette();
    fireEvent.keyDown(screen.getByRole("textbox", { name: STR.search }), { key: "1", metaKey: true });
    expect(openBot).toHaveBeenCalledWith("courier");
    expect(behind).not.toHaveBeenCalled();
  });

  it("Escape closes the palette and nothing else", () => {
    render(<CommandPalette />);
    const behind = screenBehindThePalette();
    fireEvent.keyDown(screen.getByRole("textbox", { name: STR.search }), { key: "Escape" });
    expect(useOverlays.getState().open).toBeNull();
    expect(behind).not.toHaveBeenCalled();
  });

  it("keys the palette does not use still reach the rest of the app", () => {
    render(<CommandPalette />);
    const behind = screenBehindThePalette();
    fireEvent.keyDown(screen.getByRole("textbox", { name: STR.search }), { key: "n", metaKey: true });
    expect(behind).toHaveBeenCalledWith("n", true);
  });
});
