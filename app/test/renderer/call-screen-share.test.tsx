// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5, STRV } from "@synapse/shared";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useVoice, VoiceOverlay } from "../../src/renderer/voice/VoiceOverlay";
import { shareFault, stillName, wantsLook } from "../../src/renderer/voice/screen-share";

// Screen share on a call, token-cautious: sharing only ALLOWS a still. One goes with a turn whose words
// ask the Bot to look, or when the Bot asks (SSE call-look), once per user turn; a tick says it went.

const subs = new Map<string, (p: unknown) => void>();
const sse: ((e: { channel: string; payload: unknown }) => void)[] = [];
const invoked: [string, Record<string, unknown>][] = [];
const calls: [string, Record<string, unknown>][] = [];
let capture: () => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
const JPEG = btoa("\xff\xd8\xff" + "x".repeat(40));

beforeEach(() => {
  subs.clear(); sse.length = 0; invoked.length = 0; calls.length = 0;
  capture = () => ({ ok: true, result: { jpegBase64: JPEG, width: 1280, height: 831, bytes: 43, tokens: 1419 } });
  (window as unknown as { speechSynthesis: unknown }).speechSynthesis = { getVoices: () => [], speak: vi.fn(), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
      calls.push([cmd, a]);
      if (cmd === "uploadAttachment") return { ok: true, result: { received: a.size, attachment: a.final ? { attachmentId: `att-${calls.length}`, name: a.name, size: a.size, mime: a.mime, storePath: "/x", boxPath: null } : null } };
      return { ok: true, result: { entryId: "t1u" } };
    }),
    onEvent: (fn: (e: { channel: string; payload: unknown }) => void) => { sse.push(fn); return () => { const i = sse.indexOf(fn); if (i >= 0) sse.splice(i, 1); }; },
    onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: {
      invoke: vi.fn(async (n: string, a: Record<string, unknown>) => {
        invoked.push([n, a]);
        if (n === "screen.capture") return capture();
        return { ok: true, result: n === "dictation.speak" ? { spoken: true } : {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); },
    },
  };
  useUi.setState({ ...initialState(), bots: { a: { id: "a", profile: { name: "Nova", avatarShape: "pebble", avatarColor: "#3b82f6" }, settings: {} } } } as never);
});
afterEach(() => { act(() => useVoice.getState().close()); cleanup(); vi.useRealTimers(); });

const sid = () => invoked.find(([n]) => n === "dictation.start")![1].sessionId;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: sid(), ...e }));
const botAsks = (botId = "a") => act(() => { for (const fn of [...sse]) fn({ channel: "call-look", payload: { botId } }); });
const prompts = () => calls.filter(([c]) => c === "sendPrompt").map(([, a]) => a);
const captures = () => invoked.filter(([n]) => n === "screen.capture").length;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function openCall(share = false) {
  useVoice.getState().open("a");
  render(<VoiceOverlay botId="a" />);
  await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
  if (share) fireEvent.click(screen.getByRole("button", { name: STRV.shareScreen }));
}
async function say(text: string, n: number) {
  fire({ type: "final", text });
  await vi.waitFor(() => expect(prompts()).toHaveLength(n));
}

describe("screen share on a call: token-cautious", () => {
  it("is off at the start of a call", async () => {
    await openCall();
    expect(screen.getByRole("button", { name: STRV.shareScreen }).getAttribute("aria-pressed")).toBe("false");
    await say("can you see this", 1);
    expect(captures()).toBe(0);
    expect(prompts()[0]!.attachmentIds).toBeUndefined();
  });

  it("while sharing, a turn that doesn't ask to look sends words only — no capture at all", async () => {
    await openCall(true);
    expect(screen.getByTestId("call-sharing").textContent).toBe(STRV.sharingScreen("Nova"));
    await say("what's the plan for tomorrow", 1);
    await say("okay sounds good", 2);
    expect(captures()).toBe(0);
    expect(prompts().every((p) => p.attachmentIds === undefined)).toBe(true);
    expect(screen.queryByTestId("call-snap")).toBeNull();
  });

  it("a turn that asks to look carries exactly one still, and the call screen ticks “Sent a snapshot”", async () => {
    await openCall(true);
    await say("can you see this error", 1);
    expect(captures()).toBe(1);
    expect(prompts()[0]).toMatchObject({ text: "can you see this error", attachmentIds: [expect.stringMatching(/^att-/)] });
    const up = calls.find(([c]) => c === "uploadAttachment")![1];
    expect(up).toMatchObject({ id: "a", mime: "image/jpeg", final: true });
    expect(String(up.name)).toMatch(/^Shared screen \d\d\.\d\d\.\d\d\.jpg$/);
    expect((await screen.findByTestId("call-snap")).textContent).toContain(STRV.snapshotSent);
  });

  it("the Bot asking (call-look) sends one still as its own message, once per user turn", async () => {
    await openCall(true);
    botAsks();
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toMatchObject({ text: STRV.snapshotForBot, attachmentIds: [expect.stringMatching(/^att-/)], voice: { call: true } });
    expect(await screen.findByTestId("call-snap")).toBeTruthy();
    botAsks(); // again in the same user turn: ignored
    await flush();
    expect(captures()).toBe(1);
    await say("okay", 2); // a new user turn: words only, and the Bot may ask once more
    expect(captures()).toBe(1);
    botAsks();
    await vi.waitFor(() => expect(prompts()).toHaveLength(3));
    expect(captures()).toBe(2);
  });

  it("another Bot's ask is not this call's", async () => {
    await openCall(true);
    botAsks("zz");
    await flush();
    expect(captures()).toBe(0);
  });

  it("the Bot asking while the user isn't sharing asks the user; turning Share on sends that one still", async () => {
    await openCall(false);
    botAsks();
    await flush();
    expect(captures()).toBe(0);
    expect(screen.getByTestId("call-look-ask").textContent).toBe(STRV.botWantsToLook("Nova"));
    fireEvent.click(screen.getByRole("button", { name: STRV.shareScreen }));
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toMatchObject({ text: STRV.snapshotForBot });
    expect(captures()).toBe(1);
    expect(screen.queryByTestId("call-look-ask")).toBeNull();
  });

  it("permission off: the words still go, sharing stops, and the plain reason opens Screen Recording", async () => {
    capture = () => ({ ok: false, error: { code: "native", message: "permission:screen:denied" } });
    await openCall(true);
    await say("look at this", 1);
    expect(prompts()[0]!.attachmentIds).toBeUndefined();
    expect(await screen.findByText(STRV.screenAccessDenied)).toBeTruthy();
    expect(screen.queryByText(/permission:screen/)).toBeNull();
    expect(screen.queryByTestId("call-snap")).toBeNull();
    expect(screen.getByRole("button", { name: STRV.shareScreen }).getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: STR5.openPrivacySettings })); });
    expect(invoked).toContainEqual(["openPrivacySettings", { pane: "screen" }]);
  });

  it("a group call offers it too (bug 126): a turn that asks to look carries one still to the room", async () => {
    useUi.setState({ bots: { ...useUi.getState().bots, b: { id: "b", profile: { name: "Ledger", avatarShape: "pebble", avatarColor: "#222222" }, settings: {} }, g: { id: "g", profile: { name: "Team", avatarShape: "pebble", avatarColor: "#111111" }, settings: {}, group: { memberIds: ["a", "b"] } } } } as never);
    useVoice.getState().open("g");
    render(<VoiceOverlay botId="g" />);
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: STRV.shareScreen }));
    expect(screen.getByTestId("call-sharing").textContent).toBe(STRV.sharingScreenRoom);
    await say("Nova, can you see this error", 1);
    expect(captures()).toBe(1);
    expect(prompts()[0]).toMatchObject({ id: "g", attachmentIds: [expect.stringMatching(/^att-/)], voice: { call: true } });
    expect(calls.find(([c]) => c === "uploadAttachment")![1]).toMatchObject({ id: "g" });
  });

  it("hanging up stops sharing: the next call starts with it off", async () => {
    await openCall(true);
    act(() => useVoice.getState().close());
    act(() => useVoice.getState().open("a"));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: STRV.shareScreen }).getAttribute("aria-pressed")).toBe("false"));
    expect(screen.queryByTestId("call-sharing")).toBeNull();
  });
});

describe("wantsLook: the user asking the Bot to look, matched cheaply", () => {
  const yes = [
    "look at this", "can you look at my screen", "take a look", "Look, it's broken again", "see this?", "can you see it",
    "do you see the button", "what's on my screen", "what is on the screen right now", "check this out", "read this for me",
    "see what I'm doing", "what am I looking at", "check my screen", "see the error", "grab a screenshot", "I'm looking at the dashboard",
    "can you read the error", "Can you see that",
  ];
  const no = [
    "", "what's the plan for tomorrow", "okay sounds good", "I look forward to it", "look it up for me", "look up the weather",
    "see you tomorrow", "let's see", "I'll see this through", "check the weather", "read the news headlines", "looks good to me",
    "send the email", "watch this week's numbers", "I need to look for my keys",
  ];
  it.each(yes)("asks to look: %s", (t) => expect(wantsLook(t)).toBe(true));
  it.each(no)("doesn't ask to look: %s", (t) => expect(wantsLook(t)).toBe(false));
});

describe("screen share helpers", () => {
  it("maps capture failures to plain words; only a denial offers the pane, and only permission stops sharing", () => {
    expect(shareFault("permission:screen:denied")).toEqual({ fault: STRV.screenAccessDenied, pane: "screen", stop: true });
    expect(shareFault("permission:screen:restricted")).toEqual({ fault: STRV.screenAccessRestricted, pane: null, stop: true });
    expect(shareFault("desktopCapturer failed")).toEqual({ fault: STRV.screenShareFailed, pane: null, stop: false });
  });
  it("names the still by the time it was taken", () => {
    expect(stillName(new Date(2026, 8, 22, 9, 5, 7))).toBe("Shared screen 09.05.07.jpg");
  });
});
