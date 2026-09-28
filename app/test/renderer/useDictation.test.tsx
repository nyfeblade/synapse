// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { useDictation } from "../../src/renderer/voice/useDictation";
import { PrivacySettingsButton } from "../../src/renderer/voice/PrivacySettingsButton";

const subs = new Map<string, (p: unknown) => void>();
const invoked: [string, unknown][] = [];
beforeEach(() => {
  subs.clear();
  invoked.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    native: {
      invoke: vi.fn(async (n: string, a: unknown) => {
        invoked.push([n, a]);
        return { ok: true, result: {} };
      }),
      on: (ch: string, cb: (p: unknown) => void) => {
        subs.set(ch, cb);
        return () => subs.delete(ch);
      },
    },
  };
});
afterEach(cleanup);

function Harness() {
  const d = useDictation(() => {});
  return (
    <>
      <button onClick={() => d.start()}>go</button>
      <span data-testid="listening">{String(d.listening)}</span>
      {d.error ? <span role="alert">{d.error}</span> : null}
      <span data-testid="pane">{String(d.privacyPane)}</span>
      {d.privacyPane ? <PrivacySettingsButton pane={d.privacyPane} /> : null}
    </>
  );
}

describe("useDictation permission faults (bug 99)", () => {
  it.each([
    ["permission:speech:denied", "speech", STR5.speechAccessDenied],
    ["permission:microphone:denied", "microphone", STR5.micAccessDenied],
  ] as const)("%s → message + the %s pane, button opens it", async (message, pane, text) => {
    render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(screen.getByTestId("listening").textContent).toBe("true"));
    act(() => subs.get("dictation")!({ type: "error", message }));
    expect(screen.getByRole("alert").textContent).toBe(text);
    expect(screen.getByTestId("pane").textContent).toBe(pane);
    fireEvent.click(screen.getByRole("button", { name: STR5.openPrivacySettings }));
    await vi.waitFor(() => expect(invoked.at(-1)).toEqual(["openPrivacySettings", { pane }]));
  });

  it("starting again clears the pane", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    act(() => subs.get("dictation")!({ type: "error", message: "permission:speech:denied" }));
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByTestId("pane").textContent).toBe("null");
  });
});

describe("useDictation unmount safety (CHAT-08 fix round 1 #2)", () => {
  it("stops the native helper on unmount when a session is still listening", async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    // Every session now carries an id (the "dictation" channel is shared with the voice overlay),
    // and the stop names the session it means to end.
    await vi.waitFor(() => expect(invoked[0]).toEqual(["dictation.start", { sessionId: expect.any(String) }]));
    const sessionId = (invoked[0]![1] as { sessionId: string }).sessionId;
    unmount();
    await vi.waitFor(() => expect(invoked.at(-1)).toEqual(["dictation.stop", { sessionId }]));
  });

  it("does not call stop on unmount when dictation was never started", () => {
    const { unmount } = render(<Harness />);
    unmount();
    expect(invoked).toEqual([]);
  });

  it("does not issue a redundant stop on unmount once the session already ended", async () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(invoked[0]).toEqual(["dictation.start", { sessionId: expect.any(String) }]));
    act(() => subs.get("dictation")!({ type: "end" }));
    unmount();
    expect(invoked).toHaveLength(1);
  });
});

describe("useDictation silence handling (voice mode bug)", () => {
  it("does not show 'No speech detected' as an error, it just stops listening", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(screen.getByTestId("listening").textContent).toBe("true"));
    act(() => subs.get("dictation")!({ type: "error", message: "No speech detected" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("listening").textContent).toBe("false");
  });

  it("still shows a real microphone error", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("go"));
    await vi.waitFor(() => expect(screen.getByTestId("listening").textContent).toBe("true"));
    act(() => subs.get("dictation")!({ type: "error", message: "not-authorized" }));
    expect(screen.getByRole("alert").textContent).toBe(STR5.micDenied);
    expect(screen.getByTestId("listening").textContent).toBe("false");
  });
});
