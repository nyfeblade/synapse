// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRV } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { BotCallsCard } from "../../src/renderer/voice/BotCallsCard";

const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
const bot = (id: string, name: string, mayCall?: boolean | null) => ({ id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: mayCall === undefined ? {} : { mayCall } });

beforeEach(() => {
  invoked.length = 0; calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => { calls.push([cmd, a]); return { ok: true, result: {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "calls.quiet.get") return { ok: true, result: { quietHours: { start: "22:00", end: "08:00" } } };
        if (n === "calls.quiet.set") return { ok: true, result: { quietHours: a.quietHours } };
        return { ok: true, result: {} };
      }),
      on: () => () => {},
    },
  };
  useUi.setState({ ...initialState(), bots: { n: bot("n", "Nova"), a: bot("a", "Atlas", true), g: { ...bot("g", "Team"), group: { memberIds: ["n"] } } } } as never);
});
afterEach(() => cleanup());

describe("Settings → Voice: calls from Bots", () => {
  it("quiet hours: on by default 22:00–08:00, can be changed and turned off", async () => {
    render(<BotCallsCard />);
    const sw = await screen.findByRole("switch", { name: STRV.quietHours });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const from = screen.getByLabelText(STRV.quietFrom) as HTMLInputElement;
    expect(from.value).toBe("22:00");
    await act(async () => { fireEvent.change(from, { target: { value: "21:30" } }); });
    expect(invoked).toContainEqual(["calls.quiet.set", { quietHours: { start: "21:30", end: "08:00" } }]);
    await act(async () => { fireEvent.click(sw); });
    expect(invoked).toContainEqual(["calls.quiet.set", { quietHours: null }]);
  });

  it("each Bot's permission: ask on first call (default), allowed, or not allowed", async () => {
    render(<BotCallsCard />);
    const nova = await screen.findByRole("combobox", { name: STRV.mayCall("Nova") }) as HTMLSelectElement;
    expect(nova.value).toBe("ask");
    expect((screen.getByRole("combobox", { name: STRV.mayCall("Atlas") }) as HTMLSelectElement).value).toBe("yes");
    expect(screen.queryByRole("combobox", { name: STRV.mayCall("Team") })).toBeNull();
    await act(async () => { fireEvent.change(nova, { target: { value: "no" } }); });
    expect(calls).toContainEqual(["setBotCallPermission", { id: "n", mayCall: false }]);
  });
});
