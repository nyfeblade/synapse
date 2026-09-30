/**
 * 0.1.4 first-run: the host follows the Mac's time zone. The app sends it at connect and whenever it changes (window
 * focus, and a once-a-minute check), never the same zone twice, and reads it from /etc/localtime, which macOS updates
 * the moment the zone changes (a running process's Intl keeps the zone it started with).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { macTimeZone } from "../../src/main/mac-time-zone";
import { startTimeZoneSync } from "../../src/renderer/time-zone-sync";

afterEach(() => vi.useRealTimers());

describe("the Mac's time zone reaches the host", () => {
  it("sends at start, then only when the zone changes (focus or the minute check)", async () => {
    vi.useFakeTimers();
    let zone = "America/New_York";
    const sent: string[] = [];
    const listeners = new Map<string, () => void>();
    const win = { addEventListener: (n: string, f: () => void) => void listeners.set(n, f), removeEventListener: (n: string) => void listeners.delete(n) };
    const stop = startTimeZoneSync({ read: async () => zone, send: async (z) => void sent.push(z), everyMs: 60_000, win: win as never });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["America/New_York"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(["America/New_York"]); // unchanged: nothing sent
    zone = "America/Los_Angeles";
    listeners.get("focus")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["America/New_York", "America/Los_Angeles"]);
    zone = "Europe/London";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.at(-1)).toBe("Europe/London");
    stop();
    expect(listeners.size).toBe(0);
    zone = "Asia/Tokyo";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent.at(-1)).toBe("Europe/London");
  });

  it("a failed send is tried again on the next check", async () => {
    vi.useFakeTimers();
    let fail = true;
    const sent: string[] = [];
    const stop = startTimeZoneSync({ read: async () => "Asia/Kolkata", send: async (z) => { if (fail) throw new Error("not connected"); sent.push(z); }, everyMs: 1_000, win: { addEventListener: () => {}, removeEventListener: () => {} } as never });
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["Asia/Kolkata"]);
    stop();
  });

  it("reads the zone from /etc/localtime's link, falling back to Intl", () => {
    expect(macTimeZone(() => "/var/db/timezone/zoneinfo/America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(macTimeZone(() => "/usr/share/zoneinfo/Europe/Berlin")).toBe("Europe/Berlin");
    const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(macTimeZone(() => { throw new Error("EINVAL"); })).toBe(fallback);
    expect(macTimeZone(() => "/var/db/timezone/zoneinfo/Not/AZone")).toBe(fallback);
  });
});
