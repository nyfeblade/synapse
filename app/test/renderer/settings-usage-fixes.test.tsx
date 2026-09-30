// @vitest-environment jsdom
// Hand-testing round, Settings → Usage & Billing / Computer, and the hover "copy link" icon.
// Each test here was written RED against the shipped component before the fix landed.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { ComputerSection } from "../../src/renderer/components/settings/ComputerSection";
import { SettingLinksLayer } from "../../src/renderer/components/settings/SettingLinksLayer";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useUsage } from "../../src/renderer/usage/store";
import { COPY, installBridge, usageView } from "./settings-fixtures";

const AMOUNT = STR5.budgetAmount;
let h: ReturnType<typeof installBridge>;
beforeEach(() => {
  h = installBridge();
  useUi.setState(initialState());
  useUsage.setState({ view: usageView, error: null });
});
afterEach(cleanup);

describe("Settings → Usage & Billing", () => {
  it("shows an error and a Retry when usage cannot be loaded, not a bare heading", async () => {
    useUsage.setState({ view: null, error: null });
    h.gateway = () => new Error("the box is restarting");
    render(<UsageSection />);
    expect(await screen.findByText("the box is restarting")).toBeTruthy();
    h.gateway = () => usageView;
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByText("API spend")).toBeTruthy();
  });
});

describe("Settings → Computer", () => {
  it("shows an error and a Retry when the computer cannot be loaded", async () => {
    h.gateway = () => new Error("the box is restarting");
    render(<ComputerSection />);
    expect(await screen.findByText("the box is restarting")).toBeTruthy();
    expect(screen.getByRole("button", { name: COPY.retry })).toBeTruthy();
  });
});

describe("Settings → the hover 'copy link' icon", () => {
  const mount = () => {
    const view = render(
      <div className="settings-content" data-settings-section="usage">
        <div className="settings-row"><span>Weekly budget</span></div>
        <SettingLinksLayer />
      </div>,
    );
    const host = view.container.firstElementChild as HTMLElement;
    const row = host.querySelector<HTMLElement>(".settings-row")!;
    host.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: 100, left: 0, right: 0, bottom: 140, width: 600, height: 40, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(host, "scrollTop", { value: 200, writable: true, configurable: true });
    return { host, row };
  };

  it("positions the icon in the scrolled pane's own coordinates", () => {
    const { row } = mount();
    fireEvent.mouseOver(row);
    // 100 (row top) - 0 (host top) + 20 (half the row) - 12 (half the icon) + 200 (scrollTop)
    expect((screen.getByRole("button", { name: "Copy link to this setting" }) as HTMLElement).style.top).toBe("308px");
  });

  it("drops the icon when the pane scrolls, so it never sits beside the wrong row", () => {
    const { host, row } = mount();
    fireEvent.mouseOver(row);
    expect(screen.getByRole("button", { name: "Copy link to this setting" })).toBeTruthy();
    fireEvent.scroll(host);
    expect(screen.queryByRole("button", { name: "Copy link to this setting" })).toBeNull();
  });
});
