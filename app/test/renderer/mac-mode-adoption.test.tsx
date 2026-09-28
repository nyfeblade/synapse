// @vitest-environment jsdom
// fix-fullauto-adoption: the Mac-side adoption card, and "Allow on this Mac" in Bot settings (a native <select> fires
// no change event when the user re-picks the value it already shows, so re-selecting Full auto never reached the Mac).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, type LocalToolCardView } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { bot, installBridge, settings } from "./settings-fixtures";

let h: ReturnType<typeof installBridge>;
let macMode = "ask";
beforeEach(() => {
  h = installBridge();
  macMode = "ask";
  h.gateway = (cmd: string) => (cmd === "getLocalBotMode" ? { mode: macMode } : cmd === "setAgentPermMode" ? { agent: { ...bot, settings: { ...bot.settings, permMode: "full-auto" } } } : {});
  useUi.setState({ ...initialState(), bots: { a: { ...bot, profile: { ...bot.profile, name: "Chief of Staff" }, settings: { ...bot.settings, permMode: "full-auto" } } }, settings: settings({}) });
});
afterEach(cleanup);

const adoptCard: LocalToolCardView = { kind: "local-tool-permission", askId: "k1", action: "run-command", target: "ls ~/Downloads", description: null, status: "pending", createdAt: 1, expiresAt: 2, adopt: "full-auto" };

describe("the adoption card", () => {
  it("names the Bot and the mode, offers Allow on this Mac / Keep asking, and sends the mode with the answer", async () => {
    render(<LocalToolCard botId="a" entryId="t1s1" card={adoptCard} />);
    expect(screen.getByText(STR5.localAdoptTitle("Chief of Staff", "full-auto"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: STR5.localAlways })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: STR5.localAdoptAllow }));
    await vi.waitFor(() => expect(h.calls).toContainEqual(["resolveLocalToolPermission", { id: "a", askId: "k1", choice: "once", adopt: "full-auto" }]));
  });

  it("Keep asking answers deny; a settled card shows what was chosen", async () => {
    const { rerender } = render(<LocalToolCard botId="a" entryId="t1s1" card={adoptCard} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.localAdoptKeep }));
    await vi.waitFor(() => expect(h.calls).toContainEqual(["resolveLocalToolPermission", { id: "a", askId: "k1", choice: "deny", adopt: "full-auto" }]));
    rerender(<LocalToolCard botId="a" entryId="t1s1" card={{ ...adoptCard, status: "allowed" }} />);
    expect(screen.getByText(STR5.localAdoptOutcome.allowed)).toBeTruthy();
  });
});

describe("Bot settings: the mode isn't on this Mac yet", () => {
  it("shows Allow on this Mac, which re-sends the mode through the coordinator (the Mac records it)", async () => {
    render(<BotSettingsPanel botId="a" />);
    const b = await screen.findByRole("button", { name: STR5.permModeApplyOnMac });
    fireEvent.click(b);
    await vi.waitFor(() => expect(h.calls).toContainEqual(["setAgentPermMode", { id: "a", mode: "full-auto" }]));
  });

  it("shows nothing once the Mac's record matches", async () => {
    macMode = "full-auto";
    render(<BotSettingsPanel botId="a" />);
    await vi.waitFor(() => expect(h.calls.some(([c]) => c === "getLocalBotMode")).toBe(true));
    expect(screen.queryByRole("button", { name: STR5.permModeApplyOnMac })).toBeNull();
  });
});
