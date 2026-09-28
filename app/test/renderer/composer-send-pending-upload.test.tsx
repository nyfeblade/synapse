// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "../../src/renderer/components/Composer";
import { useComposer } from "../../src/renderer/composer-store";
import { installFakeBridge } from "./fake-bridge";

// Task 37 (E2E finding): pressing Enter while an attachment is still uploading used to be dropped
// silently — the text stayed in the composer and nothing was sent. It now sends once uploads finish.
describe("Composer: Enter while an attachment uploads (CHAT-09)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({ sendPrompt: { accepted: true } });
    useComposer.setState({ byBot: {} });
    try { localStorage.clear(); } catch { /* storage unavailable */ }
  });
  afterEach(cleanup);

  const pending = { uploadId: "u1", name: "notes.md", size: 5, mime: "text/markdown", progress: 0, ref: null, error: null };
  const ref = { attachmentId: "abc.md", name: "notes.md", size: 5, mime: "text/markdown", storePath: "/s/abc.md", boxPath: "/workspace/uploads/notes.md" };

  it("queues the send and fires it once the upload completes", async () => {
    act(() => useComposer.getState().upsertAttachment("b", pending));
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "send back: uploads/notes.md" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(0);
    act(() => useComposer.getState().upsertAttachment("b", { ...pending, progress: 1, ref }));
    await waitFor(() => expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(1));
    const [, args] = bridge.calls.find(([c]) => c === "sendPrompt")!;
    expect(args).toMatchObject({ id: "b", text: "send back: uploads/notes.md", attachmentIds: ["abc.md"] });
    // The send is optimistic (the bloop): the composer clears the moment the queued send fires.
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("drops the queued send if the pending upload is removed and nothing else is left to send", async () => {
    act(() => useComposer.getState().upsertAttachment("b", pending));
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => useComposer.getState().removeAttachment("b", "u1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(0);
  });
});
