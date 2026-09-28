import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Headless execution: a hidden, minimized or fully covered window must cost nothing. Measured 2026-09-21 on the
 * packaged app: renderer, GPU and main at 0.0% CPU over 60 s while minimized, because Chromium stops producing
 * frames and throttles timers for a hidden page. That holds only while nothing turns the throttling off.
 */
const src = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

describe("headless: the app never keeps rendering in the background", () => {
  it("the window keeps Chromium's background throttling, and no switch disables renderer backgrounding", () => {
    const main = src("../../src/main/index.ts");
    expect(main).not.toMatch(/backgroundThrottling\s*:\s*false/);
    expect(main).not.toMatch(/setBackgroundThrottling\(\s*false/);
    expect(main).not.toMatch(/disable-renderer-backgrounding|disable-background-timer-throttling|disable-backgrounding-occluded-windows/);
    expect(main).not.toMatch(/powerSaveBlocker/);
  });

  it("the avatar loop and the VNC pool both stop on a hidden document", () => {
    expect(src("../../src/renderer/avatar/avatar-loop.ts")).toMatch(/visibilitychange/);
    expect(src("../../src/renderer/vnc/pool.ts")).toMatch(/visibilitychange[\s\S]*setVisible/);
  });
});
