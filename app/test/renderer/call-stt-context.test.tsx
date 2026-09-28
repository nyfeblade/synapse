// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

// Bug 162: a call needs the recognizer biased towards the user's names at least as much as the
// composer does — the user says them out loud to the Bot. Before this, only the composer sent them.

const invoked: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  invoked.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { entryId: "t1u" } })),
    onEvent: () => () => {},
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: {} }; }),
      on: () => () => {},
    },
  };
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

const bot = (id: string, name: string) => [id, { id, profile: { name, avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} }] as const;
const msg = (id: string, content: string) => ({ kind: "message", id, role: "user", content, createdAt: 1 });

async function openCall(state: Partial<ReturnType<typeof initialState>>) {
  useUi.setState({ ...initialState(), ...state } as never);
  useVoice.getState().open("a");
  render(<VoiceOverlay botId="a" />);
  await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
  return invoked.find(([n]) => n === "dictation.start")![1];
}

describe("a call biases the recognizer with the session's names (bug 162)", () => {
  it("sends every Bot's name with the call", async () => {
    const args = await openCall({ bots: Object.fromEntries([bot("a", "Nova"), bot("b", "Disk Saver")]) as never });
    expect(args.mode).toBe("call");
    expect(args.context).toEqual(["Nova", "Disk Saver"]);
  });

  it("adds the vocabulary of the chat the call is in", async () => {
    const args = await openCall({
      bots: Object.fromEntries([bot("a", "Nova")]) as never,
      transcripts: { a: [msg("1", "restart OrbStack"), msg("2", "OrbStack again")] } as never,
    });
    expect(args.context).toEqual(["Nova", "OrbStack"]);
  });

  it("sends no context at all rather than an empty one", async () => {
    const args = await openCall({ bots: { a: { id: "a", profile: { avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} } } as never });
    expect(args).not.toHaveProperty("context");
  });
});
