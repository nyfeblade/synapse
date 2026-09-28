// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { CallHost, useVoice } from "../../src/renderer/voice/VoiceOverlay";
import { handlePhoneEvent, phoneBots, usePhoneCall } from "../../src/renderer/voice/phone-bridge";

// Bug 198: a call from the phone opens this Mac's call screen, which runs the call but makes no
// sound of its own here, and tells main when it ends.
const invoked: [string, Record<string, unknown>][] = [];
const hangUpTones: number[] = [];
vi.mock("../../src/renderer/voice/call-sounds", async (orig) => ({ ...(await orig<object>()), playHangUp: () => void hangUpTones.push(Date.now()) }));

beforeEach(() => {
  invoked.length = 0;
  hangUpTones.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (n: string) => (n === "startCall" ? { ok: true, result: { callId: "c1", participantIds: ["a"], anchorId: "a" } } : { ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: n === "calls.sounds.get" ? { on: true } : {} }; }),
      on: () => () => {},
    },
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Nova", avatarShape: "pebble", avatarColor: "#FFB800" }, settings: { voice: null, speechRate: 1, spokenLanguage: null } } } as never });
  useUi.setState({ openBot: vi.fn(async () => {}) } as never);
});
afterEach(() => { useVoice.getState().close(); usePhoneCall.setState({ botId: null, seq: 0 }); cleanup(); });

describe("phone bridge", () => {
  it("lists live 1:1 Bots with their avatar colour and shape", () => {
    expect(phoneBots({ a: { id: "a", profile: { name: "Nova", avatarShape: "pebble", avatarColor: "#FFB800" } }, g: { id: "g", group: {}, profile: { name: "G" } }, x: { id: "x", archived: true, profile: { name: "X" } } } as never))
      .toEqual([{ id: "a", name: "Nova", color: "#FFB800", shape: "pebble" }]);
  });

  it("a phone call opens the call screen; the phone hanging up closes it without a Mac hang-up tone, and main is told", async () => {
    render(<CallHost />);
    handlePhoneEvent({ type: "call", botId: "a", seq: 3 });
    await vi.waitFor(() => expect(useVoice.getState().openFor).toBe("a"));
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "dictation.start" && a.mode === "call")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    handlePhoneEvent({ type: "hangup", botId: "a", seq: 3 });
    await vi.waitFor(() => expect(useVoice.getState().openFor).toBeNull());
    await vi.waitFor(() => expect(invoked.some(([n, a]) => n === "phone.callEnded" && a.seq === 3)).toBe(true));
    expect(hangUpTones).toHaveLength(0);
    expect(usePhoneCall.getState().botId).toBeNull();
  });

  it("a Mac call still plays its hang-up tone", async () => {
    render(<CallHost />);
    useVoice.getState().open("a");
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    useVoice.getState().close();
    await vi.waitFor(() => expect(hangUpTones).toHaveLength(1));
    expect(invoked.some(([n]) => n === "phone.callEnded")).toBe(false);
  });
});
