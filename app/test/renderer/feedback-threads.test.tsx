// @vitest-environment jsdom
// Replies to feedback, renderer side: the quiet notice, the Your feedback screen, a reply, and the
// ways in (the notice, the Send feedback sheet and ⌘K). Replies are only ever from "Synapse".
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackHost } from "../../src/renderer/feedback/FeedbackSheet";
import { closeThreads, useThreads } from "../../src/renderer/feedback/FeedbackThreads";
import { closeFeedback, openFeedback } from "../../src/renderer/feedback/store";
import { typedRows } from "../../src/renderer/palette-rows";

const T = (msgs: { from: "you" | "synapse"; text: string }[], unread = 0) => ({ id: "abc123def456", sentAt: Date.parse("2026-09-29T10:00:00Z"), status: "open", messages: msgs.map((m) => ({ ...m, at: "2026-09-29T11:00:00.000Z" })), unread });
let threads = [T([{ from: "you", text: "The sidebar froze" }, { from: "synapse", text: "Thanks, fixed in 0.1.3." }], 1)];
let calls: { name: string; args: any }[] = [];
let listeners: Record<string, (p: unknown) => void> = {};
beforeEach(() => {
  calls = []; listeners = {};
  threads = [T([{ from: "you", text: "The sidebar froze" }, { from: "synapse", text: "Thanks, fixed in 0.1.3." }], 1)];
  useThreads.setState({ open: false, threads: null, unread: 0 });
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "feedback.threads.reply") threads = [T([...threads[0]!.messages, { from: "you", text: args.message }])];
        const result = name.startsWith("feedback.threads") ? { threads, unread: threads[0]!.unread } : name === "feedback.screenshot" ? { png: null } : name === "feedback.context" ? { appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2", logs: "" } : {};
        return { ok: true, result };
      }),
      on: (ch: string, cb: (p: unknown) => void) => { listeners[ch] = cb; return () => {}; },
    },
  };
});
afterEach(() => { act(() => { closeFeedback(); closeThreads(); }); cleanup(); document.body.innerHTML = ""; });

describe("Your feedback", () => {
  it("a new reply shows 'You have a reply to your feedback', and View opens the conversation", async () => {
    render(<FeedbackHost />);
    act(() => listeners["feedback-reply"]!({ unread: 1 }));
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe("You have a reply to your feedback · View");
    fireEvent.click(within(notice).getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Your feedback" });
    expect(await within(dialog).findByText("Thanks, fixed in 0.1.3.")).toBeTruthy();
    expect(within(dialog).getAllByText(/^Synapse/).length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(expect.arrayContaining(["feedback.threads.list", "feedback.threads.refresh", "feedback.threads.markSeen"])));
  });

  it("sends a reply through main by the thread's id", async () => {
    render(<FeedbackHost />);
    act(() => listeners["feedback-reply"]!({ unread: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Your feedback" });
    await within(dialog).findByText("Thanks, fixed in 0.1.3.");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply" }), { target: { value: "Works now, thanks" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText("Works now, thanks")).toBeTruthy();
    expect(calls.find((c) => c.name === "feedback.threads.reply")!.args).toEqual({ id: "abc123def456", message: "Works now, thanks" });
  });

  it("is reachable from the Send feedback sheet and from ⌘K", async () => {
    render(<FeedbackHost />);
    await act(async () => { await openFeedback(); });
    const sheet = await screen.findByRole("dialog", { name: "Send feedback" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Your feedback" }));
    expect(await screen.findByRole("dialog", { name: "Your feedback" })).toBeTruthy();
    const row = typedRows({ bots: {}, pinned: [], currentBotId: null, theme: "light", actions: {} as never }, "replies", []).find((r) => r.key === "feedback-threads");
    expect(row?.title).toBe("Your feedback");
  });

  it("Copy link asks main to copy by the thread's id, shows 'Copied' briefly, and never receives the code", async () => {
    render(<FeedbackHost />);
    act(() => listeners["feedback-reply"]!({ unread: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Your feedback" });
    await within(dialog).findByText("Thanks, fixed in 0.1.3.");
    expect(within(dialog).getByText("Open this link on any device to see replies.")).toBeTruthy();
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" })); });
      expect(within(dialog).getByRole("button", { name: "Copied" })).toBeTruthy();
      const call = calls.find((c) => c.name === "feedback.threads.link")!;
      expect(call.args).toEqual({ id: "abc123def456" });
      act(() => { vi.advanceTimersByTime(1600); });
      expect(within(dialog).getByRole("button", { name: "Copy link" })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
});
