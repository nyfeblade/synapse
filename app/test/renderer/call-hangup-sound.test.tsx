// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import * as CallSounds from "../../src/renderer/voice/call-sounds";

// The hang-up tone (call-sounds.ts playHangUp): plays once when a call that connected ends, for any
// reason — the user hanging up, here; a Bot or remote end and a fault-driven close all go through the
// same unmount cleanup in VoiceOverlay, so this one path covers all three. Never plays for a call
// that never connected (startCall never returned a callId).

vi.mock("../../src/renderer/voice/call-sounds", () => ({ playHangUp: vi.fn(), startRing: vi.fn(() => ({ stop: vi.fn() })), useCallSoundsEnabled: vi.fn(() => true) }));

const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
let startCallResult: Record<string, unknown> | "reject" = { callId: "c1", chatId: "a", anchorId: "a", participantIds: ["a"] };
let soundsOn = true;

beforeEach(() => {
  invoked.length = 0;
  calls.length = 0;
  vi.mocked(CallSounds.playHangUp).mockClear();
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class { constructor(public text: string) {} };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      calls.push([cmd, a]);
      if (cmd === "startCall") return startCallResult === "reject" ? { ok: false, error: { code: "NATIVE_ERROR", message: "no calls" } } : { ok: true, result: startCallResult };
      return { ok: true, result: {} };
    }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "calls.sounds.get") return { ok: true, result: { on: soundsOn } };
        if (n === "dictation.speak") return { ok: true, result: { spoken: true } };
        return { ok: true, result: {} };
      }),
      on: () => () => {},
    },
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} } } } as never);
  useVoice.getState().open("a");
});
afterEach(() => { useVoice.getState().close(); cleanup(); });

/** Waits for the dictation helper AND for startCall's own promise to have resolved (its `.then`
 *  is where callId gets set) — a click right after the first alone can race ahead of the second. */
async function ready(): Promise<void> {
  await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
  await vi.waitFor(() => expect(calls.some(([c]) => c === "startCall")).toBe(true));
  await new Promise((r) => setTimeout(r, 0)); // flush startCall's .then
}

describe("the hang-up tone", () => {
  it("plays once when a connected call is hung up", async () => {
    startCallResult = { callId: "c1", chatId: "a", anchorId: "a", participantIds: ["a"] };
    render(<VoiceOverlay botId="a" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(CallSounds.playHangUp).toHaveBeenCalledTimes(1);
  });

  it("never plays for a call that never connected (startCall failed)", async () => {
    startCallResult = "reject";
    render(<VoiceOverlay botId="a" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(CallSounds.playHangUp).not.toHaveBeenCalled();
  });

  it("stays silent when Settings → Voice, 'Call sounds' is off", async () => {
    startCallResult = { callId: "c1", chatId: "a", anchorId: "a", participantIds: ["a"] };
    soundsOn = false;
    render(<VoiceOverlay botId="a" />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(CallSounds.playHangUp).not.toHaveBeenCalled();
    soundsOn = true;
  });
});
