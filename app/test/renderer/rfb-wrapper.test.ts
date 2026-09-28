// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// Task 30 fuzz (high): noVNC logs "Tried changing state of a disconnected RFB object" when disconnect() is called on
// an RFB that already disconnected (the pool's drop/timeout and the view's cleanup all call it). The wrapper makes it idempotent.
const calls: string[] = [];
vi.mock("@novnc/novnc", () => ({
  default: class {
    private l = new Map<string, ((e: unknown) => void)[]>();
    addEventListener(t: string, cb: (e: unknown) => void) { this.l.set(t, [...(this.l.get(t) ?? []), cb]); }
    removeEventListener() {}
    disconnect() { calls.push("disconnect"); for (const cb of this.l.get("disconnect") ?? []) cb({ detail: { clean: true } }); }
    fire(t: string) { for (const cb of this.l.get(t) ?? []) cb({ detail: { clean: false } }); }
  },
}));

describe("createRfb", () => {
  it("disconnect() reaches noVNC once, and never after noVNC reported the disconnect itself", async () => {
    const { createRfb } = await import("../../src/renderer/vnc/rfb");
    const a = createRfb(document.createElement("div"), "ws://127.0.0.1:1/vnc/x");
    a.disconnect();
    a.disconnect();
    expect(calls).toEqual(["disconnect"]);
    const b = createRfb(document.createElement("div"), "ws://127.0.0.1:1/vnc/y");
    (b as unknown as { fire(t: string): void }).fire("disconnect"); // the server closed the connection
    b.disconnect();
    expect(calls).toEqual(["disconnect"]);
  });
});
