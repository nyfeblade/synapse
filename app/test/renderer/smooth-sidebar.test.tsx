// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { accountMenuItems } from "../../src/renderer/components/account-menu";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const css = readFileSync(fileURLToPath(new URL("../../src/renderer/styles/" + "app.css", import.meta.url)), "utf8");
const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); return i < 0 ? "" : css.slice(i, css.indexOf("}", i)); };

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name, title: "", description: "", avatarShape: "gem", avatarColor: "#49a393", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

describe("smooth sidebar", () => {
  it("moves Home, Schedules, Usage, Marketplace and Settings into the account menu", () => {
    const labels = accountMenuItems().filter((i) => "label" in i).map((i) => (i as { label: string }).label);
    expect(labels).toEqual(["New chat", "Schedules", "Usage", "Marketplace", "Settings"]); // new-user walk finding 15
  });
  // Fix round 1: the approved mockup draws a hairline between Marketplace and Settings.
  it("puts a separator between Marketplace and Settings", () => {
    const items = accountMenuItems();
    const marketplaceIdx = items.findIndex((i) => "label" in i && i.label === "Marketplace");
    const settingsIdx = items.findIndex((i) => "label" in i && i.label === "Settings");
    expect(marketplaceIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBe(marketplaceIdx + 2);
    expect(items[marketplaceIdx + 1]).toEqual({ separator: true });
  });
  it("labels are sentence case, not tracked caps", () => {
    const r = rule(".side-label");
    expect(r).not.toMatch(/text-transform:\s*uppercase/);
    expect(r).not.toMatch(/letter-spacing/);
  });
  it("the search field can shrink so the + never crosses the hairline", () => {
    expect(rule(".search")).toMatch(/min-width:\s*0/);
  });
  it("draws only the hairline between sidebar and chat, on the page colour", () => {
    expect(rule(".sidebar")).toMatch(/background:\s*var\(--bg\)/);
    expect(rule(".sidebar-account")).not.toMatch(/border-top/);
  });

  describe("render", () => {
    beforeEach(() => {
      (window as unknown as { synapse: unknown }).synapse = {
        call: vi.fn(async () => ({ ok: true, result: {} })),
        onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "alex" }),
      };
      useUi.setState({ ...initialState(), connection: { kind: "connected" }, userName: "alex", bots: { a: bot("a", "Planner") } });
    });
    afterEach(cleanup);

    it("no longer shows Home/Schedules/Usage/Marketplace as sidebar links; the account menu opener is there instead", () => {
      render(<Sidebar />);
      expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Schedules" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Marketplace" })).toBeNull();
      expect(screen.getByRole("button", { name: "Open account menu" })).toBeTruthy();
    });

    it("renders the separator as role=separator, between Marketplace and Settings", () => {
      render(<Sidebar />);
      fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
      const menu = screen.getByRole("menu", { name: "Account" });
      const children = [...menu.children];
      const marketplaceIdx = children.findIndex((c) => c.textContent === "Marketplace");
      const settingsIdx = children.findIndex((c) => c.textContent === "Settings");
      expect(marketplaceIdx).toBeGreaterThanOrEqual(0);
      expect(children[marketplaceIdx + 1]?.getAttribute("role")).toBe("separator");
      expect(settingsIdx).toBe(marketplaceIdx + 2);
    });
  });
});
