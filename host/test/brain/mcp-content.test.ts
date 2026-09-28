import { describe, expect, it } from "vitest";
import { toMcpContent } from "../../brain/sdk-wiring";

describe("toMcpContent", () => {
  it("puts the text first and every image after it as an MCP image block", () => {
    expect(toMcpContent({ text: "shot", images: [{ data: "AAAA", mimeType: "image/webp" }] })).toEqual([
      { type: "text", text: "shot" },
      { type: "image", data: "AAAA", mimeType: "image/webp" },
    ]);
    expect(toMcpContent({ text: "plain" })).toEqual([{ type: "text", text: "plain" }]);
  });
});
