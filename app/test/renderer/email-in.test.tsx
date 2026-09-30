// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRG, type GoogleStatusView } from "@synapse/shared";
import { GoogleToggle } from "../../src/renderer/google/GoogleToggle";
import { useGoogle } from "../../src/renderer/google/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// 4.3 Email in: a switch under Google (off by default); when on, the Bot's address on each granted account and its
// label, each with Copy. Titles and labels only.

const ME = "owner@example.com";
const WORK = "owner@acme.example";
const gst: GoogleStatusView = {
  state: "connected", clientId: "1-x.apps.googleusercontent.com", email: ME, services: ["Gmail"], redirectUri: "", error: null,
  accounts: [
    { id: "g1", email: ME, state: "connected", services: ["Gmail"], bots: ["b"] },
    { id: "g2", email: WORK, state: "connected", services: ["Gmail"], bots: ["b"] },
  ],
};
const bot = (settings: Record<string, unknown>) => ({
  id: "b", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false,
  profile: { name: "Scout", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, google: true, ...settings }, lastBotMessageAt: 0,
});

let calls: [string, unknown][] = [];
beforeEach(() => {
  calls = [];
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "getGoogleStatus") return { ok: true, result: gst };
      if (cmd === "setAgentEmailIn") return { ok: true, result: { agent: bot({ emailIn: (args as { enabled: boolean }).enabled, emailInTag: "scout" }) } };
      if (cmd === "getGoogleReconnectCheck") return { ok: true, result: { enabled: false, explicit: false, testing: null } };
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), bots: { b: bot({}) } as never });
  useGoogle.setState({ status: gst, open: false, busy: false } as never);
});
afterEach(cleanup);

describe("4.3 Email in in Bot settings", () => {
  it("is off by default; turning it on shows the Bot's address on each granted account and its label", async () => {
    render(<GoogleToggle botId="b" />);
    const sw = screen.getByRole("switch", { name: STRG.emailIn });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("owner+scout@example.com")).toBeNull();
    await act(async () => { fireEvent.click(sw); });
    expect(calls).toContainEqual(["setAgentEmailIn", { id: "b", enabled: true }]);
    expect(screen.getByRole("switch", { name: STRG.emailIn }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("owner+scout@example.com")).toBeTruthy();
    expect(screen.getByText("owner+scout@acme.example")).toBeTruthy();
    expect(screen.getByText("Synapse/Scout")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: new RegExp(`^${STRG.copy} `) })).toHaveLength(3);
  });
});
