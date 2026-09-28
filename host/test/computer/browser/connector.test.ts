import { describe, expect, it } from "vitest";
import { PlaywrightConnector } from "../../../computer/browser/connector";

const refused = () => Object.assign(new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9235"), {});

/** T29 box finding: right after `bot-display start`, the screen's Chromium hasn't opened its CDP port yet. */
describe("PlaywrightConnector waits for a just-started Chromium (T29)", () => {
  it("retries a refused CDP connection until the port answers", async () => {
    let n = 0;
    const c = new PlaywrightConnector(async () => { n += 1; if (n < 3) throw refused(); throw new Error("reached"); }, { retryMs: 5_000, stepMs: 1 });
    await expect(c.connect(9235)).rejects.toThrow("reached");
    expect(n).toBe(3);
  });

  it("doesn't retry other errors, and gives up after the retry window", async () => {
    let n = 0;
    const other = new PlaywrightConnector(async () => { n += 1; throw new Error("protocol error"); }, { retryMs: 5_000, stepMs: 1 });
    await expect(other.connect(9235)).rejects.toThrow("protocol error");
    expect(n).toBe(1);
    const never = new PlaywrightConnector(async () => { throw refused(); }, { retryMs: 30, stepMs: 5 });
    await expect(never.connect(9235)).rejects.toThrow(/ECONNREFUSED/);
  });
});
