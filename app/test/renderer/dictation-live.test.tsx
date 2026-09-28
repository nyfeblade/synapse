// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";

/**
 * Bug 101: dictation is "just dictation" — press, talk, the words appear live IN the composer,
 * it stops on a second press or on silence, and the text stays there unsent. And it never stops
 * without saying why.
 */
const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, Record<string, unknown>][] = [];
const calls: string[] = [];
beforeEach(() => {
  subs.clear(); invoked.length = 0; calls.length = 0;
  localStorage.clear(); // the composer restores its per-Bot draft
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string) => { calls.push(cmd); return { ok: true, result: { servers: [] } }; }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: Record<string, unknown>) => { invoked.push([n, a]); return { ok: true, result: {} }; }), on: (ch: string, cb: (p: unknown) => void) => { subs.set(ch, cb); return () => subs.delete(ch); } },
  };
});
afterEach(cleanup);
const box = () => screen.getByRole("textbox", { name: "Message Planner" }) as HTMLTextAreaElement;
const fire = (e: Record<string, unknown>) => act(() => subs.get("dictation")!({ sessionId: invoked.find(([n]) => n === "dictation.start")![1].sessionId, ...e }));

describe("composer dictation is live (bug 101)", () => {
  it("partials appear in the composer as you speak, after what was already typed; the final stays and is not sent", async () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.change(box(), { target: { value: "Note:" } });
    fireEvent.click(screen.getByRole("button", { name: STR5.startVoiceInput }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fire({ type: "partial", text: "check my" });
    expect(box().value).toBe("Note: check my");
    fire({ type: "partial", text: "check my calendar" });
    expect(box().value).toBe("Note: check my calendar");
    fire({ type: "final", text: "Check my calendar." });
    fire({ type: "end" });
    expect(box().value).toBe("Note: Check my calendar.");
    expect(screen.getByRole("button", { name: STR5.startVoiceInput })).toBeTruthy();
    expect(calls).not.toContain("sendPrompt");
  });

  it("stopping with only a partial keeps those words", async () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.startVoiceInput }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fire({ type: "partial", text: "remind me" });
    fire({ type: "end" });
    expect(box().value).toBe("remind me");
  });

  it("nobody spoke: says so (a status, not an alarm)", async () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.startVoiceInput }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fire({ type: "error", code: "no-speech", message: "No speech detected" });
    fire({ type: "end" });
    expect(screen.getByRole("status").textContent).toBe(STR5.dictationNoSpeech);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dead microphone shows the helper's reason", async () => {
    render(<Composer botId="b" name="Planner" running={false} />);
    fireEvent.click(screen.getByRole("button", { name: STR5.startVoiceInput }));
    await vi.waitFor(() => expect(invoked.some(([n]) => n === "dictation.start")).toBe(true));
    fire({ type: "error", code: "no-audio", message: "The microphone isn't sending any sound (no-audio, restarted 4 times)." });
    expect(screen.getByRole("alert").textContent).toContain("microphone isn't sending any sound");
  });
});
