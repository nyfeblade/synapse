// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { AppearanceBlock } from "../../src/renderer/components/settings/AppearanceBlock";
import { generalExtraBlocks } from "../../src/renderer/components/settings/sections";
import { useUi } from "../../src/renderer/store";
import { startThemeSync } from "../../src/renderer/theme";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

/** SET-02: "General → Appearance · Theme: Follow System / Light / Dark". The palette's cycle row
 * was the only way in, and it advertised a screen that did not exist. */
describe("Settings → General → Appearance (SET-02)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({ setHostSettings: (a: { themePreference: string }) => ({ ...settingsFixture(), themePreference: a.themePreference }) });
    useUi.setState({ settings: { ...settingsFixture(), themePreference: "dark" }, actionError: null } as never);
    delete document.documentElement.dataset.theme;
  });
  afterEach(cleanup);

  it("registers itself as a General settings block", () => {
    expect(generalExtraBlocks().map((b) => b.id)).toContain("appearance");
  });

  it("shows the saved theme and lets the user pick Light in one step", async () => {
    const stop = startThemeSync();
    render(<AppearanceBlock />);
    const picker = screen.getByRole("combobox", { name: STR.theme }) as HTMLSelectElement;
    expect(picker.value).toBe("dark");
    expect([...picker.options].map((o) => o.value)).toEqual(["system", "light", "dark"]);
    expect([...picker.options].map((o) => o.textContent)).toEqual([STR.themeLabels.system, STR.themeLabels.light, STR.themeLabels.dark]);

    fireEvent.change(picker, { target: { value: "light" } });
    await vi.waitFor(() => expect(bridge.calls.at(-1)).toEqual(["setHostSettings", { themePreference: "light" }]));
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    stop();
  });

  it("shows a save it could not make instead of silently snapping back", async () => {
    const real = window.synapse.call;
    window.synapse.call = (async (cmd: string, args: unknown) => (cmd === "setHostSettings"
      ? { ok: false, error: { code: "SETTINGS_NOT_SAVED", message: "Your settings could not be saved (EACCES)." } }
      : (real as (c: string, a: unknown) => Promise<unknown>)(cmd, args))) as typeof window.synapse.call;
    render(<AppearanceBlock />);
    fireEvent.change(screen.getByRole("combobox", { name: STR.theme }), { target: { value: "light" } });
    await vi.waitFor(() => expect(useUi.getState().actionError).toContain("could not be saved"));
    expect(useUi.getState().settings?.themePreference).toBe("dark");
  });
});
