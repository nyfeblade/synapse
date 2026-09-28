// @vitest-environment jsdom
// "Computer perception: Live (beta)" is shelved (decisions.md 2026-09-21, pilot: Live 0/4, Screenshots 2/4).
// The choice is gone from both the Bot's settings and Settings → Advanced, even when "live" is stored.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR } from "@synapse/shared";
import { AdvancedSettingsCard } from "../../src/renderer/components/AdvancedSettingsCard";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { bot, installBridge, settings } from "./settings-fixtures";

beforeEach(() => {
  installBridge();
  useUi.setState({ ...initialState(), bots: { a: { ...bot, settings: { ...bot.settings, computerPerception: "live" } } }, settings: settings({ computerPerception: "live" }) });
});
afterEach(cleanup);

describe("Computer perception choice is shelved", () => {
  it("the Bot settings panel offers no Screenshots / Live choice", () => {
    const { container } = render(<BotSettingsPanel botId="a" />);
    expect(screen.queryByLabelText(STR.computerPerception)).toBeNull();
    expect(screen.queryByText(STR.computerPerceptionLive)).toBeNull();
    expect(container.querySelector('[data-setting="computer-perception"]')).toBeNull();
  });

  it("Settings → Advanced offers no account-wide Screenshots / Live choice", () => {
    const { container } = render(<AdvancedSettingsCard />);
    expect(screen.queryByLabelText(STR.computerPerception)).toBeNull();
    expect(screen.queryByText(STR.computerPerceptionLive)).toBeNull();
    expect(container.querySelector('[data-setting="computer-perception-account"]')).toBeNull();
  });
});
