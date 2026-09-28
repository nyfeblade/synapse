// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITSC } from "@synapse/shared";
import { ScreenPool } from "../../src/renderer/vnc/pool";
import type { RfbLike } from "../../src/renderer/vnc/rfb";

class FakeRfb implements RfbLike {
  viewOnly = true; scaleViewport = false; resizeSession = true; showDotCursor = true; focusOnClick = true; background = "";
  disconnected = false;
  private l = new Map<string, (e: CustomEvent) => void>();
  disconnect() { this.disconnected = true; }
  focus() {}
  sendKey() {}
  clipboardPasteFrom() {}
  addEventListener(t: string, cb: (e: CustomEvent) => void) { this.l.set(t, cb); }
  removeEventListener(t: string) { this.l.delete(t); }
  fire(t: string) { this.l.get(t)?.(new CustomEvent(t)); }
}

describe("ScreenPool (CMP-07)", () => {
  let made: FakeRfb[];
  let t: number;
  const pool = (max = 3) => new ScreenPool({ max, url: (b) => (b === "none" ? null : `ws://x/vnc/${b}`), make: () => { const r = new FakeRfb(); made.push(r); return r; }, now: () => t });
  beforeEach(() => { made = []; t = 0; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("creates view-only, scaled connections and keeps at most 3 warm (LRU)", () => {
    const p = pool();
    for (const b of ["a", "b", "c"]) p.acquire(b);
    expect(made[0]).toMatchObject({ viewOnly: true, scaleViewport: true, resizeSession: false, showDotCursor: false });
    p.acquire("a"); // a becomes most recent
    p.acquire("d"); // evicts b
    expect(made[1]!.disconnected).toBe(true);
    expect(made[0]!.disconnected).toBe(false);
  });

  it("reports connected, reconnects after a drop, and gives up after 3 crashes in 60 s", () => {
    const p = pool();
    const seen: string[] = [];
    p.acquire("a");
    p.subscribe("a", (s) => seen.push(s));
    made[0]!.fire("connect");
    made[0]!.fire("disconnect");
    vi.advanceTimersByTime(1000);
    expect(made).toHaveLength(2);
    made[1]!.fire("disconnect");
    vi.advanceTimersByTime(1000);
    made[2]!.fire("disconnect");
    expect(p.status("a")).toBe("failed");
    expect(seen).toContain("connected");
  });

  it("fails after 15 s without a connection, and is unavailable without a proxy URL", () => {
    const p = pool();
    p.acquire("a");
    vi.advanceTimersByTime(15_000);
    expect(p.status("a")).toBe("failed");
    expect(p.acquire("none").status).toBe("unavailable");
  });

  it("headless: closes every preview while the window is hidden and redials the shown ones when it comes back", () => {
    const p = pool();
    p.acquire("a"); p.acquire("b");
    made[0]!.fire("connect"); made[1]!.fire("connect");
    p.release("b"); // b is warm but not on screen
    p.setVisible(false);
    expect(made.map((r) => r.disconnected)).toEqual([true, true]);
    vi.advanceTimersByTime(60_000);
    expect(made, "no reconnect while hidden").toHaveLength(2);
    p.setVisible(true);
    expect(made, "only the preview on screen redials").toHaveLength(3);
    expect(p.status("a")).toBe("connecting");
    expect(p.status("b")).toBe("unavailable");
  });

  it("headless: a drop while hidden does not schedule a reconnect", () => {
    const p = pool();
    p.acquire("a");
    made[0]!.fire("connect");
    made[0]!.fire("disconnect");
    p.setVisible(false);
    vi.advanceTimersByTime(5_000);
    expect(made).toHaveLength(1);
  });

  it("a preview nobody shows is closed after the warm grace (so the Bot's idle screen can be reclaimed)", () => {
    const p = pool();
    p.acquire("a");
    made[0]!.fire("connect");
    p.release("a");
    vi.advanceTimersByTime(LIMITSC.previewWarmIdleMs - 1);
    expect(made[0]!.disconnected).toBe(false);
    p.acquire("a"); // shown again inside the grace: the same warm connection
    p.release("a");
    vi.advanceTimersByTime(LIMITSC.previewWarmIdleMs);
    expect(made[0]!.disconnected).toBe(true);
    expect(p.status("a")).toBe("unavailable");
    expect(made).toHaveLength(1);
  });
});

