// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRG, STRX, type ComposioStatusView, type GoogleStatusView } from "@synapse/shared";
import { ComposioBotRows } from "../../src/renderer/composio/ComposioBotRows";
import { ComposioSheet } from "../../src/renderer/composio/ComposioSheet";
import { useComposio } from "../../src/renderer/composio/store";
import { ConnectedAccountsBlock } from "../../src/renderer/google/ConnectedAccountsBlock";
import { GoogleToggle } from "../../src/renderer/google/GoogleToggle";
import { useGoogle } from "../../src/renderer/google/store";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// 4.3b: accounts in Settings (Add account, Remove), per-Bot account checkboxes, labels only.

const ME = "me@example.com";
const WORK = "work@acme.example";
const google = (bots: { me?: string[]; work?: string[] } = {}): GoogleStatusView => ({
  state: "connected", clientId: "1-x.apps.googleusercontent.com", email: ME, services: ["Gmail", "Calendar", "Drive"], redirectUri: "", error: null,
  accounts: [
    { id: "g1", email: ME, state: "connected", services: ["Gmail", "Calendar", "Drive"], bots: bots.me ?? [] },
    { id: "g2", email: WORK, state: "needs-reconnect", services: ["Gmail", "Calendar", "Drive"], bots: bots.work ?? [] },
  ],
});
const composio = (bots: string[] = []): ComposioStatusView => ({
  keySet: true, disclosureAccepted: true,
  apps: [{ toolkit: "gmail", name: "Gmail", state: "connected", bots, error: null, accounts: [
    { id: "ca_1", label: "Gmail", state: "connected", bots, error: null },
    { id: "ca_2", label: WORK, state: "connected", bots: [], error: null },
  ] }],
});
const bot = (id: string, googleOn: boolean) => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false,
  profile: { name: "Scout", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, google: googleOn }, lastBotMessageAt: 0,
});

let calls: [string, unknown][] = [];
let gst: GoogleStatusView;
let cst: ComposioStatusView;
beforeEach(() => {
  calls = [];
  gst = google({ me: ["b"] });
  cst = composio();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "getGoogleStatus" || cmd === "disconnectGoogle" || cmd === "setAgentGoogleAccount") return { ok: true, result: gst };
      if (cmd === "getComposioStatus" || cmd === "setComposioGrant" || cmd === "disconnectComposioApp") return { ok: true, result: cst };
      if (cmd === "getGoogleReconnectCheck") return { ok: true, result: { enabled: false, explicit: false, testing: null } };
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
  };
  useUi.setState({ ...initialState(), bots: { b: bot("b", true) } as never });
  useGoogle.setState({ status: gst, open: false, busy: false } as never);
  useComposio.setState({ status: cst, open: false, busy: null } as never);
});
afterEach(cleanup);

describe("Settings → Connected accounts", () => {
  it("lists every Google account with Remove, marks the one that needs sign-in, and offers Add account", async () => {
    render(<ConnectedAccountsBlock />);
    await act(async () => {});
    expect(screen.getByText(STRG.accountCount(2))).toBeTruthy();
    expect(screen.getByText(ME)).toBeTruthy();
    expect(screen.getByText(WORK)).toBeTruthy();
    expect(screen.getByText(STRG.accountNeedsSignIn)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${STRG.remove} ${WORK}` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["disconnectGoogle", { accountId: "g2" }]));
    expect(screen.getByRole("button", { name: STRG.addAccount })).toBeTruthy();
  });
});

describe("Bot settings: account checkboxes per app", () => {
  it("Google: one checkbox per account, ticked where granted; a tick grants just that account", async () => {
    render(<GoogleToggle botId="b" />);
    const group = screen.getByRole("group", { name: STRG.accounts });
    const me = within(group).getByRole("checkbox", { name: ME }) as HTMLInputElement;
    const work = within(group).getByRole("checkbox", { name: WORK }) as HTMLInputElement;
    expect([me.checked, work.checked]).toEqual([true, false]);
    fireEvent.click(work);
    await vi.waitFor(() => expect(calls).toContainEqual(["setAgentGoogleAccount", { id: "b", accountId: "g2", enabled: true }]));
  });

  it("Google: a single account stays one switch (no checkboxes)", () => {
    useGoogle.setState({ status: { ...gst, accounts: [gst.accounts![0]!] } } as never);
    render(<GoogleToggle botId="b" />);
    expect(screen.queryByRole("group", { name: STRG.accounts })).toBeNull();
  });

  it("Composio: an app with two accounts gets a checkbox each", async () => {
    render(<ComposioBotRows botId="b" />);
    const group = screen.getByRole("group", { name: "Gmail" });
    fireEvent.click(within(group).getByRole("checkbox", { name: WORK }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setComposioGrant", { toolkit: "gmail", botId: "b", enabled: true, accountId: "ca_2" }]));
  });
});

describe("the Composio sheet lists accounts", () => {
  it("each account has its own Bots and Remove; the app has Add account", async () => {
    await act(async () => { useComposio.getState().openSheet(); });
    render(<ComposioSheet />);
    const dlg = await screen.findByRole("dialog", { name: STRX.sheetTitle });
    expect(within(dlg).getByRole("button", { name: `${STRX.addAccount} Gmail` })).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: `${STRX.remove} ${WORK}` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["disconnectComposioApp", { toolkit: "gmail", accountId: "ca_2" }]));
  });
});

describe("Composio account rename", () => {
  it("an account's Bot list has an Account label row whose Rename sends the new name", async () => {
    await act(async () => { useComposio.getState().openSheet(); });
    render(<ComposioSheet />);
    const dlg = await screen.findByRole("dialog", { name: STRX.sheetTitle });
    // The second account has no Bots yet, so its list (and its name row) is open.
    const input = within(dlg).getByDisplayValue(WORK) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(within(dlg).getByRole("button", { name: `Rename ${WORK}` }));
    await vi.waitFor(() => expect(calls).toContainEqual(["renameComposioAccount", { toolkit: "gmail", accountId: "ca_2", label: "Work" }]));
  });
});
