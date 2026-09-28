// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { STR5 } from "@synapse/shared";
import { EngineeringOfferCard } from "../../src/renderer/components/cards/EngineeringOfferCard";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const bot = (over: Partial<BotSummary["settings"]> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, ...over }, lastBotMessageAt: 0,
});

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { agent: bot({ engineeringMode: true, engineeringOffered: true }) } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), bots: { a: bot({ engineeringOffered: true }) } });
});
afterEach(cleanup);

describe("engineering-offer card", () => {
  it("Turn on flips the mode", () => {
    render(<EngineeringOfferCard botId="a" entryId="t1s1" card={{ kind: "engineering-offer" }} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.turnOnEngineering }));
    expect(window.synapse.call).toHaveBeenCalledWith("setAgentEngineeringMode", { id: "a", enabled: true });
  });

  it("Not now settles the card without turning the mode on", () => {
    render(<EngineeringOfferCard botId="a" entryId="t1s1" card={{ kind: "engineering-offer" }} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.notNow }));
    expect(window.synapse.call).toHaveBeenCalledWith("setAgentEngineeringMode", { id: "a", enabled: false });
    expect(screen.queryByRole("button", { name: STR5.turnOnEngineering })).toBeNull();
    expect(screen.getByText(STR5.notNow)).toBeTruthy();
  });
});
