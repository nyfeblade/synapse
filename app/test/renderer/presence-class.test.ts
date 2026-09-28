// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_BEAT_MS, presenceBeat, usePresenceClass } from "../../src/renderer/presence-class";
// Annotated rather than `as const`: these hooks are re-rendered with a DIFFERENT presence,
// so narrowing initialProps to the literal makes the rerender a type error.
import type { Presence } from "@synapse/shared";

describe("presenceBeat (motion-spec §4.4)", () => {
  it("acks idle → any active and settles any active → idle", () => {
    expect(presenceBeat("idle", "thinking")).toBe("ack");
    expect(presenceBeat("idle", "working")).toBe("ack");
    expect(presenceBeat("searching", "idle")).toBe("settle");
    expect(presenceBeat("orbit", "idle")).toBe("settle");
  });

  it("is silent on first paint, same-state, and active-to-active", () => {
    expect(presenceBeat(undefined, "idle")).toBeNull();
    expect(presenceBeat("thinking", "thinking")).toBeNull();
    expect(presenceBeat("thinking", "working")).toBeNull();
  });
});

describe("usePresenceClass one-shots", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("adds presence-ack for 340ms on idle → working, then drops it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ p }) => usePresenceClass("a", p), { initialProps: { p: "idle" as Presence } });
    expect(result.current).toBe("presence-idle");
    rerender({ p: "working" });
    expect(result.current).toBe("presence-working presence-ack");
    act(() => { vi.advanceTimersByTime(PRESENCE_BEAT_MS); });
    expect(result.current).toBe("presence-working");
  });

  it("does not fire a beat when the Bot id changes under the same instance", () => {
    const { result, rerender } = renderHook(({ id, p }) => usePresenceClass(id, p), { initialProps: { id: "a", p: "idle" as Presence } });
    rerender({ id: "b", p: "working" });
    expect(result.current).toBe("presence-working");
  });
});
