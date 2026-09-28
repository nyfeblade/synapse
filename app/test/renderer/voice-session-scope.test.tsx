// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useDictation } from "../../src/renderer/voice/useDictation";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";

// ---------------------------------------------------------------------------
// The main process exposes ONE global "dictation" channel. The composer mic
// (useDictation) and the voice overlay both subscribe to it, so without a
// per-session identity one consumer receives the other's transcripts: say
// something to the overlay and the words land in the composer, or vice versa.
// ---------------------------------------------------------------------------

const subs = new Set<(p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const finals: string[] = [];

function MicHarness() {
  const d = useDictation((t) => void finals.push(t));
  return (
    <>
      <button onClick={() => d.start()}>go</button>
      <button onClick={() => d.stop()}>halt</button>
      <span data-testid="mic-listening">{String(d.listening)}</span>
      <span data-testid="mic-partial">{d.partial}</span>
      <span data-testid="mic-error">{d.error ?? ""}</span>
    </>
  );
}

const emit = (e: Record<string, unknown>) => act(() => { for (const cb of [...subs]) cb(e); });
const startsOf = (name: string) => invoked.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  subs.clear();
  invoked.length = 0;
  finals.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: {} }; }),
      on: (_ch: string, cb: (p: unknown) => void) => { subs.add(cb); return () => subs.delete(cb); },
    },
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Planner", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice: null, speechRate: 1, spokenLanguage: null } } } as never });
  useVoice.getState().open("a");
});
afterEach(() => { useVoice.getState().close(); cleanup(); });

describe("dictation session scoping (composer mic vs voice overlay)", () => {
  it("gives every start its own session id and sends it to the main process", async () => {
    render(<><MicHarness /><VoiceOverlay botId="a" /></>);
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(1));
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(2));
    const ids = startsOf("dictation.start").map((a) => a.sessionId);
    expect(ids.every((id) => typeof id === "string" && (id as string).length > 0)).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    // Stopping is scoped too: a consumer must never stop a session it does not own, so the
    // stop carries the id of the session it means to end.
    fireEvent.click(screen.getByText("halt"));
    await vi.waitFor(() => expect(startsOf("dictation.stop")).toHaveLength(1));
    expect(startsOf("dictation.stop")[0]!.sessionId).toBe(ids[1]);
  });

  it("does not deliver the composer mic's transcripts to the voice overlay", async () => {
    render(<><MicHarness /><VoiceOverlay botId="a" /></>);
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(1));
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(2));
    const micId = startsOf("dictation.start")[1]!.sessionId;

    emit({ type: "partial", text: "add milk to", sessionId: micId });
    emit({ type: "final", text: "add milk to the list", sessionId: micId });
    expect(screen.getByTestId("mic-partial").textContent).toBe("");
    expect(finals).toEqual(["add milk to the list"]);
    // The overlay must not have treated the composer's words as a voice-mode utterance.
    expect((window.synapse.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "sendPrompt")).toEqual([]);

    // A microphone failure in the composer's session is the composer's to show.
    emit({ type: "error", message: "not-authorized", sessionId: micId });
    expect(screen.getByTestId("mic-error").textContent).toBe(STR5.micDenied);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not deliver the voice overlay's transcripts to the composer mic", async () => {
    render(<><MicHarness /><VoiceOverlay botId="a" /></>);
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(1));
    const overlayId = startsOf("dictation.start")[0]!.sessionId;
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(2));

    emit({ type: "partial", text: "what's on my", sessionId: overlayId });
    emit({ type: "final", text: "what's on my calendar", sessionId: overlayId });
    expect(screen.getByTestId("mic-partial").textContent).toBe("");
    expect(finals).toEqual([]);
    await vi.waitFor(() => expect((window.synapse.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "sendPrompt").map((c) => (c[1] as { text: string }).text)).toEqual(["what's on my calendar"]));

    // ... and the overlay's own session failure is the overlay's to show.
    emit({ type: "error", message: "not-authorized", sessionId: overlayId });
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STR5.micDenied));
    expect(screen.getByTestId("mic-error").textContent).toBe("");
  });

  it("ignores a superseded session's own late events", async () => {
    render(<><MicHarness /><VoiceOverlay botId="a" /></>);
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(1));
    const first = startsOf("dictation.start")[0]!.sessionId;
    // The helper exits on silence; the loop starts a new session with a new id.
    emit({ type: "error", message: "No speech detected", sessionId: first });
    emit({ type: "end", sessionId: first });
    await vi.waitFor(() => expect(startsOf("dictation.start")).toHaveLength(2));
    expect(startsOf("dictation.start")[1]!.sessionId).not.toBe(first);

    // A late line from the dead session must not be heard by the live one.
    emit({ type: "final", text: "ghost utterance", sessionId: first });
    expect((window.synapse.call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "sendPrompt")).toEqual([]);
  });
});
