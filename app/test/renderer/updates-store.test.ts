// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUpdatesSync, useUpdates } from "../../src/renderer/updates/store";

let onCb: ((p: unknown) => void) | null = null;
beforeEach(() => {
  onCb = null;
  useUpdates.setState({ state: null });
  (window as unknown as { synapse: unknown }).synapse = {
    call: async () => ({ ok: true, result: {} }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: (_ch: string, cb: (p: unknown) => void) => { onCb = cb; return () => { onCb = null; }; } },
  };
});
afterEach(() => vi.restoreAllMocks());

// Fix round 1, finding 2: UI-03's account-menu badge must reflect the background 6-hour
// auto-check/download timer even when the user never opened Settings → Updates. That requires a
// module-scope subscription (not a render-local variable) that stays live for the app's lifetime.
describe("updates store (UI-03 background sync)", () => {
  it("starts with no known update", () => {
    expect(useUpdates.getState().state).toBeNull();
  });

  it("keeps the store live from the native 'updates' channel once startUpdatesSync runs", () => {
    startUpdatesSync();
    expect(onCb).not.toBeNull();
    onCb!({ version: "0.2.0", auto: true, status: "ready", latest: "0.4.0", error: null });
    expect(useUpdates.getState().state).toMatchObject({ status: "ready", latest: "0.4.0" });
  });
});
