// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, STRL, type BotSummary, type TranscriptEntry } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { usePendingSends } from "../../src/renderer/pending-sends";
import { installFakeBridge } from "./fake-bridge";

/** Bug 198: a message sent while the Bot works shows "Queued", then "Delivered"; the composer and Stop stay live. */

const bot: BotSummary = {
  id: "b", updatedAt: 1, createdAt: 0, running: true, presence: "working", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, lastBotMessageAt: 0,
  profile: { name: "Piper", title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
} as BotSummary;
const msg = (id: string, content: string, steer?: "queued" | "delivered"): TranscriptEntry => ({ kind: "message", id, role: "user", content, createdAt: 1, ...(steer ? { steer } : {}) });
const show = (entries: TranscriptEntry[]) => {
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { b: bot }, transcripts: { b: entries } });
  return render(<Transcript botId="b" />);
};

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

describe("steering state on a user message (bug 198)", () => {
  it("labels a queued message, then a delivered one; an ordinary message has no label", () => {
    show([msg("t1u", "build the app"), msg("t2u", "also use the dark theme", "queued"), msg("t3u", "how long?", "delivered")]);
    expect(screen.getByText(STR.steerQueued)).toBeTruthy();
    expect(screen.getByText(STR.steerDelivered)).toBeTruthy();
    const labels = document.querySelectorAll(".msg-steer");
    expect(labels).toHaveLength(2);
    expect(labels[0]!.closest(".msg")?.textContent).toContain("also use the dark theme");
  });

  it("keeps the composer usable while the Bot is running: a message sends, and Stop comes back in Send's slot", async () => {
    const { calls } = installFakeBridge();
    try { localStorage.clear(); } catch { /* storage unavailable */ }
    useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { b: bot }, transcripts: { b: [] } });
    render(<Composer botId="b" name="Piper" running />);
    const input = screen.getByRole("textbox", { name: "Message Piper" }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "how long?" } });
    fireEvent.click(screen.getByRole("button", { name: STRL.send }));
    await waitFor(() => expect(calls.some(([cmd, a]) => cmd === "sendPrompt" && (a as { text: string }).text === "how long?")).toBe(true));
    expect(calls.some(([cmd]) => cmd === "interruptAgent")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: STR.stop }));
    await waitFor(() => expect(calls.some(([cmd]) => cmd === "interruptAgent")).toBe(true));
  });
});

// UI polish pass (brief 2): the empty chat is the Bot's face and name — and never while loading.
describe("the empty chat and the loading mutex", () => {
  beforeEach(() => usePendingSends.setState({ byBot: {} }));
  it("shows the Bot's name once the transcript has loaded empty", () => {
    installFakeBridge();
    // An idle Bot: a working one shows its typing dots instead, and the two never stack.
    useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { b: { ...bot, running: false, presence: "idle" } }, transcripts: { b: [] } });
    const { container } = render(<Transcript botId="b" />);
    expect(container.querySelector(".empty-chat .empty-view-title")?.textContent).toBe("Piper");
  });
  it("shows nothing while the transcript has not loaded", () => {
    installFakeBridge();
    useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { b: bot }, transcripts: {} });
    const { container } = render(<Transcript botId="b" />);
    expect(container.querySelector(".empty-chat")).toBeNull();
  });
});
