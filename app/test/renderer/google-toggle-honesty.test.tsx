// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRG, type GoogleStatusView } from "@synapse/shared";
import { GoogleToggle } from "../../src/renderer/google/GoogleToggle";
import { useGoogle } from "../../src/renderer/google/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Defect 7 — the Google row contradicted itself.
//
// With no account connected the row read "Google | Connect Google first (Settings → Connected
// accounts)" with the switch ENABLED. One click set aria-checked="true" and the helper line did not
// change, so the panel showed a switch turned on above a line telling you to connect Google first.
//
// WHICH HALF IS WRONG. host/google/module.ts is the authority, and it says the switch is real even
// before the account exists: `enabledFor(botId)` is a stored per-Bot setting, and `publish()` does
//   `if (became) for (const id of ctx.bots.ids()) if (enabledFor(id)) wakeForGoogle(id);`
// — the moment the account connects, every Bot whose switch is already on is woken and respawned
// with its Google tools. Turning it on early is a meaningful, honoured choice, so DISABLING the
// switch would be the lie. What has to change is the line underneath: the row now states both
// halves of `botStatus`'s state machine — this Bot's switch, and the account behind it.

const status = (over: Partial<GoogleStatusView> = {}): GoogleStatusView =>
  ({ state: "disconnected", clientId: null, email: null, services: [], redirectUri: "", error: null, ...over }) as GoogleStatusView;

const bot = (id: string, google?: boolean) => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "",
  awaiting: null, group: null, archived: false,
  profile: { name: "Scout", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, ...(google === undefined ? {} : { google }) }, lastBotMessageAt: 0,
});

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { agent: bot("b", true) } })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), bots: { b: bot("b") } as never });
  useGoogle.setState({ status: status(), open: false } as never);
});
afterEach(cleanup);

describe("the Google row never shows an on switch over 'connect Google first'", () => {
  it("off, account not connected: the row asks you to connect", () => {
    render(<GoogleToggle botId="b" />);
    expect(screen.getByText(STRG.botToggleNeedsConnect)).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("on, account not connected: the helper line changes with the switch", () => {
    useUi.setState({ bots: { b: bot("b", true) } as never });
    render(<GoogleToggle botId="b" />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(STRG.botToggleNeedsConnect), "an on switch above 'connect Google first' is the defect").toBeNull();
    expect(screen.getByText(STRG.botToggleOnBeforeConnect)).toBeTruthy();
  });

  it("clicking the switch with no account moves the helper line too", async () => {
    render(<GoogleToggle botId="b" />);
    fireEvent.click(screen.getByRole("switch"));
    await vi.waitFor(() => expect(useUi.getState().bots.b!.settings.google).toBe(true));
    expect(screen.queryByText(STRG.botToggleNeedsConnect)).toBeNull();
  });

  it("the switch stays operable without an account, because the host honours it the moment one connects", () => {
    render(<GoogleToggle botId="b" />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled, "host/google/module.ts wakes every already-enabled Bot on connect").toBe(false);
  });

  it("the new line says what will happen, and points at the same place as the off one", () => {
    expect(STRG.botToggleOnBeforeConnect).toMatch(/Connected accounts/);
    expect(STRG.botToggleOnBeforeConnect).not.toBe(STRG.botToggleNeedsConnect);
  });

  it("a connected account still gets the two lines it already had", () => {
    useGoogle.setState({ status: status({ state: "connected", email: "me@example.com" }) } as never);
    const off = render(<GoogleToggle botId="b" />);
    expect(off.getByText(/off for this Bot/i)).toBeTruthy();
    cleanup();
    useUi.setState({ bots: { b: bot("b", true) } as never });
    render(<GoogleToggle botId="b" />);
    expect(screen.getByText(STRG.botToggleSub)).toBeTruthy();
  });
});
