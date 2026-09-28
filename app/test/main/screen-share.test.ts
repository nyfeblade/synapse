import { describe, expect, it, vi } from "vitest";
import { LOOK_LIMITS } from "@synapse/shared";
import { captureScreen, fitSize, imageTokens, SHARE_MAX_SIDE, type ScreenDeps, type ShareSource } from "../../src/main/native/screen-share";

const img = (w: number, h: number, empty = false) => ({ isEmpty: () => empty, getSize: () => ({ width: w, height: h }), toJPEG: vi.fn(() => Buffer.from("jpeg-bytes")) });
function deps(o: { status?: string; sources?: ShareSource[] } = {}): ScreenDeps & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    status: () => o.status ?? "granted",
    primary: () => ({ id: 7, size: { width: 1512, height: 982 }, scaleFactor: 2 }),
    sources: async (a) => { asked.push(a); return o.sources ?? [{ display_id: "3", thumbnail: img(10, 10) }, { display_id: "7", thumbnail: img(1600, 1039) }]; },
  };
}

describe("screen share: one still of the main display", () => {
  it("fits the Retina size into the cap, keeping the aspect", () => {
    expect(SHARE_MAX_SIDE).toBe(LOOK_LIMITS.maxEdge);
    expect(fitSize({ width: 1512, height: 982 }, 2)).toEqual({ width: 1280, height: 831 });
    expect(fitSize({ width: 800, height: 600 }, 1)).toEqual({ width: 800, height: 600 });
    expect(fitSize({ width: 1080, height: 1920 }, 1)).toEqual({ width: 720, height: 1280 });
  });

  it("image tokens a frame (w·h/750): 1280 px ≈ 1,419; the 1600 px it replaced ≈ 2,217", () => {
    expect(imageTokens(1280, 831)).toBe(1419);
    expect(imageTokens(1600, 1039)).toBe(2217);
  });

  it("takes the primary display at the capped size, as JPEG, and reports its token cost", async () => {
    const d = deps({ sources: [{ display_id: "3", thumbnail: img(10, 10) }, { display_id: "7", thumbnail: img(1280, 831) }] });
    const s = await captureScreen(d);
    expect(d.asked[0]).toEqual({ types: ["screen"], thumbnailSize: { width: 1280, height: 831 } });
    expect(s).toEqual({ jpegBase64: Buffer.from("jpeg-bytes").toString("base64"), width: 1280, height: 831, bytes: 10, tokens: 1419 });
  });

  it("permission denied or restricted fails before anything is captured, as a code", async () => {
    const d = deps({ status: "denied" });
    await expect(captureScreen(d)).rejects.toThrow("permission:screen:denied");
    await expect(captureScreen(deps({ status: "restricted" }))).rejects.toThrow("permission:screen:restricted");
    expect(d.asked).toEqual([]);
  });

  it("an empty image (macOS without permission) counts as denied, never as a blank still", async () => {
    await expect(captureScreen(deps({ status: "not-determined", sources: [{ display_id: "7", thumbnail: img(0, 0, true) }] }))).rejects.toThrow("permission:screen:denied");
    await expect(captureScreen(deps({ sources: [] }))).rejects.toThrow("permission:screen:denied");
  });
});
