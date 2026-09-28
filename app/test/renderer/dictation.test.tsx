// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/renderer/components/Composer";

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, unknown][] = [];
beforeEach(() => {
  subs.clear();
  invoked.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: { servers: [] } })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { invoked.push([n, a]); return { ok: true, result: {} }; }), on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); } },
  };
});
afterEach(cleanup);

describe("composer dictation (CHAT-08)", () => {
  it("mic starts dictation, inserts the final text, and stops on the second click", async () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    // The dictation channel is shared with the voice overlay, so each session carries an id.
    await vi.waitFor(() => expect(invoked[0]).toEqual(["dictation.start", { sessionId: expect.any(String) }]));
    const sessionId = (invoked[0]![1] as { sessionId: string }).sessionId;
    act(() => subs.get("dictation")!({ type: "partial", text: "check my" }));
    // Bug 101: the partial is shown IN the composer (it used to be a separate label beside it).
    expect((screen.getByRole("textbox", { name: "Message Planner" }) as HTMLTextAreaElement).value).toBe("check my");
    act(() => subs.get("dictation")!({ type: "final", text: "check my calendar" }));
    expect((screen.getByRole("textbox", { name: "Message Planner" }) as HTMLTextAreaElement).value).toBe("check my calendar");
    fireEvent.click(screen.getByRole("button", { name: "Stop voice input" }));
    await vi.waitFor(() => expect(invoked.at(-1)).toEqual(["dictation.stop", { sessionId }]));
  });

  it("shows the permission message on a helper error", () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
    act(() => subs.get("dictation")!({ type: "error", message: "not-authorized" }));
    expect(screen.getByRole("alert").textContent).toContain("Privacy & Security");
  });
});
