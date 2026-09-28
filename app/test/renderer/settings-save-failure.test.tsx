// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STR } from "@synapse/shared";
import { setTimeZone } from "../../src/renderer/bot-actions";
import { AdvancedSettingsCard } from "../../src/renderer/components/AdvancedSettingsCard";
import { CommandPalette } from "../../src/renderer/components/CommandPalette";
import { PublicWebhookRow } from "../../src/renderer/components/RoutineDetail";
import { useUi } from "../../src/renderer/store";
import { applyTheme, cycleTheme } from "../../src/renderer/theme";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

/** The host answers a command it could not carry out with `{ ok: false, error }` — the same shape
 * the real preload bridge resolves with. Nothing here rejects at the transport level. */
function failingSave(message = "Internal error") {
  installFakeBridge();
  const real = window.synapse.call;
  window.synapse.call = vi.fn(async (cmd: string, args: unknown) => {
    if (cmd === "setHostSettings") return { ok: false, error: { code: "SETTINGS_NOT_SAVED", message } };
    return (real as (c: string, a: unknown) => Promise<unknown>)(cmd, args);
  }) as typeof window.synapse.call;
}

describe("a host setting that cannot be saved is visible, not silent", () => {
  beforeEach(() => {
    useUi.setState({ settings: { ...settingsFixture(), themePreference: "system" }, actionError: null } as never);
    delete document.documentElement.dataset.theme;
  });

  it("cycleTheme reports a failed save instead of resolving as if it worked", async () => {
    failingSave("Your settings could not be saved (EACCES).");
    applyTheme("system");
    await cycleTheme();
    expect(useUi.getState().actionError).toContain("could not be saved");
    // and the UI must not pretend: the stored preference and the applied attribute stay put
    expect(useUi.getState().settings?.themePreference).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("the command palette surfaces a row whose action failed", async () => {
    failingSave("Your settings could not be saved (EACCES).");
    render(<CommandPalette />);
    fireEvent.click(screen.getByText(/^Theme:/));
    await vi.waitFor(() => expect(useUi.getState().actionError).toContain("could not be saved"));
  });

  it("setTimeZone reports a failed save instead of swallowing it", async () => {
    failingSave("Your settings could not be saved (EACCES).");
    await setTimeZone("Europe/Paris");
    expect(useUi.getState().actionError).toContain("could not be saved");
  });

  it("the Advanced switches report a failed save (advancedEnabled, memoryRecall)", async () => {
    failingSave("Your settings could not be saved (EACCES).");
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true, memoryRecall: true }, actionError: null } as never);
    render(<AdvancedSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: STR.perTurnRecall }));
    await vi.waitFor(() => expect(useUi.getState().actionError).toContain("could not be saved"));
    expect(useUi.getState().settings?.memoryRecall).toBe(true);
  });

  it("the public webhook toggle reports a failed save and stops showing the value it could not save", async () => {
    failingSave("Your settings could not be saved (EACCES).");
    useUi.setState({ settings: { ...settingsFixture(), publicWebhook: { enabled: false, url: null } }, actionError: null } as never);
    render(<PublicWebhookRow />);
    const sw = screen.getByRole("switch", { name: STR.publicWebhookUrl });
    fireEvent.click(sw);
    await vi.waitFor(() => expect(useUi.getState().actionError).toContain("could not be saved"));
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });
});
