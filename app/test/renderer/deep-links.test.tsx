// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingLinksLayer } from "../../src/renderer/components/settings/SettingLinksLayer";
import { botSettingLink, openDeepLink, parseSettingLink, safeUrlTransform, settingLink, slugRow } from "../../src/renderer/deep-links";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

beforeEach(() => {
  useUi.setState({ ...initialState(), openSettings: vi.fn(), openBot: vi.fn(), setPanel: vi.fn() } as never);
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("setting links (SET-18)", () => {
  it("formats and parses both link kinds with the product scheme", () => {
    expect(settingLink("general", "auto-review")).toBe("synapse://settings/general/auto-review");
    expect(botSettingLink("0f3e", "model")).toBe("synapse://bot/0f3e/settings/model");
    expect(parseSettingLink("synapse://settings/usage/weekly-budget")).toEqual({ kind: "settings", section: "usage", row: "weekly-budget" });
    expect(parseSettingLink("synapse://bot/0f3e/settings/voice")).toEqual({ kind: "bot", botId: "0f3e", row: "voice" });
    expect(parseSettingLink("https://example.com")).toBeNull();
    expect(slugRow("Commands on this computer")).toBe("commands-on-this-computer");
  });

  it("bug 286: a bots:// link from before the rename still parses and opens (an alias for one release)", () => {
    expect(parseSettingLink("bots://settings/usage/weekly-budget")).toEqual({ kind: "settings", section: "usage", row: "weekly-budget" });
    expect(parseSettingLink("bots://bot/0f3e/settings/voice")).toEqual({ kind: "bot", botId: "0f3e", row: "voice" });
    expect(parseSettingLink("botsx://settings/usage/weekly-budget")).toBeNull();
    expect(openDeepLink("bots://settings/computer/computer-name")).toBe(true);
    expect(useUi.getState().openSettings).toHaveBeenCalledWith("computer/computer-name");
  });

  it("a Bot's reply keeps links in either scheme; other app schemes are blanked", () => {
    expect(safeUrlTransform("synapse://settings/usage/weekly-budget")).toBe("synapse://settings/usage/weekly-budget");
    expect(safeUrlTransform("bots://settings/usage/weekly-budget")).toBe("bots://settings/usage/weekly-budget");
    expect(safeUrlTransform("javascript:alert(1)")).toBe("");
    expect(safeUrlTransform("vscode://file/x")).toBe("");
  });

  it("the layer copies a row's link on hover-click", async () => {
    render(<div data-settings-section="computer"><div className="settings-row"><label>Computer name</label><input /></div><SettingLinksLayer /></div>);
    fireEvent.mouseOver(screen.getByText("Computer name"));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link to this setting" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("synapse://settings/computer/computer-name");
    expect(await screen.findByText("Link copied")).toBeTruthy();
  });

  it("copies the row's own label, not a wrapper span's whole subtree, when the label sits inside nested spans", async () => {
    render(
      <div data-bot-settings="b1">
        <div className="settings-row">
          <span style={{ display: "flex", flexDirection: "column" }}>
            <span>Notifications</span>
            <span className="muted">Get notified when this Bot finishes or needs input</span>
          </span>
          <button type="button" role="switch" aria-checked={true} aria-label="Notifications"><span /></button>
        </div>
        <SettingLinksLayer />
      </div>,
    );
    fireEvent.mouseOver(screen.getByText("Notifications"));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link to this setting" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("synapse://bot/b1/settings/notifications");
  });

  it("hides the copy-link button again once the pointer leaves the row", async () => {
    render(
      <div data-settings-section="computer">
        <div className="settings-row"><label>Computer name</label><input /></div>
        <SettingLinksLayer />
      </div>,
    );
    fireEvent.mouseOver(screen.getByText("Computer name"));
    expect(await screen.findByRole("button", { name: "Copy link to this setting" })).toBeTruthy();
    const row = screen.getByText("Computer name").closest(".settings-row")!;
    fireEvent.mouseOut(row, { relatedTarget: document.body });
    expect(screen.queryByRole("button", { name: "Copy link to this setting" })).toBeNull();
  });

  it("opening a link routes to the section and flashes the row for 2 s", () => {
    vi.useFakeTimers();
    expect(openDeepLink("synapse://settings/computer/computer-name")).toBe(true);
    expect(useUi.getState().openSettings).toHaveBeenCalledWith("computer/computer-name");
    render(<div data-settings-section="computer"><div className="settings-row"><label>Computer name</label></div><SettingLinksLayer /></div>);
    act(() => { vi.advanceTimersByTime(50); });
    const row = screen.getByText("Computer name").closest(".settings-row")!;
    expect(row.classList.contains("flash")).toBe(true);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(row.classList.contains("flash")).toBe(false);
    expect(openDeepLink("synapse://bot/b1/settings/model")).toBe(true);
    expect(useUi.getState().openBot).toHaveBeenCalledWith("b1");
    expect(useUi.getState().setPanel).toHaveBeenCalledWith("settings");
  });
});
