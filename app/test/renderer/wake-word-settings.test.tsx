// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5, STRV } from "@synapse/shared";
import { WakeWordCard } from "../../src/renderer/voice/WakeWordCard";
import { botForWakeName, wakeCall, wakeNames } from "../../src/renderer/voice/wake-bridge";

type Listener = (p: unknown) => void;
function installBridge(state: Record<string, unknown>) {
  const invoked: [string, Record<string, unknown>][] = [];
  const listeners = new Map<string, Listener[]>();
  let current = { enabled: false, pauseOnBattery: true, listening: false, pausedFor: ["off"], error: null, names: 2, ...state };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "wake.set") current = { ...current, ...a, pausedFor: a.enabled === false ? ["off"] : [], listening: a.enabled !== false };
        return { ok: true, result: n.startsWith("wake.") ? current : {} };
      }),
      on: (ch: string, fn: Listener) => { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]); return () => {}; },
    },
  };
  return { invoked, emit: (ch: string, p: unknown) => { for (const l of listeners.get(ch) ?? []) l(p); } };
}

describe("Settings → Voice: “Hey <Bot name>”", () => {
  afterEach(() => cleanup());

  it("is off by default; turning it on saves and shows that it's listening", async () => {
    const b = installBridge({});
    render(<WakeWordCard />);
    const sw = await screen.findByRole("switch", { name: STRV.wakeWord });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => { fireEvent.click(sw); });
    expect(b.invoked).toContainEqual(["wake.set", { enabled: true }]);
    expect((await screen.findByRole("switch", { name: STRV.wakeWord })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(STRV.wakeStatus({ enabled: true, listening: true, pausedFor: [], error: null }));
  });

  it("says why it isn't listening, live, and offers the battery choice", async () => {
    const b = installBridge({ enabled: true, listening: false, pausedFor: ["locked"] });
    render(<WakeWordCard />);
    expect((await screen.findByRole("status")).textContent).toMatch(/locked/i);
    act(() => b.emit("wake", { type: "state", state: { enabled: true, pauseOnBattery: true, listening: false, pausedFor: ["bluetooth"], error: null, names: 2 } }));
    expect(screen.getByRole("status").textContent).toMatch(/Bluetooth/);
    const battery = screen.getByRole("switch", { name: STRV.wakePauseOnBattery });
    await act(async () => { fireEvent.click(battery); });
    expect(b.invoked).toContainEqual(["wake.set", { pauseOnBattery: false }]);
  });

  it("a permission stop shows the plain reason and opens the pane that fixes it", async () => {
    const b = installBridge({ enabled: true, listening: false, pausedFor: ["error"], error: STR5.micAccessDenied, errorPane: "microphone" });
    render(<WakeWordCard />);
    expect((await screen.findByRole("status")).textContent).toBe(STR5.micAccessDenied);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR5.openPrivacySettings })); });
    expect(b.invoked).toContainEqual(["openPrivacySettings", { pane: "microphone" }]);
  });

  it("a non-permission stop has no settings button", async () => {
    installBridge({ enabled: true, listening: false, pausedFor: ["error"], error: "Listening stopped: crashed", errorPane: null });
    render(<WakeWordCard />);
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: STR5.openPrivacySettings })).toBeNull();
  });
});

describe("wake bridge", () => {
  const bots = {
    a: { id: "a", profile: { name: "Nova" }, settings: { hiddenFromSidebar: false }, archived: false },
    b: { id: "b", profile: { name: "Atlas" }, settings: { hiddenFromSidebar: true }, archived: false },
    c: { id: "c", profile: { name: "Old" }, settings: { hiddenFromSidebar: false }, archived: true },
    g: { id: "g", profile: { name: "Team" }, settings: { hiddenFromSidebar: false }, group: { memberIds: ["a"] } },
  } as never;
  it("listens for every live Bot's name (not archived ones, not group chats)", () => {
    expect(wakeNames(bots)).toEqual(["Nova", "Atlas"]);
  });
  it("maps a heard name back to its Bot, ignoring case", () => {
    expect(botForWakeName(bots, "nova")).toBe("a");
    expect(botForWakeName(bots, "Atlas")).toBe("b");
    expect(botForWakeName(bots, "Old")).toBeNull();
    expect(botForWakeName(bots, "Nobody")).toBeNull();
  });
  it("'Hey Nova and Atlas' (bug 213): a call with Nova that brings Atlas in; unknown or repeated names are dropped", () => {
    expect(wakeCall(bots, { name: "Nova", also: ["Atlas"] })).toEqual({ id: "a", adding: ["b"] });
    expect(wakeCall(bots, { name: "Nova", also: ["Old", "Nobody", "nova", "Atlas", "Atlas"] })).toEqual({ id: "a", adding: ["b"] });
    expect(wakeCall(bots, { name: "Nova" })).toEqual({ id: "a", adding: [] });
    expect(wakeCall(bots, { name: "Nobody", also: ["Atlas"] })).toBeNull();
  });
});
