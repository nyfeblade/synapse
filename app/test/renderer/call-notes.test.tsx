// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRV } from "@synapse/shared";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

// Bug 134: a voicemail plays in the chat (items 11); a call's summary shows its action items (item 4).

const invoked: [string, Record<string, unknown>][] = [];
let finishPlay: () => void = () => {};
const VM = "Hi, it's Nova. I tried to call you about this: the deploy failed. It's in the chat too, so reply whenever you can.";

beforeEach(() => {
  invoked.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn((n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "voicemail.play") return new Promise((r) => { finishPlay = () => r({ ok: true, result: { ok: true, engine: "kokoro" } }); });
        return Promise.resolve({ ok: true, result: {} });
      }),
      on: () => () => {},
    },
  };
  useUi.setState({ ...initialState(), bots: { n: { id: "n", profile: { name: "Nova", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: { voice: "kokoro:af_bella", speechRate: 1.25 } } }, transcripts: { n: [
    { kind: "notice", id: "x1", createdAt: 1, text: "Missed call from Nova: the deploy failed", voicemail: { text: VM } },
    { kind: "notice", id: "x2", createdAt: 2, text: "Call summary · 3m 12s", callSummary: { summary: "Alex and Nova planned the week.", actions: ["Nova: book Thursday's dentist", "You: send the invoice"], durationMs: 192_000 } },
  ] } } as never);
});
afterEach(cleanup);

describe("voicemail in the chat", () => {
  it("the missed call, a play button and the transcript; play renders it in the Bot's voice on this Mac; pressing again stops", async () => {
    render(<Transcript botId="n" />);
    const vm = screen.getByTestId("voicemail");
    expect(vm.textContent).toContain("Missed call from Nova: the deploy failed");
    expect(vm.textContent).toContain(VM);
    fireEvent.click(within(vm).getByRole("button", { name: STRV.playVoicemail }));
    expect(invoked).toContainEqual(["voicemail.play", { id: "x1", text: VM, voice: "kokoro:af_bella", rate: 1.25 }]);
    fireEvent.click(within(vm).getByRole("button", { name: STRV.pauseVoicemail }));
    expect(invoked.some(([n]) => n === "voicemail.stop")).toBe(true);
    await act(async () => { finishPlay(); });
    expect(within(vm).getByRole("button", { name: STRV.playVoicemail })).toBeTruthy();
  });
});

describe("a call's summary", () => {
  it("title, summary and the action items", () => {
    render(<Transcript botId="n" />);
    const card = screen.getByTestId("call-summary");
    expect(card.textContent).toContain("Call summary · 3m 12s");
    expect(card.textContent).toContain("Alex and Nova planned the week.");
    expect(within(card).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Nova: book Thursday's dentist", "You: send the invoice"]);
    expect(card.textContent).toContain(STRV.actionItems);
  });
});
