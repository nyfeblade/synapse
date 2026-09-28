// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { STR5 } from "@synapse/shared";
import { App } from "../../src/renderer/App";
import { ChatView } from "../../src/renderer/components/ChatView";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { VoiceLoop } from "../../src/renderer/voice/voice-loop";
import { CallHost, useVoice } from "../../src/renderer/voice/VoiceOverlay";
import { installFakeBridge } from "./fake-bridge";

// ---------------------------------------------------------------------------
// UI audit, highest-severity finding: the voice overlay covered the whole chat
// pane (904x900 of a 1440x900 window) with no Escape handler, no close control
// and no sign that it was covering anything. 69 clicks on the header, the
// transcript and the composer went into it and did nothing — "a lot of the
// buttons do random things".
//
// What a role="dialog" owes the user: Escape closes it, a visible close control
// closes it, focus moves into it and comes back to the opener, focus cannot
// reach the controls it covers, and closing ends the voice session so the
// microphone does not stay live behind a dismissed dialog.
// ---------------------------------------------------------------------------

const bot = (over: Partial<BotSummary> = {}): BotSummary => ({
  id: "a", updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name: "Courier", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

const invoked: [string, Record<string, unknown>][] = [];

function installVoiceBridge() {
  invoked.length = 0;
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  // Canned so a render of <App /> settles on the chat view (an empty listAgents sends it to New chat).
  return installFakeBridge({
    listAgents: { agents: [bot()], activeAgentId: "a" },
    openAgent: { agent: bot() },
    getAgentTranscriptTail: { entries: [] },
  });
}

/** The real opener: Composer's round dark button. Focused first, because a jsdom click does not focus. */
function openVoice(): HTMLElement {
  const opener = screen.getByRole("button", { name: STR5.startVoiceChat });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

beforeEach(() => {
  installVoiceBridge();
  // The fake bridge's native stub is shared; give this suite its own recorder.
  (window as unknown as { synapse: { native: unknown } }).synapse.native = {
    invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a ?? {}]); return { ok: true, result: {} }; }),
    on: () => () => {},
  };
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, view: { kind: "chat", botId: "a" }, bots: { a: bot() }, transcripts: { a: [] } } as never);
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); });

describe("voice overlay — Escape and the global overlay path", () => {
  it("closes on Escape from the app's global handler, like every other overlay", async () => {
    render(<App />);
    const opener = await screen.findByRole("button", { name: STR5.startVoiceChat });
    opener.focus();
    fireEvent.click(opener);
    expect(useVoice.getState().openFor).toBe("a");
    expect(screen.getByRole("dialog", { name: STR5.startVoiceChat })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useVoice.getState().openFor).toBeNull();
    expect(screen.queryByRole("dialog", { name: STR5.startVoiceChat })).toBeNull();
  });

  it("returns focus to the control that opened it when Escape closes it", async () => {
    render(<App />);
    const opener = await screen.findByRole("button", { name: STR5.startVoiceChat });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: STR5.startVoiceChat });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true)); // focus went in…
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener)); // …and came back
  });
});

describe("voice overlay — close affordance, focus and modality", () => {
  it("moves focus into the dialog when it opens", async () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    const dialog = screen.getByRole("dialog", { name: STR5.startVoiceChat });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("has a visible close control, like the app's other dialogs, and it closes the overlay", async () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    const opener = openVoice();
    const close = screen.getByRole("button", { name: "Close voice chat" });
    fireEvent.click(close);
    expect(useVoice.getState().openFor).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("still ends the session from the End voice chat button", () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    fireEvent.click(screen.getByRole("button", { name: STR5.endVoiceChat }));
    expect(useVoice.getState().openFor).toBeNull();
  });

  it("reads as modal and a click on the covering surface dismisses it instead of vanishing", () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    expect(screen.getByRole("dialog", { name: STR5.startVoiceChat }).getAttribute("aria-modal")).toBe("true");
    const scrim = document.querySelector(".voice-scrim");
    expect(scrim, "the overlay must present a scrim that reads as covering the app").not.toBeNull();
    fireEvent.mouseDown(scrim!);
    expect(useVoice.getState().openFor).toBeNull();
  });

  it("keeps Tab inside the dialog: focus never reaches the controls it covers", () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    const dialog = screen.getByRole("dialog", { name: STR5.startVoiceChat });
    const covered = [screen.getByRole("button", { name: "View conversation details" }), screen.getByRole("textbox")];
    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(document.activeElement ?? window, { key: "Tab" });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(covered).not.toContain(document.activeElement);
    }
    fireEvent.keyDown(document.activeElement ?? window, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("pulls focus back in if a covered control takes it while the dialog is open", () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    const dialog = screen.getByRole("dialog", { name: STR5.startVoiceChat });
    const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
    composer.focus();
    fireEvent.keyDown(composer, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("voice overlay — closing ends the voice session", () => {
  it("stops the dictation session it started, so the microphone is not left live", async () => {
    render(<><ChatView botId="a" /><CallHost /></>);
    openVoice();
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.start")).toHaveLength(1));
    const sessionId = invoked.find(([n]) => n === "dictation.start")![1].sessionId;
    fireEvent.click(screen.getByRole("button", { name: "Close voice chat" }));
    await vi.waitFor(() => expect(invoked.filter(([n]) => n === "dictation.stop")).toHaveLength(1));
    expect(invoked.find(([n]) => n === "dictation.stop")![1].sessionId).toBe(sessionId);
  });
});

// The loop keeps a helper listening while the Bot speaks, for barge-in. end() only stopped the
// helper when the loop happened to be in "listening", so ending voice mode mid-reply left that
// barge-in helper running: the dialog was gone and the microphone was still on.
describe("VoiceLoop.end() leaves no helper behind", () => {
  it("stops the helper even when the loop is speaking (barge-in listener)", async () => {
    const log: string[] = [];
    let finishSpeech: () => void = () => {};
    const loop = new VoiceLoop({
      start: () => log.push("start"), stop: () => log.push("stop"), send: (t) => log.push(`send:${t}`),
      speak: (t) => { log.push(`speak:${t}`); return new Promise<void>((r) => { finishSpeech = r; }); },
      cancelSpeech: () => { log.push("cancel"); finishSpeech(); }, now: () => 0, silenceMs: 1200,
    });
    loop.begin();
    loop.onBotText("Two meetings today.");
    await vi.waitFor(() => expect(loop.state).toBe("speaking"));
    expect(log.filter((x) => x === "start")).toHaveLength(2); // listening + the barge-in helper
    loop.end();
    expect(loop.state).toBe("idle");
    expect(log, "end() must stop the helper it left listening for barge-in").toContain("stop");
  });
});
