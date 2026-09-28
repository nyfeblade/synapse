// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR_AUTH, type BotSummary, type ModelAccessView } from "@synapse/shared";
import { BotSettingsPanel } from "../../src/renderer/components/BotSettingsPanel";
import { AccountPanel } from "../../src/renderer/components/settings/AccountSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useModelAccess } from "../../src/renderer/model-access";

/** P4: the model picker shows only models the saved key can reach; Settings → Account can re-check them. */
const bot: BotSummary = {
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape", model: "claude-fable-5-1" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
  lastBotMessageAt: 0,
};
let access: ModelAccessView;
const calls: [string, unknown][] = [];
type Listener = (e: { channel: string; payload: unknown }) => void;
/** Every onEvent subscriber (module-level syncs stay subscribed across tests, like the real app). */
const listeners = new Set<Listener>();
const emit = (e: { channel: string; payload: unknown }) => { for (const l of listeners) l(e); };
beforeEach(() => {
  calls.length = 0;
  useModelAccess.setState({ view: null });
  access = { checkedAt: 1, checking: false, models: { "claude-opus-5-5": false, "claude-fable-5-1": false, "claude-sonnet-5": true }, longContext: {} };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "getModelAccess") return { ok: true, result: access };
      if (cmd === "getAuth") return { ok: true, result: { apiKey: { masked: "sk-ant-…abcd", savedAt: 1 }, boxPublicKey: "PK" } };
      return { ok: true, result: { agent: bot } };
    }),
    onEvent: (cb: Listener) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    auth: { saveKey: vi.fn(), testKey: vi.fn(), removeKey: vi.fn(), hasMacKey: vi.fn(async () => true) },
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
    secrets: { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn() },
  };
  useUi.setState({ ...initialState(), bots: { a: bot } } as never);
});
afterEach(cleanup);

describe("P4: models the key can't reach are hidden", () => {
  it("the picker hides models marked unavailable, keeps unchecked ones, and keeps the current model visible", async () => {
    render(<BotSettingsPanel botId="a" />);
    await vi.waitFor(() => expect(calls.some(([c]) => c === "getModelAccess")).toBe(true));
    await vi.waitFor(() => expect(useModelAccess.getState().view).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Model: Fable 5.1" }));
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toContain("Sonnet 5");
    expect(names).toContain("Opus 5"); // not checked yet: shown
    expect(names).toContain("Fable 5.1"); // the current model, even though the key can't use it
    expect(names).not.toContain("Opus 5.5");
  });

  it("follows the host's model-access channel", async () => {
    render(<BotSettingsPanel botId="a" />);
    await vi.waitFor(() => expect(useModelAccess.getState().view).not.toBeNull());
    act(() => emit({ channel: "model-access", payload: { ...access, models: { "claude-opus-5": false } } }));
    expect(useModelAccess.getState().view?.models).toEqual({ "claude-opus-5": false });
    fireEvent.click(screen.getByRole("button", { name: "Model: Fable 5.1" }));
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toContain("Opus 5.5");
    expect(names).not.toContain("Opus 5");
  });

  it("Settings → Account's Check re-checks the key, then reloads the models it found (bug 281)", async () => {
    render(<AccountPanel />);
    expect(screen.queryByRole("button", { name: STR_AUTH.checkModels })).toBeNull(); // Check does it now
    fireEvent.click(await screen.findByRole("button", { name: STR_AUTH.check }));
    await vi.waitFor(() => expect(calls).toContainEqual(["checkApiKey", { refresh: true }]));
    await vi.waitFor(() => expect(calls.slice(calls.findIndex(([c, a]) => c === "checkApiKey" && (a as { refresh?: boolean }).refresh)).some(([c]) => c === "getModelAccess")).toBe(true));
  });
});
