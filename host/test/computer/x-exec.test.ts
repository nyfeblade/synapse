import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../computer/x-exec";
import { XRunner } from "../../computer/x-exec";

// A minimal valid WEBP payload for screenshotWebp()'s magic-byte check
// (bytes 8-11 must read "WEBP"; the rest is irrelevant to this test).
const WEBP_STUB = Buffer.concat([Buffer.alloc(8), Buffer.from("WEBP")]);

function fakeExec(calls: Array<{ file: string; args: string[]; env?: Record<string, string> }>): Exec {
  return async (file, args, o): Promise<ExecResult> => {
    calls.push({ file, args, env: o?.env });
    return { code: 0, stdout: WEBP_STUB, stderr: "" };
  };
}

describe("XRunner.screenshotWebp — cross-user MIT-SHM (phase3-spike-findings.md finding 5 / S3-06)", () => {
  it("import capture disables ImageMagick's X11 shared-memory pixmap path, the equivalent of x11vnc's -noshm", async () => {
    const calls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
    const x = new XRunner(fakeExec(calls), { display: ":9", xauthority: "/run/bot-x/9.xauth" }, "import");

    const webp = await x.screenshotWebp();

    expect(webp.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe("sh");
    const script = call.args.join(" ");
    // The spike's finding 5 (S3-06 write-up): a bothost-owned process reading
    // box's X display pixels via MIT-SHM hits cross-user BadAccess; x11vnc's
    // fix was -noshm. ImageMagick's equivalent is -shared-memory False.
    expect(script).toMatch(/\bimport\b[^|]*-shared-memory\s+False\b/);
  });

  it("leaves the default ffmpeg capture path unaffected (the spike's finding explicitly excludes it)", async () => {
    const calls: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
    const x = new XRunner(fakeExec(calls), { display: ":9", xauthority: "/run/bot-x/9.xauth" }, "ffmpeg");

    await x.screenshotWebp();

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("ffmpeg");
    expect(calls[0].args.join(" ")).not.toMatch(/shared-memory/);
  });
});
