import { describe, expect, it } from "vitest";
import { colourBlobs, colourName, colourWords, ocrLines, rankLines } from "../../../computer/perception/vision";

/** A w×h rgb24 buffer, white, with filled rectangles. */
function canvas(w: number, h: number, rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[]): Buffer {
  const b = Buffer.alloc(w * h * 3, 255);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) b.set(r.rgb, (y * w + x) * 3);
  return b;
}

describe("local vision", () => {
  it("names colours by hue, with white/black/gray by lightness and saturation", () => {
    expect(colourName(220, 30, 30)).toBe("red");
    expect(colourName(30, 160, 60)).toBe("green");
    expect(colourName(40, 90, 220)).toBe("blue");
    expect(colourName(240, 200, 40)).toBe("yellow");
    expect(colourName(245, 130, 20)).toBe("orange");
    expect(colourName(140, 50, 200)).toBe("purple");
    expect(colourName(250, 250, 250)).toBe("white");
    expect(colourName(10, 10, 10)).toBe("black");
    expect(colourName(128, 128, 128)).toBe("gray");
  });

  it("finds colour words in a query", () => {
    expect(colourWords("click the red button")).toEqual(["red"]);
    expect(colourWords("where is the green or blue square?")).toEqual(["green", "blue"]);
    expect(colourWords("what does the chart say")).toEqual([]);
    expect(colourWords("the grey box")).toEqual(["gray"]);
  });

  it("finds blobs of a colour in a cropped region, offset to screen coordinates, biggest first", () => {
    const buf = canvas(200, 100, [
      { x: 10, y: 10, w: 20, h: 20, rgb: [220, 20, 20] },
      { x: 100, y: 40, w: 60, h: 40, rgb: [210, 30, 40] },
      { x: 60, y: 60, w: 20, h: 20, rgb: [30, 60, 220] },
    ]);
    const blobs = colourBlobs(buf, { x: 300, y: 200, w: 200, h: 100 }, "red", { minArea: 16 });
    expect(blobs).toHaveLength(2);
    expect(blobs[0]).toMatchObject({ colour: "red", b: { x: 400, y: 240, w: 60, h: 40 } });
    expect(blobs[1]).toMatchObject({ b: { x: 310, y: 210, w: 20, h: 20 } });
    expect(colourBlobs(buf, { x: 0, y: 0, w: 200, h: 100 }, "green", { minArea: 16 })).toEqual([]);
  });

  it("ignores specks below the minimum area", () => {
    const buf = canvas(50, 50, [{ x: 5, y: 5, w: 2, h: 2, rgb: [220, 20, 20] }]);
    expect(colourBlobs(buf, { x: 0, y: 0, w: 50, h: 50 }, "red", { minArea: 16 })).toEqual([]);
  });

  it("cleans OCR output and ranks the lines that share words with the query first", () => {
    const lines = ocrLines("  Revenue 2026  \n\n\f Q1 12.4M\nQ2 15.1M\n  \nTotal 27.5M\n");
    expect(lines).toEqual(["Revenue 2026", "Q1 12.4M", "Q2 15.1M", "Total 27.5M"]);
    expect(rankLines(lines, "what is the total")).toEqual(["Total 27.5M", "Revenue 2026", "Q1 12.4M", "Q2 15.1M"]);
  });
});
