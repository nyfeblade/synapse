// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, STRG, STR_RULES } from "@synapse/shared";
import "../../src/renderer/components/SettingsModal";
import "../../src/renderer/google/ConnectedAccountsBlock";
import "../../src/renderer/components/settings/AppearanceBlock";
import "../../src/renderer/components/settings/MemoryBlock";
import { GeneralSection } from "../../src/renderer/components/settings/GeneralSection";
import { sectionOf, settingsSections } from "../../src/renderer/components/settings/sections";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

beforeEach(() => {
  installFakeBridge({ getPhase5Settings: { memoryMode: "standard" }, getGoogleStatus: { state: "disconnected" } });
  useUi.setState({ ...initialState(), settings: settingsFixture() } as never);
});
afterEach(cleanup);

describe("new-user walk finding 22: Settings → General grouping", () => {
  it("Rules (was Auto-review) is its own section, and old auto-review links land there", () => {
    expect(settingsSections().map((s) => s.label)).toContain(STR_RULES.rules);
    expect(sectionOf("auto-review")).toBe("auto-review");
  });

  it("General has no rule builder, and Connected accounts has its own heading", () => {
    render(<GeneralSection />);
    expect(screen.queryByLabelText(STR.rulesWhen)).toBeNull();
    expect(screen.getByRole("heading", { name: STRG.connectedAccounts })).toBeTruthy();
    const heads = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(heads.indexOf(STRG.connectedAccounts)).toBeGreaterThan(heads.indexOf(STR.appearance));
  });
});
