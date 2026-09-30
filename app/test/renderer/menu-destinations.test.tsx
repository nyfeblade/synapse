// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, STRL } from "@synapse/shared";
import { accountMenuItems } from "../../src/renderer/components/account-menu";
import "../../src/renderer/components/settings/UsageSection";
import { sectionOf, settingsSections } from "../../src/renderer/components/settings/sections";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { useMarketplace } from "../../src/renderer/marketplace/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

beforeEach(() => {
  installFakeBridge({});
  useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, connection: { kind: "connected" } } as never);
});
afterEach(cleanup);

describe("new-user walk finding 15: menu labels match where they go", () => {
  it("the account menu says New chat, not Home", () => {
    const labels = accountMenuItems().flatMap((i) => ("label" in i ? [i.label] : []));
    expect(labels).toContain(STR.newChat);
    expect(labels).not.toContain(STRL.home);
  });

  it("Usage is its own Settings section", () => {
    expect(settingsSections().map((s) => s.label)).toContain(STRL.usage);
    expect(sectionOf("usage")).toBe("usage");
  });

  it("the sidebar reaches the Marketplace", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: STR.marketplace }));
    expect(useMarketplace.getState().open).toBe(true);
  });
});
