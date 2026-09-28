import { describe, expect, it } from "vitest";
import { execBuf, XRunner } from "../../computer/x-exec";
import { SudoDisplayControl } from "../../computer/display-control";

describe.runIf(process.env.RUN_BOX === "1")("real display :13 (box)", () => {
  it("starts through the helper, moves the pointer, captures WebP, stops", async () => {
    const c = new SudoDisplayControl(execBuf);
    expect(await c.start(13, "boxtest-token")).toBe("ok");
    const x = new XRunner(execBuf, { display: ":13", xauthority: "/run/bot-x/13.xauth" });
    await x.xdotool(["mousemove", "--sync", "200", "150"]);
    expect(await x.cursor()).toEqual({ x: 200, y: 150 });
    const webp = await x.screenshotWebp();
    expect(webp.subarray(8, 12).toString("ascii")).toBe("WEBP");
    await c.stop(13);
    expect(await c.status(13)).toBe("stopped");
  }, 60_000);
});
